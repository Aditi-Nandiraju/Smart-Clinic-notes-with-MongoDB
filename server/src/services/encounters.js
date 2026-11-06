// Encounter lifecycle: pending -> (extraction) -> needs_review -> (doctor) -> verified.
import mongoose from 'mongoose';
import { Encounter, Followup } from '../models/index.js';
import { EXTRACTOR_VERSION } from '../nlp/extractor.js';
import { indexEncounter } from './search.js';
import { compareExtractions, triageStats } from './corrections.js';
import { runExtraction } from './extraction.js';
import { learnFromVerification } from './vocabulary.js';
import { trainNer, nerStatus } from '../nlp/ml/nerService.js';
import { config } from '../config.js';

/** Run the local NLP extractor on a pending encounter. */
export async function processEncounter(id) {
  const enc = await Encounter.findById(id);
  if (!enc || enc.status !== 'pending') return null;
  try {
    // Only the note text goes to the extractor: no patient name, phone or ID.
    const extraction = await runExtraction(enc.rawNote, { visitDate: enc.visitDate });
    enc.extraction = extraction;
    enc.modelExtraction = extraction;
    enc.extractorVersion = EXTRACTOR_VERSION;
    enc.status = 'needs_review';
    enc.processingError = undefined;
  } catch (err) {
    enc.processingError = err.message;
    enc.status = 'needs_review';
    enc.extraction = { symptoms: [], diagnoses: [], medications: [], allergies: [], vitals: [], labs: [], followUp: null, meta: { warnings: [`Extraction failed: ${err.message}`] } };
  }
  await enc.save();
  return enc;
}

/** Clean up an edited extraction coming from the review screen. */
export function sanitiseExtraction(x, rawNote) {
  const inNote = (span) => Array.isArray(span) && span.length === 2 && span[0] >= 0 && span[1] <= rawNote.length && span[0] < span[1];
  const keepSpan = (o) => ({ ...o, span: inNote(o.span) ? o.span : null, ...(o.nameSpan !== undefined ? { nameSpan: inNote(o.nameSpan) ? o.nameSpan : null } : {}), learn: !!o.learn });
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    symptoms: (x.symptoms ?? []).filter((s) => s.term).map((s) => keepSpan({ ...s, term: String(s.term).trim().toLowerCase(), negated: !!s.negated, durationDays: num(s.durationDays) })),
    diagnoses: (x.diagnoses ?? []).filter((d) => d.term && d.code).map((d) => keepSpan({ ...d, term: String(d.term).trim(), code: String(d.code).trim().toUpperCase(), certainty: ['confirmed', 'provisional', 'ruled_out'].includes(d.certainty) ? d.certainty : 'confirmed', context: d.context ?? 'current' })),
    medications: (x.medications ?? []).filter((m) => m.generic).map((m) => keepSpan({ ...m, generic: String(m.generic).trim().toLowerCase(), dose: num(m.dose), durationDays: num(m.durationDays), action: m.action ?? 'prescribe', negated: !!m.negated })),
    allergies: (x.allergies ?? []).filter((a) => a.substance).map(keepSpan),
    nkda: !!x.nkda,
    vitals: (x.vitals ?? []).map(keepSpan),
    labs: (x.labs ?? []).filter((l) => l.test).map((l) => keepSpan({ ...l, value: typeof l.value === 'string' && !Number.isNaN(Number(l.value)) && l.value.trim() !== '' ? Number(l.value) : l.value })),
    followUp: x.followUp && (x.followUp.dueDate || x.followUp.asNeeded) ? {
      dueDate: x.followUp.dueDate ? String(x.followUp.dueDate).slice(0, 10) : null,
      inDays: num(x.followUp.inDays),
      asNeeded: !!x.followUp.asNeeded,
      purpose: x.followUp.purpose ?? null,
      span: inNote(x.followUp.span) ? x.followUp.span : null,
    } : null,
    ignoredMentions: (x.unmapped ?? []).map((u) => ({ type: u.type, surface: u.surface, span: u.span })),
    meta: x.meta ?? null,
  };
}

// retrain the ML tagger in the background after enough new verified notes
let verifiedSinceTraining = 0;
let training = false;
export async function maybeRetrainNer(force = false) {
  if (training) return null;
  if (!force && (!config.nerRetrainEvery || verifiedSinceTraining < config.nerRetrainEvery) && nerStatus().available) return null;
  training = true;
  try {
    const encs = await Encounter.find({ status: 'verified' }).select('rawNote extraction').lean();
    const meta = trainNer(encs);
    verifiedSinceTraining = 0;
    console.log(`[ner] retrained on ${meta.trainNotes} notes; held-out span F1 ${(meta.heldOut.f1 * 100).toFixed(1)}%`);
    return meta;
  } catch (e) {
    console.warn('[ner] training skipped:', e.message);
    return null;
  } finally {
    training = false;
  }
}

/**
 * Verify an encounter in one transaction:
 *  1. save the doctor-confirmed extraction and mark it verified
 *  2. close the patient's open follow-ups that this visit fulfils
 *  3. create the follow-up this note asks for
 *  4. rebuild the note's search chunks
 */
export async function verifyEncounter(id, extraction, user, { reviewSeconds = null } = {}) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const enc = await Encounter.findById(id).session(session);
      if (!enc) throw Object.assign(new Error('Encounter not found'), { status: 404 });
      if (enc.status === 'verified') throw Object.assign(new Error('Encounter is already verified'), { status: 409 });
      const clean = sanitiseExtraction(extraction ?? enc.extraction ?? {}, enc.rawNote);
      enc.extraction = clean;
      enc.corrections = enc.modelExtraction ? compareExtractions(enc.modelExtraction, clean) : null;
      enc.review = {
        seconds: Number.isFinite(Number(reviewSeconds)) && reviewSeconds > 0 ? Math.min(Number(reviewSeconds), 3600) : null,
        ...(enc.modelExtraction ? triageStats(enc.modelExtraction, clean) : {}),
      };
      enc.status = 'verified';
      enc.verifiedBy = user._id;
      enc.verifiedAt = new Date();
      await enc.save({ session });

      const closed = await Followup.updateMany(
        { patientId: enc.patientId, status: { $in: ['due', 'overdue'] }, sourceEncounterId: { $ne: enc._id }, sourceVisitDate: { $lt: enc.visitDate } },
        { $set: { status: 'completed', closedByEncounterId: enc._id, closedAt: new Date() } },
        { session },
      );
      let created = null;
      if (clean.followUp?.dueDate) {
        created = await Followup.findOneAndUpdate(
          { sourceEncounterId: enc._id },
          { $set: { patientId: enc.patientId, sourceVisitDate: enc.visitDate, dueDate: new Date(`${clean.followUp.dueDate}T00:00:00Z`), reason: clean.followUp.purpose ?? null, status: 'due' } },
          { upsert: true, new: true, session },
        );
      }
      await indexEncounter(enc, session);
      result = { encounter: enc, closedFollowups: closed.modifiedCount, followup: created };
    });
  } finally {
    await session.endSession();
  }
  // outside the transaction: teach the vocabulary, count towards retraining
  result.learned = await learnFromVerification(result.encounter, result.encounter.extraction, user).catch((e) => { console.warn('[vocab]', e.message); return []; });
  verifiedSinceTraining++;
  maybeRetrainNer().catch(() => {});
  return result;
}
