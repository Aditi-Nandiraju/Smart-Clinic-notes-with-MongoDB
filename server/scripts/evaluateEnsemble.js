// Evaluation of the changes over prior work. No database needed.
//
//   node scripts/evaluateEnsemble.js [--llm]
//
// A. Rules vs rules + local ML tagger (and + Ollama LLM with --llm) on the
//    generated, edge-case and blind test sets.
// B. Generalisation: one third of brand names are removed from the lexicon.
//    Can the ML tagger still find those mentions from context?
// C. Vocabulary learning: a simulated doctor maps unknown mentions batch by
//    batch; how fast does medication recall recover?
// D. Review triage: are auto-accepted items safe, and how many are there?
// E. Abstention: does the assistant decline questions the notes cannot answer?
// Writes EVALUATION-ENSEMBLE.md and eval-ensemble.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNote, setCustomLexicon, lexiconSpans } from '../src/nlp/extractor.js';
import { DRUGS } from '../src/nlp/lexicon/drugs.js';
import { SequenceTagger, tokenize, spansToTags } from '../src/nlp/ml/tagger.js';
import { goldSpans } from '../src/nlp/ml/nerService.js';
import { triageStats } from '../src/services/corrections.js';
import { rng, generatePatients, scheduleVisits, writeVisit } from './synth/generator.js';
import { mergeWithTruth } from './synth/review.js';
import { EDGE_CASES, EDGE_VISIT_DATE } from './data/edgeCases.js';
import { BLIND_CASES, BLIND_VISIT_DATE } from './data/blindCases.js';
import { ASSISTANT_EVAL } from './data/assistantEval.js';
import { understand, trainAssistant } from '../src/nlp/assistant/assistant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USE_LLM = process.argv.includes('--llm');
const pct = (x) => (x == null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const prf = ({ tp, fp, fn }) => {
  const p = tp + fp ? tp / (tp + fp) : 1; const r = tp + fn ? tp / (tp + fn) : 1;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, tp, fp, fn };
};

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------
function generate(seed, nPatients, limit) {
  const r = rng(seed); const today = new Date();
  const people = generatePatients(r, nPatients, today);
  return scheduleVisits(r, people, new Date(today.getTime() - 240 * 864e5), today).slice(0, limit)
    .map((v) => { const w = writeVisit(r, v.p, v.date, v.kind); return { text: w.text, gt: w.gt, visitDate: v.date }; });
}
const compactGt = (gt) => ({
  symptoms: gt.symptoms.map(([term, negated]) => ({ term, negated })),
  diagnoses: gt.diagnoses.map(([code, certainty]) => ({ code, certainty })),
  medications: gt.medications.map(([generic, dose, frequency, action]) => ({ generic, dose, frequency, action })),
  labs: (gt.labs ?? []).map(([test, value]) => ({ test, value })),
  vitals: (gt.vitals ?? []).map(([name, value]) => ({ name, value })),
});
const TRAIN = generate(7, 500, 1600); // same seed as the demo database
const TEST = generate(1001, 220, 400); // different seed: unseen patients and notes
const EDGE = EDGE_CASES.map((e) => ({ text: e.text, gt: compactGt(e.gt), visitDate: new Date(EDGE_VISIT_DATE) }));
const BLIND = BLIND_CASES.map((e) => ({ text: e.text, gt: compactGt(e.gt), visitDate: new Date(BLIND_VISIT_DATE) }));

// ---------------------------------------------------------------------------
// ML tagger trained the same way the server does: on verified notes
// ---------------------------------------------------------------------------
const lexFn = (text) => { const spans = lexiconSpans(text); return (tokens) => spansToTags(tokens, spans).map((t) => (t === 'O' ? null : t)); };
function trainTagger(notes) {
  const examples = [];
  for (const n of notes) {
    const verified = mergeWithTruth(extractNote(n.text, { visitDate: n.visitDate }), n.gt);
    const gold = goldSpans(verified);
    if (!gold) continue;
    const tokens = tokenize(n.text);
    examples.push({ tokens, tags: spansToTags(tokens, gold), lex: lexFn(n.text)(tokens) });
  }
  return { model: new SequenceTagger().train(examples, { epochs: 8 }), used: examples.length };
}
const mlCands = (model, text) => model.predict(text, lexFn(text)).filter((c) => c.surface.trim().length > 1);

let llmCandidates = null; let llmInfo = 'not run (pass --llm with Ollama running)';
if (USE_LLM) {
  const ol = await import('../src/nlp/llm/ollama.js');
  const st = await ol.ollamaStatus(true);
  if (st.reachable && st.modelAvailable) {
    llmCandidates = (await import('../src/nlp/llm/llmExtractor.js')).llmCandidates;
    llmInfo = `${st.model} via Ollama`;
  } else llmInfo = `requested but Ollama is not reachable or ${st.model} is not pulled (${st.error ?? 'model missing'})`;
}

// ---------------------------------------------------------------------------
// detection scoring (symptoms, diagnoses, medications)
// ---------------------------------------------------------------------------
async function score(set, { ml = null, llm = false } = {}) {
  const acc = { symptoms: { tp: 0, fp: 0, fn: 0 }, diagnoses: { tp: 0, fp: 0, fn: 0 }, medications: { tp: 0, fp: 0, fn: 0 } };
  let unmapped = 0;
  for (const n of set) {
    const extra = [];
    if (ml) extra.push(...mlCands(ml, n.text));
    if (llm && llmCandidates) extra.push(...(await llmCandidates(n.text)).candidates);
    const m = extractNote(n.text, { visitDate: n.visitDate, extraCandidates: extra });
    unmapped += m.unmapped.length;
    const pairs = {
      symptoms: [m.symptoms.map((x) => `${x.term}|${x.negated}`), n.gt.symptoms.map((x) => `${x.term}|${x.negated}`)],
      diagnoses: [m.diagnoses.filter((d) => d.certainty !== 'ruled_out' || n.gt.diagnoses.some((g) => g.code === d.code)).map((d) => d.code), n.gt.diagnoses.map((d) => d.code)],
      medications: [m.medications.filter((x) => !x.negated).map((x) => x.generic), n.gt.medications.map((x) => x.generic)],
    };
    for (const [k, [a, b]] of Object.entries(pairs)) {
      const A = new Set(a); const B = new Set(b);
      for (const x of A) (B.has(x) ? acc[k].tp++ : acc[k].fp++);
      for (const x of B) if (!A.has(x)) acc[k].fn++;
    }
  }
  return { symptoms: prf(acc.symptoms), diagnoses: prf(acc.diagnoses), medications: prf(acc.medications), unmappedPerNote: unmapped / set.length };
}

console.log('[A] training ML tagger on', TRAIN.length, 'generated notes');
const full = trainTagger(TRAIN);
const A = {};
for (const [name, set] of [['Generated (400, unseen seed)', TEST], ['Edge cases (hand-written)', EDGE], ['Blind set (hand-written)', BLIND]]) {
  A[name] = { rules: await score(set), rulesMl: await score(set, { ml: full.model }) };
  if (llmCandidates) A[name].rulesMlLlm = await score(set, { ml: full.model, llm: true });
}

// ---------------------------------------------------------------------------
// B. brands the lexicon has never seen
// ---------------------------------------------------------------------------
const brandAliases = DRUGS.flatMap((d) => d.aliases.filter((a) => a !== d.generic && a.length > 3 && !['acetaminophen', 'albuterol'].includes(a)).map((a) => ({ alias: a, generic: d.generic })));
const HELD = brandAliases.filter((_, i) => i % 3 === 1);
const HELD_SET = new Set(HELD.map((h) => h.alias));
const heldRe = new RegExp(`\\b(${HELD.map((h) => h.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
const heldMentions = (text) => [...text.matchAll(heldRe)].map((m) => ({ alias: m[1].toLowerCase(), start: m.index, end: m.index + m[1].length }));

console.log('[B] training ML tagger without', HELD.length, 'brand names');
const trainNoHeld = TRAIN.filter((n) => !heldMentions(n.text).length);
setCustomLexicon([], { exclude: HELD_SET });
const reducedRetrained = trainTagger(trainNoHeld);
const testHeld = TEST.filter((n) => heldMentions(n.text).length);
let total = 0; let rulesFound = 0; let mlFound = 0; let mlMapped = 0;
for (const n of testHeld) {
  const hm = heldMentions(n.text);
  total += hm.length;
  const rules = extractNote(n.text, { visitDate: n.visitDate });
  const ml2 = extractNote(n.text, { visitDate: n.visitDate, extraCandidates: mlCands(reducedRetrained.model, n.text) });
  const covered = (ex, h) => [...ex.medications.map((x) => x.nameSpan ?? x.span), ...ex.unmapped.map((u) => u.span)].some((s) => s && s[0] < h.end && h.start < s[1]);
  for (const h of hm) {
    if (covered(rules, h)) rulesFound++;
    if (covered(ml2, h)) mlFound++;
    if (ml2.medications.some((x) => (x.nameSpan ?? x.span)?.[0] === h.start)) mlMapped++;
  }
}
const B = { heldOutBrands: HELD.length, testNotes: testHeld.length, mentions: total, rulesFound, mlFound, trainNotes: reducedRetrained.used, mlMappedByFuzzy: mlMapped, scoreReduced: { rules: await score(TEST), rulesMl: await score(TEST, { ml: reducedRetrained.model }) } };

// ---------------------------------------------------------------------------
// C. learning curve: a simulated doctor maps unknown mentions as notes arrive
// ---------------------------------------------------------------------------
console.log('[C] vocabulary learning curve');
function curve(useMl) {
  const learned = []; const rows = []; let suggested = 0; let manual = 0;
  setCustomLexicon([], { exclude: HELD_SET });
  for (let b = 0; b < 8; b++) {
    const batch = TEST.slice(b * 50, b * 50 + 50);
    let tp = 0; let fn = 0;
    for (const n of batch) {
      const m = extractNote(n.text, { visitDate: n.visitDate, extraCandidates: useMl ? mlCands(reducedRetrained.model, n.text) : [] });
      const found = new Set(m.medications.filter((x) => !x.negated).map((x) => x.generic));
      for (const g of n.gt.medications) (found.has(g.generic) ? tp++ : fn++);
      // the doctor fixes the note; each brand they map is learned
      for (const h of heldMentions(n.text)) {
        if (learned.some((l) => l.alias === h.alias)) continue;
        const generic = HELD.find((x) => x.alias === h.alias).generic;
        if (!n.gt.medications.some((g) => g.generic === generic)) continue;
        const offered = m.unmapped.some((u) => u.span[0] < h.end && h.start < u.span[1]);
        if (offered) suggested++; else manual++;
        learned.push({ type: 'drug', alias: h.alias, concept: { generic } });
      }
    }
    rows.push({ batch: b + 1, recall: tp / Math.max(1, tp + fn), learned: learned.length });
    setCustomLexicon(learned, { exclude: HELD_SET });
  }
  return { rows, suggested, manual };
}
const C = { rules: curve(false), rulesMl: curve(true) };
setCustomLexicon([]);

// ---------------------------------------------------------------------------
// D. triage on the unseen generated notes
// ---------------------------------------------------------------------------
console.log('[D] review triage');
const tri = { autoAccepted: 0, autoKept: 0, flagged: 0, flaggedKept: 0, notesNoCheck: 0, errorsTotal: 0, errorsFlagged: 0 };
for (const n of TEST) {
  const m = extractNote(n.text, { visitDate: n.visitDate, extraCandidates: mlCands(full.model, n.text) });
  const t = triageStats(m, mergeWithTruth(m, n.gt));
  for (const k of ['autoAccepted', 'autoKept', 'flagged', 'flaggedKept']) tri[k] += t[k];
  tri.errorsTotal += (t.autoAccepted - t.autoKept) + (t.flagged - t.flaggedKept);
  tri.errorsFlagged += t.flagged - t.flaggedKept;
  if (!m.meta.toCheck) tri.notesNoCheck++;
}
// the same on the hand-written notes, where the extractor makes more mistakes
const triHand = { autoAccepted: 0, autoKept: 0, flagged: 0, flaggedKept: 0, errorsTotal: 0, errorsFlagged: 0 };
for (const n of [...EDGE, ...BLIND]) {
  const m = extractNote(n.text, { visitDate: n.visitDate, extraCandidates: mlCands(full.model, n.text) });
  const t = triageStats(m, mergeWithTruth(m, n.gt));
  for (const k of ['autoAccepted', 'autoKept', 'flagged', 'flaggedKept']) triHand[k] += t[k];
  triHand.errorsTotal += (t.autoAccepted - t.autoKept) + (t.flagged - t.flaggedKept);
  triHand.errorsFlagged += t.flagged - t.flaggedKept;
}
const D = { hand: triHand, ...tri, notes: TEST.length, autoShare: tri.autoAccepted / (tri.autoAccepted + tri.flagged), autoPrecision: tri.autoKept / tri.autoAccepted, flaggedPrecision: tri.flaggedKept / tri.flagged, errorRecall: tri.errorsTotal ? tri.errorsFlagged / tri.errorsTotal : null };

// ---------------------------------------------------------------------------
// E. abstention
// ---------------------------------------------------------------------------
console.log('[E] abstention');
trainAssistant();
const evalPatients = [{ _id: 'x1', name: 'Meena Pillai' }, { _id: 'x2', name: 'Joseph Thomas' }, { _id: 'x3', name: 'Farhan Qureshi' }];
const DECLINE = new Set(['unanswerable', 'clinical_advice', 'unsafe_action']);
let unansTotal = 0; let unansDeclined = 0; let ansTotal = 0; let ansDeclined = 0; const abstainErrors = [];
ASSISTANT_EVAL.forEach((t, i) => {
  const q = t.q.replace('PATIENT', evalPatients[i % 3].name);
  const u = understand(q, { patients: evalPatients });
  if (t.intent === 'unanswerable') {
    unansTotal++;
    if (DECLINE.has(u.intent)) unansDeclined++; else abstainErrors.push(`answered "${q}" as ${u.intent}`);
  } else if (!DECLINE.has(t.intent)) {
    ansTotal++;
    if (DECLINE.has(u.intent)) { ansDeclined++; abstainErrors.push(`declined answerable "${q}" (${u.intent})`); }
  }
});
const E = { unanswerable: unansTotal, declined: unansDeclined, answerable: ansTotal, falselyDeclined: ansDeclined, errors: abstainErrors };

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const cols = [['rules', 'Rules only'], ['rulesMl', 'Rules + ML tagger'], ...(llmCandidates ? [['rulesMlLlm', 'Rules + ML + LLM']] : [])];
const tableA = Object.entries(A).map(([set, r]) => `**${set}**\n\n| Field | ${cols.map((c) => c[1]).join(' | ')} |\n|---|${cols.map(() => '---').join('|')}|\n${['symptoms', 'diagnoses', 'medications'].map((f) => `| ${f} F1 (P / R) | ${cols.map(([k]) => `${pct(r[k][f].f1)} (${pct(r[k][f].precision)} / ${pct(r[k][f].recall)})`).join(' | ')} |`).join('\n')}\n| unmapped suggestions per note | ${cols.map(([k]) => r[k].unmappedPerNote.toFixed(2)).join(' | ')} |`).join('\n\n');

const report = `# Evaluation of the ensemble, learning and triage changes

Generated by \`node scripts/evaluateEnsemble.js${USE_LLM ? ' --llm' : ''}\` on ${new Date().toISOString().slice(0, 10)}. All notes are synthetic or hand-written; no real patient data.
LLM: ${llmInfo}.

## A. Rules vs rules + local ML tagger

The ML tagger (averaged structured perceptron, BIO tags) was trained on ${full.used} verified generated notes. Detection scores (a mention counts if the right concept is found; symptoms must also have the right negation).

${tableA}

On notes written in the same style as the training data the rules are already near their ceiling, so the tagger's job is mostly to confirm rule findings (raising confidence) and to propose mentions the lexicon does not know (shown as *unmapped suggestions* for the doctor). Section B tests that second job directly.

## B. Brand names the lexicon has never seen

${B.heldOutBrands} of ${brandAliases.length} brand names were removed from the lexicon. The tagger was trained only on notes that never contain them. Test: ${B.mentions} mentions of those brands in ${B.testNotes} unseen notes.

| | Mentions found | Share |
|---|---|---|
| Rules (reduced lexicon) | ${B.rulesFound} | ${pct(B.rulesFound / B.mentions)} |
| Rules + ML tagger (trained on ${B.trainNotes} notes without these brands) | ${B.mlFound} | ${pct(B.mlFound / B.mentions)} |

A mention "found" by the tagger is either mapped to a drug (by fuzzy match, ${B.mlMappedByFuzzy} cases) or offered to the doctor as an unmapped medicine to map in one click. Rules find a few only through fuzzy matching to a similar known brand.

Whole test set with the reduced lexicon — medications F1: rules ${pct(B.scoreReduced.rules.medications.f1)}, rules + ML ${pct(B.scoreReduced.rulesMl.medications.f1)} (unmapped mentions do not count as found here, because they still need the doctor to say which drug they are).

## C. Learning vocabulary from corrections

Starting from the reduced lexicon, notes arrive in batches of 50. After each batch the simulated doctor corrects the notes and every brand they map is saved to the vocabulary (as \`POST /api/encounters/:id/verify\` does with \`learn: true\`). Medication recall on each new batch, before that batch's corrections:

| Batch | Rules: recall | Rules: aliases learned | Rules + ML: recall | Rules + ML: aliases learned |
|---|---|---|---|---|
${C.rules.rows.map((r, i) => `| ${r.batch} | ${pct(r.recall)} | ${r.learned} | ${pct(C.rulesMl.rows[i].recall)} | ${C.rulesMl.rows[i].learned} |`).join('\n')}

Both arms learn the same aliases (the doctor corrects every note either way), so recall recovers at the same rate. The difference is the doctor's effort: with the ML tagger, ${C.rulesMl.suggested} of ${C.rulesMl.suggested + C.rulesMl.manual} new brands were already highlighted as unmapped suggestions and needed only a pick from a list; with rules only, all ${C.rules.suggested + C.rules.manual} had to be found in the text and selected by hand.

## D. Confidence-based review triage

Items with confidence below 0.85, or with a fuzzy match, conflict, missing dose or unusual value, are flagged "check"; the rest are auto-accepted (still visible, but the doctor can skip them). ${D.notes} unseen generated notes, rules + ML:

| Measure | Generated notes (${D.notes}) | Hand-written edge + blind (${EDGE.length + BLIND.length}) |
|---|---|---|
| Items auto-accepted | ${D.autoAccepted} of ${D.autoAccepted + D.flagged} (${pct(D.autoShare)}) | ${D.hand.autoAccepted} of ${D.hand.autoAccepted + D.hand.flagged} (${pct(D.hand.autoAccepted / (D.hand.autoAccepted + D.hand.flagged))}) |
| Auto-accepted items the doctor kept unchanged | ${pct(D.autoPrecision)} | ${pct(D.hand.autoKept / D.hand.autoAccepted)} |
| Flagged items the doctor kept unchanged | ${pct(D.flaggedPrecision)} | ${pct(D.hand.flaggedKept / Math.max(1, D.hand.flagged))} |
| Extractor errors that were flagged | ${D.errorsFlagged} of ${D.errorsTotal} (${pct(D.errorRecall)}) | ${D.hand.errorsFlagged} of ${D.hand.errorsTotal} (${pct(D.hand.errorsTotal ? D.hand.errorsFlagged / D.hand.errorsTotal : null)}) |
| Notes with nothing to check | ${D.notesNoCheck} of ${D.notes} | |

"Errors" here are wrong items the extractor produced (an item the doctor changed or removed); items it missed entirely cannot be flagged and are covered by recall in section A.

The live system measures the same numbers on every real verification (\`review.autoPrecision\` on the encounter) together with the review time in seconds, shown on the Analytics page.

## E. Abstention on questions the notes cannot answer

| | Count | Declined |
|---|---|---|
| Unanswerable questions (blood group, ward, billing...) | ${E.unanswerable} | ${E.declined} (${pct(E.declined / Math.max(1, E.unanswerable))}) |
| Answerable questions | ${E.answerable} | ${E.falselyDeclined} (${pct(E.falselyDeclined / Math.max(1, E.answerable))}) |

${E.errors.length ? `Errors:\n\n${E.errors.map((e) => `- ${e}`).join('\n')}` : 'No errors.'}

## Limits

- The generated notes come from the same templates as the training notes, so section A's generated-set numbers are optimistic; the hand-written edge and blind sets are the better estimate, and they are small (${EDGE.length} and ${BLIND.length} notes).
- The LLM column ${llmCandidates ? `was measured with ${llmInfo}` : 'was not measured here. The LLM code paths were tested against scripts/mockOllama.js, a heuristic stand-in, which says nothing about real model quality. Run `node scripts/evaluateEnsemble.js --llm` with Ollama running to fill it in'}.
- The "not recorded in notes" rule list in the assistant was written while looking at section E's questions, so 100% there is optimistic; a fresh set of out-of-scope questions is the honest test.
- The simulated doctor in C and D is perfect; real reviewers disagree with each other (see scripts/agreement.js and docs/ANNOTATION_GUIDE.md for measuring that).
`;

fs.writeFileSync(path.join(__dirname, '..', 'EVALUATION-ENSEMBLE.md'), report);
fs.writeFileSync(path.join(__dirname, '..', 'eval-ensemble.json'), JSON.stringify({ A, B, C, D, E, llm: llmInfo }, null, 2));
console.log(report);
