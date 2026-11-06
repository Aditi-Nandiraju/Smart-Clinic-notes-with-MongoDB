import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNote } from '../src/nlp/extractor.js';
import { splitSentences } from '../src/nlp/textUtils.js';
import { hashEmbed, cosine } from '../src/nlp/embedder.js';
import { parseTimeRange, extractSlots } from '../src/nlp/assistant/slots.js';
import { understand } from '../src/nlp/assistant/assistant.js';
import { validatePipeline, UnsafeQueryError } from '../src/nlp/assistant/validator.js';
import { buildQuery } from '../src/nlp/assistant/queryBuilder.js';
import { compareExtractions } from '../src/services/corrections.js';

const VISIT = new Date('2026-10-01T10:00:00Z');
const find = (list, pred) => list.find(pred);

test('sentence splitting keeps "Tab." and decimals together', () => {
  const s = splitSentences('Tab. Metformin 0.5 mg. Review in 2 wks.');
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'Tab. Metformin 0.5 mg.');
});

test('extracts the worked example from the report', () => {
  const x = extractNote('Pt c/o fatigue and polyuria x 3 wks. FBS 162. Dx T2DM. Start metformin 500 mg BD. Review in 4 wks with HbA1c.', { visitDate: VISIT });
  assert.deepEqual(x.symptoms.map((s) => s.term), ['fatigue', 'polyuria']);
  assert.equal(x.symptoms[0].durationDays, 21);
  assert.equal(x.diagnoses[0].code, 'E11');
  const m = x.medications[0];
  assert.deepEqual([m.generic, m.dose, m.unit, m.frequency, m.action], ['metformin', 500, 'mg', 'twice daily', 'start']);
  assert.equal(x.labs[0].test, 'fasting blood sugar');
  assert.equal(x.labs[0].flag, 'high');
  assert.equal(x.followUp.dueDate, '2026-10-29');
  assert.equal(x.followUp.purpose, 'with HbA1c');
});

test('every span points at the text it was extracted from', () => {
  const note = 'C/o headache x 2 days. BP 150/96. Imp: HTN. Tab Telma 40 OD. Review after 2 weeks.';
  const x = extractNote(note, { visitDate: VISIT });
  assert.equal(note.slice(...x.symptoms[0].span), 'headache');
  assert.equal(note.slice(...x.diagnoses[0].span), 'HTN');
  assert.match(note.slice(...x.medications[0].span), /^Tab Telma 40 OD/);
});

test('negation is scoped to its clause', () => {
  const x = extractNote('No fever, cough or vomiting but c/o headache.', { visitDate: VISIT });
  assert.equal(find(x.symptoms, (s) => s.term === 'fever').negated, true);
  assert.equal(find(x.symptoms, (s) => s.term === 'vomiting').negated, true);
  assert.equal(find(x.symptoms, (s) => s.term === 'headache').negated, false);
});

test('uncertainty, ruled-out and known conditions', () => {
  const x = extractNote('K/c/o HTN. ?Dengue. Typhoid ruled out.', { visitDate: VISIT });
  assert.equal(find(x.diagnoses, (d) => d.code === 'I10').context, 'known');
  assert.equal(find(x.diagnoses, (d) => d.code === 'A90').certainty, 'provisional');
  assert.equal(find(x.diagnoses, (d) => d.code === 'A01.0').certainty, 'ruled_out');
});

test('brand names, dose changes, stops and allergies', () => {
  const x = extractNote('Allergic to penicillin. Increase Glycomet to 1000 mg BD. Stop glimepiride. Add Tab Januvia 100 mg OD.', { visitDate: VISIT });
  assert.deepEqual(x.allergies.map((a) => a.substance), ['penicillin']);
  const met = find(x.medications, (m) => m.generic === 'metformin');
  assert.deepEqual([met.action, met.dose], ['increase', 1000]);
  assert.equal(find(x.medications, (m) => m.generic === 'glimepiride').action, 'stop');
  assert.equal(find(x.medications, (m) => m.generic === 'sitagliptin').action, 'start');
});

test('typos are matched and flagged for review', () => {
  const x = extractNote('Pt c/o vomitting. Tab Metformn 500 mg BD.', { visitDate: VISIT });
  assert.ok(find(x.symptoms, (s) => s.term === 'vomiting' && s.fuzzy));
  assert.ok(find(x.medications, (m) => m.generic === 'metformin'));
  assert.ok(x.meta.warnings.some((w) => w.includes('possible typo')));
});

test('ambiguous short words are not drugs or diagnoses without context', () => {
  const x = extractNote('Age 45. Pan with hot water. Came alone.', { visitDate: VISIT });
  assert.equal(x.medications.length, 0);
  assert.equal(x.diagnoses.length, 0);
});

test('follow-up shorthand: 1/52, explicit date and SOS', () => {
  assert.equal(extractNote('f/u 1/52.', { visitDate: VISIT }).followUp.dueDate, '2026-10-08');
  assert.equal(extractNote('Review on 15/10/2026.', { visitDate: VISIT }).followUp.dueDate, '2026-10-15');
  const sos = extractNote('Review SOS.', { visitDate: VISIT }).followUp;
  assert.equal(sos.asNeeded, true);
  assert.equal(sos.dueDate, null);
});

test('embeddings: paraphrase is closer than an unrelated or negated note', () => {
  const q = hashEmbed('shortness of breath on climbing stairs');
  const para = cosine(q, hashEmbed('C/o SOB on exertion x 2 wks'));
  const neg = cosine(q, hashEmbed('No SOB. Knee pain.'));
  const other = cosine(q, hashEmbed('Itchy rash on forearm'));
  assert.ok(para > neg && para > other, `${para} ${neg} ${other}`);
});

test('time ranges', () => {
  const now = new Date('2026-10-28T09:00:00Z');
  const m = parseTimeRange('this month', now);
  assert.equal(m.from.toISOString().slice(0, 10), '2026-10-01');
  assert.equal(m.to.toISOString().slice(0, 10), '2026-11-01');
  assert.equal(parseTimeRange('last week', now).from.toISOString().slice(0, 10), '2026-10-19');
  assert.equal(parseTimeRange('in september', now).label, 'september 2026');
});

test('assistant: intent + slots for the headline question', () => {
  const u = understand('Which patients on metformin missed follow-ups this month?', { now: new Date('2026-10-28') });
  assert.equal(u.intent, 'overdue_followups');
  assert.deepEqual(u.slots.drugs, ['metformin']);
  assert.equal(u.slots.time.label, 'this month');
});

test('assistant: safety rules override the classifier', () => {
  assert.equal(understand('delete all patients').intent, 'unsafe_action');
  assert.equal(understand('what dose of metformin should I give').intent, 'clinical_advice');
  assert.equal(understand('send me the phone numbers of overdue patients').intent, 'unsafe_action');
});

test('slots: lab thresholds and patient names', () => {
  const { slots } = extractSlots('patients with HbA1c above 8.5', {});
  assert.deepEqual([slots.lab.test, slots.lab.op, slots.lab.value], ['HbA1c', '$gt', 8.5]);
  const p = extractSlots('summarise ravi kumaar', { patients: [{ _id: 'a', name: 'Ravi Kumar' }] });
  assert.equal(p.slots.patient.name, 'Ravi Kumar');
});

test('validator blocks writes, code execution and secrets', () => {
  const bad = [
    ['encounters', [{ $match: { status: 'verified' } }, { $out: 'x' }]],
    ['patients', [{ $match: { $where: '1' } }]],
    ['patients', [{ $match: {} }, { $project: { phoneEnc: 1 } }]],
    ['users', [{ $match: {} }]],
    ['encounters', [{ $match: {} }]],
  ];
  for (const [c, p] of bad) assert.throws(() => validatePipeline(c, p), UnsafeQueryError);
});

test('every builder pipeline passes the validator', () => {
  const { slots } = extractSlots('patients on metformin with diabetes this month', {});
  for (const intent of ['overdue_followups', 'upcoming_followups', 'patients_on_drug', 'patients_with_diagnosis', 'top_diagnoses', 'top_medications', 'visit_stats']) {
    const b = buildQuery(intent, slots, { now: new Date() });
    assert.doesNotThrow(() => validatePipeline(b.collection, b.pipeline), intent);
  }
});

test('corrections: precision and recall against the verified version', () => {
  const model = { symptoms: [{ term: 'fever', negated: false }, { term: 'cough', negated: false }], diagnoses: [], medications: [], labs: [], vitals: [] };
  const verified = { symptoms: [{ term: 'fever', negated: false }, { term: 'cough', negated: true }], diagnoses: [], medications: [], labs: [], vitals: [] };
  const c = compareExtractions(model, verified);
  assert.equal(c.fields.symptoms.tp, 1);
  assert.equal(c.fields.symptoms.fp, 1);
  assert.equal(c.fields.symptoms.fn, 1);
  assert.equal(c.edited, true);
});
