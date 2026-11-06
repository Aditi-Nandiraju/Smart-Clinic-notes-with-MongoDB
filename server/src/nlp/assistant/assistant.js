// Clinic assistant: answers staff questions with local models only.
//   question -> slot filling -> intent classifier -> route
//     structured intents -> query builder -> validator -> read-only aggregation
//     note_search        -> hybrid semantic search over verified notes
//     patient_summary    -> extractive summary of the patient's verified records
//     clinical_advice / unsafe_action -> declined
// Every number or name in an answer comes from the database; the text around
// it is a fixed template, so the assistant cannot invent facts.

import mongoose from 'mongoose';
import { IntentClassifier } from './classifier.js';
import { INTENTS, INTENT_LABELS } from './intents.js';
import { extractSlots } from './slots.js';
import { buildQuery, pipelineToString, ACTIVE_MED_ACTIONS } from './queryBuilder.js';
import { validatePipeline, UnsafeQueryError } from './validator.js';
import { searchNotes } from '../../services/search.js';
import { Patient, Encounter, Followup, AssistantLog } from '../../models/index.js';
import { getReadConnection } from '../../db.js';
import { llmEnabled } from '../llm/ollama.js';
import { llmParseQuestion, llmSummariseResults } from '../llm/llmAssistant.js';

export const CONFIDENCE_THRESHOLD = 0.35;
const LONG_TERM_CLASSES = /biguanide|sulfonylurea|DPP-4|SGLT2|insulin|calcium channel|ARB|ACE inhibitor|beta blocker|diuretic|statin|antiplatelet|thyroid hormone|inhaled|leukotriene|SSRI|gabapentinoid/i;
const TRAINING_NAMES = ['Ravi Kumar', 'Priya Sharma', 'Anil Mehta', 'Sunita Reddy', 'Mohammed Khan', 'Lakshmi Iyer', 'Arjun Nair', 'Rahul Verma', 'Kavya Rao', 'Deepak Joshi']
  .map((name, i) => ({ _id: new mongoose.Types.ObjectId(), name, i }));

const UNSAFE_RE = /\b(?:delete|drop|remove|erase|truncate|insert|update|modify|overwrite|wipe|destroy)\b.*\b(?:patients?|records?|notes?|encounters?|collections?|database|logs?|data|everyone|all)\b|\b(?:phone numbers?|passwords?|credentials?|contact details|addresses)\b/i;
const ADVICE_RE = /\b(?:what|which)\s+(?:dose|drug|medicine|medication|antibiotic|treatment)s?\s+(?:should|to|would|is best|is right|can)\b|\bshould\s+i\b|\b(?:recommend|suggest|advise)\b.*\b(?:drug|medicine|medication|dose|treatment|antibiotic)s?\b|\bbest\s+(?:drug|medicine|antibiotic|treatment)\b|\b(?:what|which) (?:\w+ )?is (?:the )?(?:best|right|treatment)\b|\btreatment (?:for|of)\b|\bdiagnose (?:this|the|my)\b|\bcan i give\b|\bhow (?:much|should) .* (?:give|prescribe|dose)\b/i;

// Things consultation notes never record: answer "not recorded" instead of guessing.
const NOT_RECORDED_RE = /\b(?:blood (?:group|type)|ward|bed(?:\s*(?:no\.?|number)?\s*\d+)?|beds|admitted|insurance|insured|billing|bills?|fees?|payments?|paid|salar(?:y|ies)|staff|on call|on duty|roster|stock|inventory|weather|rain(?:ing)?|opening hours|clinic (?:open|close)s?|(?:open|close)s? on (?:mon|tue|wed|thu|fri|sat|sun)\w*)\b|\bleft in (?:the )?pharmacy\b|\bshow (?:me )?(?:the )?(?:\w+ )?(?:x-?ray|mri|ct scan|scan|images?)\b/i;

const NOTE_SEARCH_RE = /^\s*(?:search|find|look for|look up)\b.*\bnotes?\b|\bnotes?\s+(?:about|mentioning|where|that mention|describing)\b/i;

let classifier = null;
let trainingInfo = null;

export function trainAssistant() {
  const t0 = Date.now();
  const examples = [];
  for (const [label, texts] of Object.entries(INTENTS)) {
    for (const text of texts) examples.push({ text: extractSlots(text, { patients: TRAINING_NAMES }).masked, label });
  }
  classifier = new IntentClassifier().train(examples);
  trainingInfo = { examples: examples.length, intents: Object.keys(INTENTS).length, ms: Date.now() - t0, vocabulary: classifier.vocab.size };
  return trainingInfo;
}

export function getClassifier() {
  if (!classifier) trainAssistant();
  return classifier;
}

export function assistantInfo() {
  return { model: 'TF-IDF + softmax logistic regression', ...trainingInfo, threshold: CONFIDENCE_THRESHOLD, intents: INTENT_LABELS };
}

// --- patient name cache for slot filling ----------------------------------
let nameCache = { at: 0, list: [] };
async function patientNames() {
  if (Date.now() - nameCache.at > 60_000) nameCache = { at: Date.now(), list: await Patient.find().select('name').lean() };
  return nameCache.list;
}
export function invalidatePatientNames() { nameCache.at = 0; }

/** Classify + fill slots + apply safety rules. Pure, no database access except names. */
export function understand(question, { patients = [], now = new Date() } = {}) {
  const { slots, masked } = extractSlots(question, { patients, now });
  const pred = getClassifier().predict(masked);
  let { intent } = pred;
  let reason = 'classifier';
  if (UNSAFE_RE.test(question)) { intent = 'unsafe_action'; reason = 'safety rule'; }
  else if (ADVICE_RE.test(question)) { intent = 'clinical_advice'; reason = 'safety rule'; }
  else if (NOTE_SEARCH_RE.test(question)) { intent = 'note_search'; reason = 'search wording'; }
  else if (NOT_RECORDED_RE.test(question)) { intent = 'unanswerable'; reason = 'not recorded in notes'; }
  else if (intent === 'visit_stats' && (slots.diagnoses.length || slots.symptoms.length)) {
    intent = slots.diagnoses.length ? 'patients_with_diagnosis' : 'patients_with_symptom'; reason = 'classifier + slots';
  } else if (intent === 'patient_summary' && !slots.patient) {
    // a name the classifier expected but could not find in the patient list
    intent = 'needs_patient';
    reason = 'no matching patient';
  } else if (slots.patient && pred.confidence < 0.6 && !['overdue_followups', 'upcoming_followups'].includes(intent)) {
    intent = 'patient_summary'; reason = 'patient named';
  } else if (pred.confidence < CONFIDENCE_THRESHOLD) {
    intent = 'note_search'; reason = 'low confidence: falling back to note search';
  }
  return { intent, reason, confidence: Number(pred.confidence.toFixed(3)), ranked: pred.ranked.map((r) => ({ intent: r.label, p: Number(r.p.toFixed(3)) })), slots, masked };
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

function phrase(intent, built, rows, slots) {
  const n = rows.length;
  if (built.sumField) {
    const total = rows.reduce((s, r) => s + (r[built.sumField] ?? 0), 0);
    return `${built.title}: ${total} in total.`;
  }
  if (intent === 'top_diagnoses' || intent === 'top_medications') {
    if (!n) return `${built.title}: no verified records in this period.`;
    const top = rows.slice(0, 3).map((r) => `${r.diagnosis ?? r.drug} (${r.visits ?? r.prescriptions})`).join(', ');
    return `${built.title}: the most frequent are ${top}.`;
  }
  const unique = new Set(rows.map((r) => String(r.patientId))).size;
  if (!n) return `${built.title}: none found in verified records.`;
  if (slots.wantsCount) return `${built.title}: ${unique} patient${unique === 1 ? '' : 's'}.`;
  return `${built.title}: ${unique} patient${unique === 1 ? '' : 's'} found${n >= 200 ? ' (showing the first 200)' : ''}.`;
}

async function runStructured(intent, u, question, now) {
  const built = buildQuery(intent, u.slots, { now, question });
  if (built?.needs) {
    return { kind: 'clarify', answer: `Which ${built.needs} do you mean? For example: "${INTENTS[intent][0]}".` };
  }
  const pipeline = validatePipeline(built.collection, built.pipeline, { allowUnverifiedCounts: !!built.unverified });
  const conn = await getReadConnection();
  const rows = await conn.db.collection(built.collection).aggregate(pipeline, { maxTimeMS: 5000 }).toArray();
  return {
    kind: 'table',
    title: built.title,
    answer: phrase(intent, built, rows, u.slots),
    columns: built.columns,
    rows: rows.map((r) => JSON.parse(JSON.stringify(r))),
    chart: built.chart ?? null,
    query: pipelineToString(built.collection, pipeline),
  };
}

async function runSearch(question, slots) {
  const cleaned = question.replace(/^(?:have we seen|has anyone|did anyone|any|find|search for|look for|show me|are there)\s+/i, '').replace(/\?+$/, '');
  const results = await searchNotes(cleaned, { limit: 8, mode: 'hybrid', patientId: slots.patient?.id, from: slots.time?.from, to: slots.time?.to, minScore: 0.15 });
  return {
    kind: 'search',
    title: `Notes matching "${cleaned}"`,
    answer: results.length
      ? `Found ${results.length} verified note${results.length === 1 ? '' : 's'} that best match your description. Open a note to check the details.`
      : 'No verified notes closely match that description.',
    results,
    query: `hybrid search: $vectorSearch / cosine on note_chunks.embedding + $text, fused by reciprocal rank (k=60)\nquery text: "${cleaned}"`,
  };
}

/** Extractive summary built from verified encounters; no generated text. */
export async function summarisePatient(patientId, lastN = 3) {
  const p = await Patient.findById(patientId).lean();
  if (!p) return null;
  const encs = await Encounter.find({ patientId, status: 'verified' }).sort({ visitDate: 1 }).lean();
  const meds = new Map();
  const labs = new Map();
  let lastVitals = null;
  for (const e of encs) {
    for (const m of e.extraction?.medications ?? []) {
      if (m.negated || m.action === 'mention') continue;
      meds.set(m.generic, { ...m, since: meds.get(m.generic)?.since && m.action !== 'start' ? meds.get(m.generic).since : e.visitDate, lastSeen: e.visitDate });
    }
    for (const l of e.extraction?.labs ?? []) {
      const prev = labs.get(l.test);
      labs.set(l.test, { ...l, date: e.visitDate, previous: prev ? { value: prev.value, date: prev.date } : null });
    }
    if (e.extraction?.vitals?.length) lastVitals = { date: e.visitDate, vitals: e.extraction.vitals };
  }
  // long-term drugs stay current until stopped; short courses only while they last
  const nowMs = Date.now();
  const isActive = (m) => {
    if (!ACTIVE_MED_ACTIONS.includes(m.action)) return false;
    if (m.action !== 'prescribe' || LONG_TERM_CLASSES.test(m.drugClass ?? '')) return true;
    const end = new Date(m.lastSeen).getTime() + (m.durationDays ?? 14) * 864e5;
    return end >= nowMs;
  };
  const activeMeds = [...meds.values()].filter(isActive);
  const stoppedMeds = [...meds.values()].filter((m) => m.action === 'stop');
  const conditions = new Map();
  for (const e of encs) for (const d of e.extraction?.diagnoses ?? []) {
    if (d.certainty === 'ruled_out' || d.context === 'family' || d.context === 'history') continue;
    if (d.chronic || e === encs[encs.length - 1]) conditions.set(d.code, { term: d.term, code: d.code, chronic: d.chronic, lastSeen: e.visitDate, certainty: d.certainty });
  }
  const followups = await Followup.find({ patientId, status: { $in: ['due', 'overdue'] } }).sort({ dueDate: 1 }).lean();
  const recent = encs.slice(-lastN).reverse().map((e) => ({
    encounterId: String(e._id),
    visitDate: e.visitDate,
    diagnoses: (e.extraction?.diagnoses ?? []).filter((d) => d.certainty !== 'ruled_out' && d.context === 'current').map((d) => `${d.term}${d.certainty === 'provisional' ? ' (provisional)' : ''}`),
    symptoms: (e.extraction?.symptoms ?? []).filter((s) => !s.negated).map((s) => s.term),
    medicationChanges: (e.extraction?.medications ?? []).filter((m) => ['start', 'stop', 'increase', 'decrease'].includes(m.action)).map((m) => `${m.action} ${m.generic}${m.dose ? ` ${m.dose} ${m.unit ?? ''}`.trimEnd() : ''}`),
    followUp: e.extraction?.followUp?.dueDate ?? (e.extraction?.followUp?.asNeeded ? 'as needed' : null),
  }));
  const age = Math.floor((Date.now() - new Date(p.dob)) / (365.25 * 864e5));

  const lines = [];
  lines.push(`${p.name}, ${age}${p.sex}, ${encs.length} verified visit${encs.length === 1 ? '' : 's'}${encs.length ? `, last on ${fmtDate(encs[encs.length - 1].visitDate)}` : ''}.`);
  const chronic = [...conditions.values()].filter((c) => c.chronic);
  if (chronic.length) lines.push(`Long-term conditions: ${chronic.map((c) => c.term).join(', ')}.`);
  if (activeMeds.length) lines.push(`Current medications: ${activeMeds.map((m) => `${m.generic}${m.dose ? ` ${m.dose} ${m.unit ?? ''}`.trimEnd() : ''}${m.frequency ? ` ${m.frequency}` : ''}`).join('; ')}.`);
  if (stoppedMeds.length) lines.push(`Stopped: ${stoppedMeds.map((m) => `${m.generic} (${fmtDate(m.lastSeen)})`).join(', ')}.`);
  const labLines = [...labs.values()].filter((l) => typeof l.value === 'number').map((l) => `${l.test} ${l.value}${l.unit ? ` ${l.unit}` : ''} on ${fmtDate(l.date)}${l.previous ? ` (previously ${l.previous.value})` : ''}`);
  if (labLines.length) lines.push(`Latest labs: ${labLines.join('; ')}.`);
  if (p.allergies?.length) lines.push(`Allergies: ${p.allergies.join(', ')}.`);
  if (followups.length) lines.push(`Open follow-up: due ${fmtDate(followups[0].dueDate)}${followups[0].status === 'overdue' ? ' (overdue)' : ''}${followups[0].reason ? `, ${followups[0].reason}` : ''}.`);

  return {
    patient: { id: String(p._id), name: p.name, code: p.patientCode, age, sex: p.sex, allergies: p.allergies ?? [] },
    summary: lines.join(' '),
    activeMedications: activeMeds.map((m) => ({ generic: m.generic, dose: m.dose, unit: m.unit, frequency: m.frequency, since: m.since })),
    conditions: [...conditions.values()],
    latestLabs: [...labs.values()],
    lastVitals,
    openFollowups: followups.map((f) => ({ id: String(f._id), dueDate: f.dueDate, status: f.status, reason: f.reason })),
    recent,
  };
}

const HELP = 'I can answer questions about verified clinic records, for example: "Which patients on metformin missed follow-ups this month?", "Patients with HbA1c above 8", "Most common diagnoses last month", "Summarise Ravi Kumar\'s last 3 visits", or "Have we seen patients with a rash after starting an antibiotic?". I only read data; I cannot change records or give clinical advice.';

export async function answerQuestion(question, { user = null, now = new Date() } = {}) {
  const t0 = Date.now();
  const q = String(question ?? '').trim().slice(0, 500);
  const patients = await patientNames();
  const u = understand(q, { patients, now });
  // the local LLM gets a say only when the classifier is unsure, and never over the safety rules
  const unsure = u.reason.startsWith('low confidence') || (u.reason === 'classifier' && u.confidence < 0.5);
  if (unsure && await llmEnabled('assistant')) {
    try {
      const p = await llmParseQuestion(q, { patients, now });
      if (p && !(p.intent === 'patient_summary' && !p.slots.patient)) {
        const merged = { ...u.slots };
        for (const k of ['drugs', 'drugClasses', 'diagnoses', 'symptoms']) if (p.slots[k].length) merged[k] = p.slots[k];
        for (const k of ['lab', 'time', 'patient', 'limit']) if (p.slots[k]) merged[k] = p.slots[k];
        merged.wantsCount = merged.wantsCount || p.slots.wantsCount;
        merged.requireAllDrugs = p.slots.requireAllDrugs || merged.requireAllDrugs;
        Object.assign(u, { intent: p.intent, slots: merged, reason: `local LLM (${p.model})${p.rejected.length ? `; ignored unknown terms: ${p.rejected.join(', ')}` : ''}` });
      }
    } catch (e) {
      u.reason += ` (local LLM unavailable: ${e.message})`;
    }
  }
  let res;
  try {
    switch (u.intent) {
      case 'unsafe_action':
        res = { kind: 'refusal', answer: 'I can only read de-identified clinic data. I cannot change, delete or export records, and I never return contact details.' };
        break;
      case 'clinical_advice':
        res = { kind: 'refusal', answer: 'I organise what doctors have documented and do not give diagnosis, prescribing or dosing advice. Please rely on clinical judgement and current guidelines. I can show what has been recorded, for example how many patients are on a drug or their latest lab values.' };
        break;
      case 'greeting_help':
        res = { kind: 'help', answer: HELP };
        break;
      case 'unanswerable':
        res = { kind: 'abstain', answer: "The clinic notes don't record that, so I can't answer it. I can answer questions about diagnoses, medicines, lab results, symptoms, visits and follow-ups." };
        break;
      case 'needs_patient':
        res = { kind: 'clarify', answer: 'I could not find that patient. Please use their full name as registered, or open the patient from the Patients page.' };
        break;
      case 'patient_summary': {
        const s = await summarisePatient(u.slots.patient.id, u.slots.lastVisits ?? 3);
        res = {
          kind: 'summary',
          title: `Summary: ${s.patient.name}`,
          answer: s.summary,
          summary: s,
          query: `db.patients.findOne({ _id: ObjectId("${s.patient.id}") })\ndb.encounters.find({ patientId: ObjectId("${s.patient.id}"), status: "verified" }).sort({ visitDate: 1 })\ndb.followups.find({ patientId: ObjectId("${s.patient.id}"), status: { $in: ["due", "overdue"] } })`,
        };
        break;
      }
      case 'note_search':
        res = await runSearch(q, u.slots);
        if (u.reason.startsWith('low confidence')) res.answer = `I wasn't sure how to turn that into a query, so I searched the note text instead. ${res.answer}`;
        if (res.results.length && await llmEnabled('assistant')) {
          try {
            const g = await llmSummariseResults(q, res.results.slice(0, 5));
            res.generated = g;
          } catch (e) {
            res.generated = { text: null, rejectedBecause: e.message };
          }
        }
        break;
      default:
        res = await runStructured(u.intent, u, q, now);
    }
  } catch (err) {
    if (err instanceof UnsafeQueryError) res = { kind: 'refusal', answer: `The generated query was blocked by the safety validator: ${err.message}.` };
    else throw err;
  }
  const latencyMs = Date.now() - t0;
  const log = await AssistantLog.create({
    userId: user?._id, question: q, intent: u.intent, confidence: u.confidence, slots: u.slots, route: u.reason,
    pipeline: res.query ?? null, resultCount: res.rows?.length ?? res.results?.length ?? null, answer: res.answer, latencyMs,
  });
  return { id: String(log._id), question: q, intent: u.intent, intentLabel: INTENT_LABELS[u.intent] ?? u.intent, confidence: u.confidence, route: u.reason, ranked: u.ranked, slots: u.slots, latencyMs, ...res };
}
