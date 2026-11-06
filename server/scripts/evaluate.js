// Offline evaluation of every local model. No database needed.
//
//   node scripts/evaluate.js [--notes 400]
//
// 1. Extraction: held-out generated notes (a different random seed from the
//    seeded database) and hand-written edge cases, scored against ground truth.
// 2. Assistant intent classifier: held-out questions + 5-fold cross-validation.
// 3. Semantic search: paraphrased queries, embedding retrieval vs keyword baseline.
// 4. Query safety: adversarial pipelines must all be rejected by the validator.
// Results are printed and written to EVALUATION.md and eval-results.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNote } from '../src/nlp/extractor.js';
import { rng, generatePatients, scheduleVisits, writeVisit } from './synth/generator.js';
import { EDGE_CASES, EDGE_VISIT_DATE } from './data/edgeCases.js';
import { BLIND_CASES, BLIND_VISIT_DATE } from './data/blindCases.js';
import { ASSISTANT_EVAL } from './data/assistantEval.js';
import { understand, trainAssistant } from '../src/nlp/assistant/assistant.js';
import { IntentClassifier } from '../src/nlp/assistant/classifier.js';
import { INTENTS } from '../src/nlp/assistant/intents.js';
import { extractSlots } from '../src/nlp/assistant/slots.js';
import { validatePipeline } from '../src/nlp/assistant/validator.js';
import { buildQuery } from '../src/nlp/assistant/queryBuilder.js';
import { hashEmbed, cosine } from '../src/nlp/embedder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argNotes = Number(process.argv[process.argv.indexOf('--notes') + 1]) || 400;

// ---------------------------------------------------------------------------
// extraction scoring
// ---------------------------------------------------------------------------
const prf = ({ tp, fp, fn }) => {
  const p = tp + fp ? tp / (tp + fp) : 1; const r = tp + fn ? tp / (tp + fn) : 1;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, tp, fp, fn };
};
function setScore(acc, modelKeys, truthKeys) {
  const a = new Set(modelKeys); const b = new Set(truthKeys);
  for (const k of a) (b.has(k) ? acc.tp++ : acc.fp++);
  for (const k of b) if (!a.has(k)) acc.fn++;
}
const blank = () => ({ tp: 0, fp: 0, fn: 0 });

function normaliseGt(gt) {
  // edge cases use compact tuples; generated notes use objects
  const compact = ['symptoms', 'diagnoses', 'medications', 'labs', 'vitals'].some((k) => Array.isArray(gt[k]?.[0]));
  if (compact) {
    return {
      symptoms: gt.symptoms.map(([term, negated]) => ({ term, negated })),
      diagnoses: gt.diagnoses.map(([code, certainty]) => ({ code, certainty })),
      medications: gt.medications.map(([generic, dose, frequency, action]) => ({ generic, dose, frequency, action })),
      labs: (gt.labs ?? []).map(([test, value]) => ({ test, value })),
      vitals: (gt.vitals ?? []).map(([name, value]) => ({ name, value })),
      allergies: gt.allergies ?? [],
      followUp: gt.followUp ? { dueDate: gt.followUp.dueDate ?? null, asNeeded: !!gt.followUp.asNeeded } : null,
    };
  }
  return { ...gt, symptoms: gt.symptoms ?? [], diagnoses: gt.diagnoses ?? [], medications: gt.medications ?? [], labs: gt.labs ?? [], vitals: gt.vitals ?? [] };
}

function scoreExtraction(items) {
  const s = { symptomsDetect: blank(), negation: { correct: 0, total: 0 }, diagnosesDetect: blank(), diagnosesCertainty: blank(), medicationsDetect: blank(), dose: { c: 0, n: 0 }, frequency: { c: 0, n: 0 }, action: { c: 0, n: 0 }, labs: blank(), vitals: blank(), followUp: { c: 0, n: 0 }, allergies: blank() };
  const errors = [];
  for (const { text, gt: raw, visitDate } of items) {
    const gt = normaliseGt(raw);
    const m = extractNote(text, { visitDate: new Date(visitDate) });
    setScore(s.symptomsDetect, m.symptoms.map((x) => x.term), gt.symptoms.map((x) => x.term));
    for (const g of gt.symptoms) {
      const hit = m.symptoms.find((x) => x.term === g.term);
      if (hit) { s.negation.total++; if (hit.negated === g.negated) s.negation.correct++; else errors.push({ type: 'negation', term: g.term, text }); }
    }
    setScore(s.diagnosesDetect, m.diagnoses.filter((d) => d.certainty !== 'ruled_out' || gt.diagnoses.some((g) => g.code === d.code)).map((d) => d.code), gt.diagnoses.map((d) => d.code));
    setScore(s.diagnosesCertainty, m.diagnoses.map((d) => `${d.code}|${d.certainty}`), gt.diagnoses.map((d) => `${d.code}|${d.certainty}`));
    setScore(s.medicationsDetect, m.medications.filter((x) => !x.negated).map((x) => x.generic), gt.medications.map((x) => x.generic));
    for (const g of gt.medications) {
      const cands = m.medications.filter((x) => x.generic === g.generic && !x.negated);
      if (!cands.length) { errors.push({ type: 'missed medication', term: g.generic, text }); continue; }
      const hit = cands.find((x) => x.action === g.action) ?? cands[0];
      s.dose.n++; if ((hit.dose ?? null) === (g.dose ?? null)) s.dose.c++; else errors.push({ type: 'dose', term: `${g.generic}: got ${hit.dose}, want ${g.dose}`, text });
      s.frequency.n++; if ((hit.frequency ?? null) === (g.frequency ?? null)) s.frequency.c++; else errors.push({ type: 'frequency', term: `${g.generic}: got ${hit.frequency}, want ${g.frequency}`, text });
      s.action.n++; if (hit.action === g.action) s.action.c++; else errors.push({ type: 'action', term: `${g.generic}: got ${hit.action}, want ${g.action}`, text });
    }
    setScore(s.labs, m.labs.map((l) => `${l.test}|${l.value}`), gt.labs.map((l) => `${l.test}|${l.value}`));
    for (const g of gt.labs) if (!m.labs.some((l) => l.test === g.test && l.value === g.value)) errors.push({ type: 'missed lab', term: `${g.test} ${g.value}`, text });
    for (const l of m.labs) if (!gt.labs.some((g) => g.test === l.test && g.value === l.value)) errors.push({ type: 'extra lab', term: `${l.test} ${l.value}`, text });
    for (const g of gt.diagnoses) if (!m.diagnoses.some((d) => d.code === g.code && d.certainty === g.certainty)) errors.push({ type: 'missed diagnosis', term: `${g.code} ${g.certainty}`, text });
    for (const d of m.diagnoses) if (!gt.diagnoses.some((g) => g.code === d.code && g.certainty === d.certainty)) errors.push({ type: 'extra diagnosis', term: `${d.code} ${d.certainty} (${d.surface})`, text });
    for (const x of m.medications) if (!x.negated && !gt.medications.some((g) => g.generic === x.generic)) errors.push({ type: 'extra medication', term: `${x.generic} (${x.surface})`, text });
    setScore(s.vitals, m.vitals.map((v) => `${v.name}|${v.value}`), gt.vitals.map((v) => `${v.name}|${v.value}`));
    if (gt.allergies) setScore(s.allergies, m.allergies.map((a) => a.substance), gt.allergies);
    if (gt.followUp === null && raw.followUp === null) {
      s.followUp.n++;
      if (!m.followUp || (m.followUp.asNeeded && !m.followUp.dueDate)) s.followUp.c++; else errors.push({ type: 'follow-up', term: `got ${m.followUp.dueDate}, want none`, text });
    } else if (gt.followUp) {
      s.followUp.n++;
      const ok = gt.followUp.asNeeded ? !!m.followUp?.asNeeded && !m.followUp?.dueDate : m.followUp?.dueDate === gt.followUp.dueDate;
      if (ok) s.followUp.c++; else errors.push({ type: 'follow-up', term: `got ${m.followUp?.dueDate ?? (m.followUp?.asNeeded ? 'SOS' : 'none')}, want ${gt.followUp.dueDate ?? 'SOS'}`, text });
    }
  }
  const acc = (x) => (x.n ? x.c / x.n : null);
  return {
    notes: items.length,
    metrics: {
      'Symptoms (detection)': prf(s.symptomsDetect),
      'Diagnoses (ICD-10 code)': prf(s.diagnosesDetect),
      'Diagnoses (code + certainty)': prf(s.diagnosesCertainty),
      'Medications (detection)': prf(s.medicationsDetect),
      'Lab values': prf(s.labs),
      'Vital signs': prf(s.vitals),
    },
    accuracies: {
      'Negation (matched symptoms)': s.negation.total ? s.negation.correct / s.negation.total : null,
      'Medication dose': acc(s.dose),
      'Medication frequency': acc(s.frequency),
      'Medication action': acc(s.action),
      'Follow-up date': acc(s.followUp),
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// 1. extraction
// ---------------------------------------------------------------------------
const r = rng(1001); // different seed from the database
const today = new Date();
const people = generatePatients(r, 220, today);
const visits = scheduleVisits(r, people, new Date(today.getTime() - 240 * 864e5), today).slice(0, argNotes);
const generated = visits.map((v) => { const w = writeVisit(r, v.p, v.date, v.kind); return { text: w.text, gt: w.gt, visitDate: v.date }; });
const genResult = scoreExtraction(generated);
const edgeResult = scoreExtraction(EDGE_CASES.map((e) => ({ ...e, visitDate: EDGE_VISIT_DATE })));
const blindResult = scoreExtraction(BLIND_CASES.map((e) => ({ ...e, visitDate: BLIND_VISIT_DATE })));

// ---------------------------------------------------------------------------
// 2. intent classifier
// ---------------------------------------------------------------------------
trainAssistant();
const evalPatients = [{ _id: 'x1', name: 'Meena Pillai' }, { _id: 'x2', name: 'Joseph Thomas' }, { _id: 'x3', name: 'Farhan Qureshi' }];
const now = new Date();
let intentCorrect = 0; let slotCorrect = 0; let slotTotal = 0;
const intentErrors = [];
const confusion = {};
ASSISTANT_EVAL.forEach((t, i) => {
  const q = t.q.replace('PATIENT', evalPatients[i % 3].name);
  const u = understand(q, { patients: evalPatients, now });
  const ok = u.intent === t.intent;
  if (ok) intentCorrect++; else intentErrors.push({ q, expected: t.intent, got: u.intent, confidence: u.confidence });
  confusion[t.intent] = confusion[t.intent] ?? { total: 0, correct: 0 };
  confusion[t.intent].total++; if (ok) confusion[t.intent].correct++;
  const checks = [];
  if (t.drugs) checks.push(t.drugs.every((d) => u.slots.drugs.includes(d)));
  if (t.classes) checks.push(t.classes.every((c) => u.slots.drugClasses.includes(c)));
  if (t.dx) checks.push(t.dx.every((c) => u.slots.diagnoses.some((d) => d.code === c)));
  if (t.sx) checks.push(t.sx.every((c) => u.slots.symptoms.includes(c)));
  if (t.lab) checks.push(u.slots.lab?.test === t.lab);
  if (t.time) checks.push(u.slots.time?.label === t.time);
  if (t.patient) checks.push(!!u.slots.patient);
  slotTotal += checks.length; slotCorrect += checks.filter(Boolean).length;
  if (checks.includes(false)) intentErrors.push({ q, slotsMissing: true, slots: { drugs: u.slots.drugs, dx: u.slots.diagnoses.map((d) => d.code), sx: u.slots.symptoms, lab: u.slots.lab?.test, time: u.slots.time?.label } });
});

// 5-fold cross-validation on the training questions
const names = ['Ravi Kumar', 'Priya Sharma', 'Anil Mehta', 'Sunita Reddy', 'Mohammed Khan', 'Lakshmi Iyer', 'Arjun Nair', 'Rahul Verma', 'Kavya Rao', 'Deepak Joshi'].map((n, i) => ({ _id: `t${i}`, name: n }));
const all = Object.entries(INTENTS).flatMap(([label, texts]) => texts.map((text) => ({ text: extractSlots(text, { patients: names }).masked, label })));
const cr = rng(5); const shuffled = cr.shuffle(all);
let cvCorrect = 0;
for (let f = 0; f < 5; f++) {
  const test = shuffled.filter((_, i) => i % 5 === f);
  const train = shuffled.filter((_, i) => i % 5 !== f);
  const clf = new IntentClassifier().train(train);
  for (const t of test) if (clf.predict(t.text).intent === t.label) cvCorrect++;
}

// ---------------------------------------------------------------------------
// 3. semantic search: paraphrased queries, relevance from ground truth
// ---------------------------------------------------------------------------
const corpus = generated.map((g) => ({ text: g.text, gt: normaliseGt(g.gt), vec: hashEmbed(g.text) }));
const SEARCH_QUERIES = [
  { q: 'shortness of breath', rel: (g) => g.symptoms.some((s) => s.term === 'breathlessness' && !s.negated) },
  { q: 'loose stools and vomiting', rel: (g) => g.symptoms.some((s) => s.term === 'diarrhoea' && !s.negated) },
  { q: 'pain while passing urine', rel: (g) => g.symptoms.some((s) => s.term === 'dysuria' && !s.negated) },
  { q: 'feeling tired and weak', rel: (g) => g.symptoms.some((s) => s.term === 'fatigue' && !s.negated) },
  { q: 'high temperature with body pains', rel: (g) => g.symptoms.some((s) => s.term === 'fever' && !s.negated) },
  { q: 'acid reflux burning in chest', rel: (g) => g.symptoms.some((s) => s.term === 'heartburn' && !s.negated) },
  { q: 'sugar not controlled on glycomet', rel: (g) => g.diagnoses.some((d) => d.code === 'E11') },
  { q: 'blood pressure tablets telmisartan', rel: (g) => g.medications.some((m) => m.generic === 'telmisartan') },
  { q: 'thyroid medicine dose', rel: (g) => g.medications.some((m) => m.generic === 'levothyroxine') },
  { q: 'itchy skin rash fungal', rel: (g) => g.diagnoses.some((d) => d.code === 'B35.4') },
  { q: 'running nose and sneezing', rel: (g) => g.symptoms.some((s) => (s.term === 'runny nose' || s.term === 'sneezing') && !s.negated) },
  { q: 'giddiness', rel: (g) => g.symptoms.some((s) => s.term === 'dizziness' && !s.negated) },
  { q: 'swelling of feet after a blood pressure tablet', rel: (g) => g.symptoms.some((s) => s.term === 'pedal oedema' && !s.negated) },
  { q: 'rash after starting an antibiotic', rel: (g) => g.diagnoses.some((d) => d.code === 'T88.7') && g.symptoms.some((s) => s.term === 'rash' && !s.negated) },
];
const kwScore = (q, t) => { const qs = new Set(q.toLowerCase().split(/\W+/).filter((w) => w.length > 2)); const ts = t.toLowerCase().split(/\W+/); return ts.filter((w) => qs.has(w)).length; };
let semP = 0; let kwP = 0;
const searchRows = SEARCH_QUERIES.map(({ q, rel }) => {
  const qv = hashEmbed(q);
  const sem = [...corpus].sort((a, b) => cosine(qv, b.vec) - cosine(qv, a.vec)).slice(0, 10);
  const kw = [...corpus].map((c) => ({ c, s: kwScore(q, c.text) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 10).map((x) => x.c);
  const k = Math.max(1, Math.min(10, corpus.filter((c) => rel(c.gt)).length));
  const sp = sem.slice(0, k).filter((c) => rel(c.gt)).length / k;
  const kp = kw.slice(0, k).filter((c) => rel(c.gt)).length / k;
  semP += sp; kwP += kp;
  return { q, semantic: sp, keyword: kp, k };
});

// ---------------------------------------------------------------------------
// 4. validator: adversarial pipelines
// ---------------------------------------------------------------------------
const ATTACKS = [
  ['encounters', [{ $match: { status: 'verified' } }, { $out: 'stolen' }]],
  ['encounters', [{ $match: { status: 'verified' } }, { $merge: { into: 'patients' } }]],
  ['patients', [{ $match: { $where: 'sleep(1000)' } }]],
  ['patients', [{ $match: {} }, { $project: { phoneEnc: 1 } }]],
  ['users', [{ $match: {} }]],
  ['encounters', [{ $match: {} }, { $project: { rawNote: 1 } }]],
  ['followups', [{ $match: {} }, { $lookup: { from: 'users', localField: 'x', foreignField: '_id', as: 'u' } }]],
  ['followups', [{ $match: {} }, { $lookup: { from: 'encounters', localField: 'sourceEncounterId', foreignField: '_id', as: 'e' } }]],
  ['encounters', [{ $match: { status: 'verified' } }, { $group: { _id: null, x: { $accumulator: { init: 'function(){}' } } } }]],
  ['encounters', [{ $match: { status: 'verified' } }, { $unionWith: 'users' }]],
  ['patients', [{ $match: {} }, { $limit: 100000 }]],
  ['encounters', [{ $match: { status: 'verified' } }, { $addFields: { p: '$$ROOT' } }, { $project: { x: { $function: { body: 'return 1', args: [], lang: 'js' } } } }]],
  ['patients', [{ $match: {} }, { $addFields: { phone: '$phoneEnc' } }]],
  ['encounters', [{ $match: { status: 'verified' } }, { $lookup: { from: 'patients', pipeline: [{ $match: {} }, { $lookup: { from: 'patients', pipeline: [{ $match: {} }], as: 'deep' } }], as: 'p' } }]],
];
let blocked = 0;
for (const [coll, p] of ATTACKS) { try { validatePipeline(coll, p); } catch { blocked++; } }
// every query the builder produces must pass
let builderOk = 0; let builderTotal = 0;
const sampleSlots = understand('patients on metformin with diabetes this month', { now }).slots;
for (const intent of ['overdue_followups', 'upcoming_followups', 'patients_on_drug', 'patients_with_diagnosis', 'top_diagnoses', 'top_medications', 'visit_stats']) {
  builderTotal++;
  const b = buildQuery(intent, sampleSlots, { now, question: '' });
  try { validatePipeline(b.collection, b.pipeline, { allowUnverifiedCounts: !!b.unverified }); builderOk++; } catch (e) { console.error(intent, e.message); }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
function extractionTable(res) {
  const lines = ['| Field | Precision | Recall | F1 |', '| --- | --- | --- | --- |'];
  for (const [k, v] of Object.entries(res.metrics)) lines.push(`| ${k} | ${pct(v.precision)} | ${pct(v.recall)} | ${pct(v.f1)} |`);
  lines.push('', '| Attribute | Accuracy |', '| --- | --- |');
  for (const [k, v] of Object.entries(res.accuracies)) lines.push(`| ${k} | ${pct(v)} |`);
  return lines.join('\n');
}
const report = `# Evaluation results

Generated by \`npm run evaluate\` on ${new Date().toISOString().slice(0, 10)}. All data is synthetic.

## 1. Clinical extraction

### Held-out generated notes (${genResult.notes} notes, random seed different from the seeded database)

These notes come from the project's own generator, which writes with the same vocabulary the extractor knows. They show the whole pipeline works at scale, but they overstate accuracy on real notes. The blind hand-written set below is the honest estimate.

${extractionTable(genResult)}

### Hand-written edge cases (${edgeResult.notes} notes: negation scope, uncertainty, history, allergies, typos, dose changes)

Written to probe known hard cases and used during development to find and fix bugs, so these scores are optimistic too.

${extractionTable(edgeResult)}

${edgeResult.errors.length ? `Remaining edge-case errors:\n\n${edgeResult.errors.map((e) => `- **${e.type}**: ${e.term}`).join('\n')}` : 'No edge-case errors.'}

### Blind hand-written notes (${blindResult.notes} notes written after development and never used for tuning)

This is the most honest estimate of performance on unseen notes.

${extractionTable(blindResult)}

${blindResult.errors.length ? `Errors on the blind set:\n\n${blindResult.errors.map((e) => `- **${e.type}**: ${e.term}`).join('\n')}` : 'No errors on the blind set.'}

## 2. Assistant intent classifier

- Held-out questions: **${intentCorrect}/${ASSISTANT_EVAL.length} (${pct(intentCorrect / ASSISTANT_EVAL.length)})** routed to the correct intent
- Slot filling on those questions: **${slotCorrect}/${slotTotal} (${pct(slotCorrect / slotTotal)})** expected slots filled
- 5-fold cross-validation on the ${all.length} training questions: **${pct(cvCorrect / all.length)}**

| Intent | Correct |
| --- | --- |
${Object.entries(confusion).map(([k, v]) => `| ${k} | ${v.correct}/${v.total} |`).join('\n')}

${intentErrors.length ? `Misrouted or incomplete:\n\n${intentErrors.map((e) => (e.slotsMissing ? `- slots: "${e.q}" → ${JSON.stringify(e.slots)}` : `- "${e.q}": expected ${e.expected}, got ${e.got} (${e.confidence})`)).join('\n')}` : ''}

## 3. Semantic search (clinhash-384 embeddings vs keyword overlap)

Precision@k (k = min(10, number of relevant notes)) on paraphrased queries over the ${corpus.length} held-out notes; relevance comes from ground truth.

| Query | k | Embedding search | Keyword baseline |
| --- | --- | --- | --- |
${searchRows.map((s) => `| ${s.q} | ${s.k} | ${pct(s.semantic)} | ${pct(s.keyword)} |`).join('\n')}
| **Mean** | | **${pct(semP / searchRows.length)}** | **${pct(kwP / searchRows.length)}** |

Embedding search clearly beats keyword matching, which cannot connect "pain while passing urine" or "thyroid medicine" to how notes are written. IDF weighting of the hashed features (on notes, on queries, or averaged) was tried during development and lowered the mean, so it is not used. Known weak spot: a query that shares many routine words with ordinary review notes ("swelling of feet after a blood pressure tablet") can rank routine notes that say "Denies swelling of feet" above the few real matches.

## 4. Query safety

- Adversarial pipelines blocked by the validator: **${blocked}/${ATTACKS.length}**
- Builder-generated pipelines accepted: **${builderOk}/${builderTotal}**
- Rule-based refusals for clinical advice and data changes are covered in section 2 (clinical_advice, unsafe_action rows).
`;

fs.writeFileSync(path.join(__dirname, '..', 'EVALUATION.md'), report);
fs.writeFileSync(path.join(__dirname, '..', 'eval-results.json'), JSON.stringify({ generated: { ...genResult, errors: genResult.errors.slice(0, 50) }, edge: edgeResult, blind: blindResult, intent: { correct: intentCorrect, total: ASSISTANT_EVAL.length, slotCorrect, slotTotal, cv: cvCorrect / all.length, errors: intentErrors }, search: searchRows, safety: { blocked, attacks: ATTACKS.length, builderOk, builderTotal } }, null, 2));
console.log(report);
if (process.argv.includes('--errors')) {
  const byType = {};
  for (const e of genResult.errors) (byType[e.type] ??= []).push(e);
  for (const [t, list] of Object.entries(byType)) { console.log(`\n## ${t}: ${list.length}`); for (const e of list.slice(0, 6)) console.log(`- ${e.term}\n    ${e.text.replace(/\n/g, ' | ')}`); }
}
