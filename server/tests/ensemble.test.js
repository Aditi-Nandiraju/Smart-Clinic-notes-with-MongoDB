// Tests for the ensemble additions: ML tagger, LLM grounding, candidate
// merging, learned vocabulary, triage, FHIR export and assistant abstention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNote, setCustomLexicon, normaliseMention } from '../src/nlp/extractor.js';
import { SequenceTagger, tokenize, spansToTags, spanF1 } from '../src/nlp/ml/tagger.js';
import { ground } from '../src/nlp/llm/llmExtractor.js';
import { checkGrounded } from '../src/nlp/llm/llmAssistant.js';
import { triageStats } from '../src/services/corrections.js';
import { encounterResources, patientResource, bundle } from '../src/services/fhir.js';
import { understand } from '../src/nlp/assistant/assistant.js';

const VISIT = new Date('2026-10-01T10:00:00Z');

test('tokenize keeps character offsets and BIO tags round-trip', () => {
  const text = 'Tab Telma 40 OD. Burning feet.';
  const tokens = tokenize(text);
  for (const t of tokens) assert.equal(text.slice(t.start, t.end), t.text);
  const tags = spansToTags(tokens, [{ type: 'medication', start: 4, end: 9 }, { type: 'symptom', start: 17, end: 29 }]);
  assert.deepEqual(tags.filter((t) => t !== 'O'), ['B-DRUG', 'B-SYM', 'I-SYM']);
});

test('sequence tagger learns a drug from context, not only the dictionary', () => {
  const brands = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
  const examples = brands.flatMap((b, i) => [`Tab ${b} ${100 * (i + 1)} mg BD.`, `Start Tab ${b} 50 OD. Review.`]).map((text) => {
    const tokens = tokenize(text);
    const tok = tokens.find((t) => brands.includes(t.text));
    return { tokens, tags: spansToTags(tokens, [{ type: 'medication', start: tok.start, end: tok.end }]), lex: tokens.map(() => null) };
  });
  const m = new SequenceTagger().train(examples, { epochs: 10 });
  const pred = m.predict('Tab Zorvex 500 mg BD.', (tokens) => tokens.map(() => null));
  assert.ok(pred.some((p) => p.type === 'medication' && p.surface === 'Zorvex'), JSON.stringify(pred));
  assert.equal(spanF1(pred.filter((p) => p.type === 'medication'), [{ type: 'medication', start: 4, end: 10 }]).f1, 1);
  const again = SequenceTagger.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  assert.deepEqual(again.predict('Tab Zorvex 500 mg BD.', (t) => t.map(() => null)), pred);
});

test('LLM grounding drops mentions that are not in the note', () => {
  const note = 'C/o cough x 3 days. No fever. Tab Azee 500 OD.';
  const { grounded: candidates, rejected } = ground(note, [
    { type: 'symptom', text: 'cough' },
    { type: 'symptom', text: 'fever' },
    { type: 'medication', text: 'Azee' },
    { type: 'symptom', text: 'chest pain radiating to jaw' },
    { type: 'medication', text: 'ee' }, // inside "Azee" only: not a whole word
  ]);
  assert.deepEqual(candidates.map((c) => c.surface), ['cough', 'fever', 'Azee']);
  for (const c of candidates) assert.equal(note.slice(c.start, c.end), c.surface);
  assert.ok(rejected.some((r) => r.text === 'chest pain radiating to jaw'));
});

test('generated summaries must cite given notes and add no numbers', () => {
  const snippets = ['Swelling of feet after amlodipine 5 mg.', 'Pedal oedema for 2 weeks.'];
  assert.equal(checkGrounded('Two notes describe feet swelling [1][2].', snippets).ok, true);
  assert.equal(checkGrounded('Feet swelling after amlodipine 10 mg [1].', snippets).ok, false);
  assert.equal(checkGrounded('Feet swelling is common.', snippets).ok, false);
  assert.equal(checkGrounded('See note [3].', snippets).ok, false);
});

test('ML and LLM agreement raises confidence; unknown mentions become unmapped', () => {
  const text = 'Fever x 2 days. Tab Dolo 650 TDS. Tab Xylofen 200 BD.';
  const rulesOnly = extractNote(text, { visitDate: VISIT });
  const extra = [
    { type: 'medication', start: text.indexOf('Dolo'), end: text.indexOf('Dolo') + 4, surface: 'Dolo', source: 'ml', score: 0.99 },
    { type: 'medication', start: text.indexOf('Dolo'), end: text.indexOf('Dolo') + 4, surface: 'Dolo', source: 'llm' },
    { type: 'medication', start: text.indexOf('Xylofen'), end: text.indexOf('Xylofen') + 7, surface: 'Xylofen', source: 'ml', score: 0.9 },
    { type: 'medication', start: text.indexOf('Tab'), end: text.indexOf('Tab') + 3, surface: 'Tab', source: 'ml', score: 0.6 },
  ];
  const merged = extractNote(text, { visitDate: VISIT, extraCandidates: extra });
  const p0 = rulesOnly.medications.find((m) => m.generic === 'paracetamol');
  const p1 = merged.medications.find((m) => m.generic === 'paracetamol');
  assert.deepEqual(p1.sources, ['rules', 'ml', 'llm']);
  assert.ok(p1.confidence > p0.confidence);
  assert.deepEqual(merged.unmapped.map((u) => u.surface), ['Xylofen']); // "Tab" is filtered as noise
});

test('learned vocabulary is used by the rules immediately', () => {
  const text = 'Tab Xylofen 200 BD x 5 days.';
  assert.equal(extractNote(text, { visitDate: VISIT }).medications.length, 0);
  setCustomLexicon([{ type: 'drug', alias: 'Xylofen', concept: { generic: 'ibuprofen' } }]);
  try {
    const m = extractNote(text, { visitDate: VISIT }).medications[0];
    assert.equal(m.generic, 'ibuprofen');
    assert.equal(m.dose, 200);
    assert.equal(normaliseMention('medication', 'xylofen').entry.generic, 'ibuprofen');
  } finally {
    setCustomLexicon([]);
  }
});

test('triage flags uncertain items and triageStats scores it', () => {
  const m = extractNote('Fever. ?Dengue. Tab Paracetamol BD. Allergic to penicillin.', { visitDate: VISIT });
  assert.equal(m.diagnoses[0].check, true);
  assert.ok(m.diagnoses[0].checkReasons.includes('provisional diagnosis'));
  assert.ok(m.allergies.every((a) => a.check));
  assert.ok(m.meta.toCheck >= 2);
  const verified = { ...m, diagnoses: [] }; // the doctor removed the flagged diagnosis
  const t = triageStats(m, verified);
  assert.equal(t.flagged - t.flaggedKept >= 1, true);
  assert.equal(t.autoPrecision, 1);
});

test('FHIR export has coded resources that reference each other', () => {
  const patient = { _id: 'p1', patientCode: 'P10001', name: 'Test Person', sex: 'F', dob: new Date('1980-01-01'), allergies: [] };
  const ex = extractNote('C/o fever. No cough. HbA1c 8.2%. BP 150/90. Dx: Type 2 DM. Tab Metformin 500 BD. Review after 1 month.', { visitDate: VISIT });
  const enc = { _id: 'e1', patientId: 'p1', visitDate: VISIT, status: 'verified', extraction: ex, rawNote: 'x' };
  const b = bundle([patientResource(patient), ...encounterResources(enc)]);
  assert.equal(b.resourceType, 'Bundle');
  const types = b.entry.map((e) => e.resource.resourceType);
  for (const t of ['Patient', 'Encounter', 'Condition', 'MedicationStatement', 'Observation', 'Appointment']) assert.ok(types.includes(t), t);
  const cond = b.entry.find((e) => e.resource.resourceType === 'Condition').resource;
  assert.deepEqual(cond.code.coding.map((c) => c.code), ['E11', '44054006']);
  const hba1c = b.entry.map((e) => e.resource).find((r) => r.code?.coding?.[0]?.code === '4548-4');
  assert.equal(hba1c.valueQuantity.value, 8.2);
  const cough = b.entry.map((e) => e.resource).find((r) => r.resourceType === 'Observation' && /cough/i.test(r.code?.text ?? ''));
  assert.equal(cough.valueBoolean, false);
});

test('assistant declines questions the notes cannot answer', () => {
  for (const q of ['what is the blood group of this patient', 'which ward is he in', 'consultation fee for today']) {
    assert.equal(understand(q).intent, 'unanswerable', q);
  }
  assert.notEqual(understand('patients on metformin').intent, 'unanswerable');
  assert.notEqual(understand('patients with fasting blood sugar above 200').intent, 'unanswerable');
});
