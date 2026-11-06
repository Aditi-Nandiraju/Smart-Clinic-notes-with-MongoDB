// Seed the database with synthetic users, patients, notes and follow-ups.
//
//   node scripts/seed.js [--patients 500] [--seed 7] [--review 18] [--keep]
//
// Historical notes are stored as verified: the extractor runs on each note and a
// simulated doctor review corrects it to the generator's ground truth, which
// also produces real correction statistics. The most recent notes are left in
// the review queue. All data is fictional.

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDb } from '../src/db.js';
import { User, Patient, Encounter, Followup, NoteChunk, GroundTruth, AssistantLog } from '../src/models/index.js';
import { extractNote } from '../src/nlp/extractor.js';
import { embed, embeddingModelName, initEmbedder, chunkNote } from '../src/nlp/embedder.js';
import { compareExtractions, triageStats } from '../src/services/corrections.js';
import { trainNer } from '../src/nlp/ml/nerService.js';
import { Vocabulary } from '../src/models/index.js';
import { markOverdue } from '../src/services/followups.js';
import { encrypt } from '../src/services/fieldCrypto.js';
import { rng, generatePatients, scheduleVisits, writeVisit } from './synth/generator.js';
import { mergeWithTruth } from './synth/review.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const N_PATIENTS = Number(args.patients ?? 500);
const SEED = Number(args.seed ?? 7);
const REVIEW_QUEUE = Number(args.review ?? 18);

async function main() {
  const t0 = Date.now();
  await connectDb();
  await initEmbedder();
  console.log(`[seed] embedding model: ${embeddingModelName()}`);
  if (!args.keep) {
    await Promise.all([User, Patient, Encounter, Followup, NoteChunk, GroundTruth, AssistantLog, Vocabulary].map((m) => m.deleteMany({})));
    await mongoose.connection.db.collection('audit_logs').drop().catch(() => {});
    await mongoose.connection.db.createCollection('audit_logs', { timeseries: { timeField: 'at', metaField: 'meta', granularity: 'seconds' } }).catch(() => {});
  }

  const hash = await bcrypt.hash('demo1234', 10);
  const users = await User.insertMany([
    { name: 'Dr. Asha Mehra', email: 'doctor@clinic.test', role: 'doctor', passwordHash: hash },
    { name: 'Dr. Vikram Rao', email: 'doctor2@clinic.test', role: 'doctor', passwordHash: hash },
    { name: 'Neha (Front desk)', email: 'staff@clinic.test', role: 'staff', passwordHash: hash },
    { name: 'Clinic Admin', email: 'admin@clinic.test', role: 'admin', passwordHash: hash },
  ]);
  const doctors = users.filter((u) => u.role === 'doctor');

  const r = rng(SEED);
  const today = new Date();
  const start = new Date(today.getTime() - 240 * 864e5);
  const people = generatePatients(r, N_PATIENTS, today);
  const patientDocs = await Patient.insertMany(people.map((p, i) => ({
    patientCode: `P${String(10001 + i)}`,
    name: p.name,
    nameLower: p.name.toLowerCase(),
    dob: p.dob,
    sex: p.sex,
    phoneEnc: encrypt(p.phone),
    allergies: p.allergies,
    chronicConditions: p.chronic.map((code) => ({ code })),
    synthetic: true,
  })));
  people.forEach((p, i) => { p._id = patientDocs[i]._id; });

  const visits = scheduleVisits(r, people, start, today);
  console.log(`[seed] ${people.length} patients, ${visits.length} visits`);

  const encDocs = []; const truths = []; const followups = [];
  const reviewCutoff = visits.length - REVIEW_QUEUE;
  visits.forEach((v, idx) => {
    const { text, gt } = writeVisit(r, v.p, v.date, v.kind);
    const model = extractNote(text, { visitDate: v.date });
    const _id = new mongoose.Types.ObjectId();
    const inQueue = idx >= reviewCutoff;
    const verified = inQueue ? null : mergeWithTruth(model, gt);
    encDocs.push({
      _id,
      patientId: v.p._id,
      doctorId: r.pick(doctors)._id,
      visitDate: v.date,
      rawNote: text,
      status: inQueue ? 'needs_review' : 'verified',
      extraction: inQueue ? model : verified,
      modelExtraction: model,
      corrections: inQueue ? null : compareExtractions(model, verified),
      // simulated review time: flagged items take longer to check than auto-accepted ones
      review: inQueue ? undefined : { simulated: true, seconds: Math.round(20 + 9 * model.meta.toCheck + 2 * (model.meta.items - model.meta.toCheck) + r.int(0, 25)), ...triageStats(model, verified) },
      extractorVersion: model.meta.extractorVersion,
      verifiedBy: inQueue ? undefined : doctors[0]._id,
      verifiedAt: inQueue ? undefined : new Date(v.date.getTime() + 15 * 60e3),
      createdAt: v.date,
      updatedAt: v.date,
    });
    truths.push({ encounterId: _id, truth: gt, kind: v.kind });
    if (!inQueue && verified.followUp?.dueDate) {
      followups.push({ patientId: v.p._id, sourceEncounterId: _id, sourceVisitDate: v.date, dueDate: new Date(`${verified.followUp.dueDate}T00:00:00Z`), reason: verified.followUp.purpose ?? null, status: 'due', createdAt: v.date });
    }
  });

  // a later visit by the same patient completes their earlier open follow-ups
  const byPatient = new Map();
  for (const e of encDocs) {
    if (e.status !== 'verified') continue;
    if (!byPatient.has(String(e.patientId))) byPatient.set(String(e.patientId), []);
    byPatient.get(String(e.patientId)).push(e);
  }
  for (const f of followups) {
    const later = (byPatient.get(String(f.patientId)) ?? []).find((e) => e.visitDate > f.sourceVisitDate);
    if (later) { f.status = 'completed'; f.closedByEncounterId = later._id; f.closedAt = later.visitDate; }
  }

  for (let i = 0; i < encDocs.length; i += 500) await Encounter.insertMany(encDocs.slice(i, i + 500), { ordered: false });
  await GroundTruth.insertMany(truths);
  await Followup.insertMany(followups);
  const overdue = await markOverdue(today);

  // search index for verified notes
  const verified = encDocs.filter((e) => e.status === 'verified');
  const chunkDocs = [];
  for (let i = 0; i < verified.length; i += 64) {
    const batch = verified.slice(i, i + 64);
    const texts = []; const owners = [];
    for (const e of batch) chunkNote(e.rawNote).forEach((t, ci) => { texts.push(t); owners.push([e, ci]); });
    const vectors = await embed(texts);
    texts.forEach((t, k) => {
      const [e, ci] = owners[k];
      chunkDocs.push({ encounterId: e._id, patientId: e.patientId, visitDate: e.visitDate, chunkIndex: ci, text: t, embedding: vectors[k], embeddingModel: embeddingModelName(), diagnosisCodes: (e.extraction.diagnoses ?? []).filter((d) => d.certainty !== 'ruled_out').map((d) => d.code) });
    });
  }
  for (let i = 0; i < chunkDocs.length; i += 1000) await NoteChunk.insertMany(chunkDocs.slice(i, i + 1000));

  // train the local sequence tagger on the verified notes (rules + doctor corrections)
  const ner = trainNer(verified, { epochs: 8, log: (m) => console.log(`[seed] ner: ${m}`) });
  console.log(`[seed] NER held-out span F1 ${(ner.heldOut.f1 * 100).toFixed(1)}% on ${ner.heldOut.notes} notes (${ner.trainNotes} training notes)`);

  const counts = {
    patients: patientDocs.length,
    encounters: encDocs.length,
    verified: verified.length,
    reviewQueue: encDocs.length - verified.length,
    followups: followups.length,
    overdue,
    completed: followups.filter((f) => f.status === 'completed').length,
    chunks: chunkDocs.length,
  };
  console.log('[seed] done in', ((Date.now() - t0) / 1000).toFixed(1), 's', counts);
  console.log('[seed] sign in with doctor@clinic.test / staff@clinic.test / admin@clinic.test, password demo1234');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
