// The local LLM's two jobs in the assistant, both checked before use:
//  1. understand questions the intent classifier is unsure about, by filling a
//     fixed JSON form (intent + slots). Every slot is then re-validated against
//     the lexicons, so the LLM never writes a database query itself.
//  2. write a short summary of the notes a search found, which is accepted only
//     if every sentence cites a note and every number appears in the cited notes.
import { chatJSON } from './ollama.js';
import { normaliseMention } from '../extractor.js';
import { LABS } from '../lexicon/measurements.js';
import { DRUG_CLASS_WORDS, parseTimeRange, extractSlots } from '../assistant/slots.js';

export const LLM_INTENTS = ['overdue_followups', 'upcoming_followups', 'patients_on_drug', 'patients_with_diagnosis', 'patients_with_symptom', 'lab_threshold', 'top_diagnoses', 'top_medications', 'visit_stats', 'patient_summary', 'note_search', 'unanswerable'];

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: LLM_INTENTS },
    drugs: { type: 'array', items: { type: 'string' } },
    diagnoses: { type: 'array', items: { type: 'string' } },
    symptoms: { type: 'array', items: { type: 'string' } },
    lab_test: { type: ['string', 'null'] },
    comparator: { type: ['string', 'null'], enum: ['above', 'below', null] },
    value: { type: ['number', 'null'] },
    time_phrase: { type: ['string', 'null'] },
    patient_name: { type: ['string', 'null'] },
    limit: { type: ['integer', 'null'] },
    wants_count: { type: 'boolean' },
  },
  required: ['intent'],
};

const PARSE_SYSTEM = `Convert the question from clinic staff into a JSON form. Do not answer it.
Intents:
- overdue_followups: patients who missed a follow-up/review
- upcoming_followups: follow-ups due in a coming period
- patients_on_drug: patients taking / started on / stopped a medicine or drug class
- patients_with_diagnosis: patients with a disease, or how many cases
- patients_with_symptom: patients who reported a symptom
- lab_threshold: patients with a lab value above/below a number (HbA1c, FBS, TSH, Hb, LDL, creatinine...)
- top_diagnoses / top_medications: most common diagnoses / most prescribed medicines
- visit_stats: counts of visits or notes waiting for review
- patient_summary: about one named patient
- note_search: find notes describing something in free text
- unanswerable: anything clinic notes do not record (blood group, ward, billing, insurance, staff rosters, weather...)
Copy drug, disease, symptom and lab names as written. time_phrase is the time words as written (e.g. "last month").`;

/** Ask the LLM to fill the form, then validate every field against the lexicons. */
export async function llmParseQuestion(question, { patients = [], now = new Date() } = {}) {
  const { data, model } = await chatJSON({ system: PARSE_SYSTEM, user: `Question: ${question}`, schema: PARSE_SCHEMA });
  if (!LLM_INTENTS.includes(data.intent)) return null;
  const slots = { drugs: [], drugClasses: [], diagnoses: [], symptoms: [], lab: null, time: null, patient: null, limit: null, wantsCount: !!data.wants_count, lastVisits: null, medAction: null, certainty: null, requireAllDrugs: false };
  const rejected = [];
  for (const d of data.drugs ?? []) {
    const cls = DRUG_CLASS_WORDS.find((c) => c.re.test(d));
    if (cls) { slots.drugClasses.push(cls.cls); continue; }
    const n = normaliseMention('medication', d);
    if (n?.type === 'medication') slots.drugs.push(n.entry.generic); else rejected.push(d);
  }
  for (const d of data.diagnoses ?? []) {
    const n = normaliseMention('diagnosis', d);
    if (n?.type === 'diagnosis' && !slots.diagnoses.some((x) => x.code === n.entry.code)) slots.diagnoses.push({ term: n.entry.term, code: n.entry.code }); else if (!n) rejected.push(d);
  }
  for (const s of data.symptoms ?? []) {
    const n = normaliseMention('symptom', s);
    if (n?.type === 'symptom') slots.symptoms.push(n.entry.term); else rejected.push(s);
  }
  if (data.lab_test) {
    const lab = LABS.find((l) => l.aliases.includes(data.lab_test.toLowerCase()) || l.test.toLowerCase() === data.lab_test.toLowerCase());
    if (lab) slots.lab = { test: lab.test, unit: lab.unit, ...(data.comparator && data.value != null ? { op: data.comparator === 'above' ? '$gt' : '$lt', value: Number(data.value) } : {}) };
    else rejected.push(data.lab_test);
  }
  if (data.time_phrase) {
    const t = parseTimeRange(data.time_phrase, now);
    if (t) slots.time = { from: t.from.toISOString(), to: t.to.toISOString(), label: t.label };
  }
  if (data.patient_name) {
    const p = extractSlots(data.patient_name, { patients, now }).slots.patient;
    if (p) slots.patient = p;
  }
  if (Number.isInteger(data.limit) && data.limit > 0) slots.limit = Math.min(data.limit, 50);
  slots.requireAllDrugs = slots.drugs.length > 1 && /\bboth\b/i.test(question);
  return { intent: data.intent, slots, rejected, model };
}

const SUMMARY_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const SUMMARY_SYSTEM = `Answer the clinic staff's question using only the numbered notes provided.
Write at most three short sentences. End every sentence with the note numbers it relies on, like [1] or [2][3].
Do not add facts, numbers, advice or diagnoses that are not in the notes. If the notes do not answer the question, say so.`;

/** Accept a generated summary only if it is fully cited and adds no numbers. */
export function checkGrounded(text, snippets) {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length || sentences.length > 4) return { ok: false, reason: 'wrong length' };
  for (const s of sentences) {
    const cites = [...s.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (!cites.length && !/^none of the notes|^the notes do not/i.test(s)) return { ok: false, reason: 'uncited sentence' };
    if (cites.some((c) => c < 1 || c > snippets.length)) return { ok: false, reason: 'cites a note that was not given' };
    const cited = cites.map((c) => snippets[c - 1]).join(' ');
    const numbers = s.replace(/\[\d+\]/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
    for (const n of numbers) if (!cited.includes(n) && Number(n) > 3) return { ok: false, reason: `number ${n} is not in the cited notes` };
  }
  return { ok: true };
}

export async function llmSummariseResults(question, results) {
  const snippets = results.map((r) => r.snippet);
  const numbered = snippets.map((s, i) => `[${i + 1}] ${s}`).join('\n');
  const { data, model } = await chatJSON({ system: SUMMARY_SYSTEM, user: `${numbered}\n\nQuestion: ${question}`, schema: SUMMARY_SCHEMA, temperature: 0.1 });
  const text = String(data.answer ?? '').trim();
  const check = checkGrounded(text, snippets);
  return check.ok ? { text, model } : { text: null, model, rejectedBecause: check.reason };
}
