// Inter-annotator agreement for a real-world blind set.
//
//   node scripts/agreement.js annotatorA.json annotatorB.json [--system]
//
// Each file is a list of notes: [{ "id": "n1", "text": "...", "items": [
//   { "type": "symptom"|"diagnosis"|"medication", "start": 0, "end": 5,
//     "concept": "fever" | "E11" | "metformin",
//     "negated": false, "certainty": "confirmed", "action": "start" } ] }]
// (see docs/ANNOTATION_GUIDE.md). With --system the second file is ignored and
// the extractor's output on each note's text is compared with the first file.
//
// Reports, per entity type:
//  - span agreement (pairwise F1, exact and overlapping spans): for spans,
//    F1 is the usual agreement measure because there is no fixed set of
//    "non-entities" to compute kappa over
//  - concept agreement on overlapping spans
//  - Cohen's kappa for each attribute (negation, certainty, action) on the
//    spans both annotators marked
import fs from 'node:fs';
import { extractNote } from '../src/nlp/extractor.js';

const [fa, fb] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SYSTEM = process.argv.includes('--system');
if (!fa || (!fb && !SYSTEM)) {
  console.error('usage: node scripts/agreement.js annotatorA.json annotatorB.json | annotatorA.json --system');
  process.exit(1);
}
const A = JSON.parse(fs.readFileSync(fa, 'utf8'));

function systemAnnotations(notes) {
  return notes.map((n) => {
    const x = extractNote(n.text, { visitDate: n.visitDate ? new Date(n.visitDate) : new Date() });
    return {
      id: n.id,
      items: [
        ...x.symptoms.filter((s) => s.span).map((s) => ({ type: 'symptom', start: s.span[0], end: s.span[1], concept: s.term, negated: s.negated })),
        ...x.diagnoses.filter((d) => d.span).map((d) => ({ type: 'diagnosis', start: d.span[0], end: d.span[1], concept: d.code, certainty: d.certainty })),
        ...x.medications.filter((m) => m.nameSpan ?? m.span).map((m) => ({ type: 'medication', start: (m.nameSpan ?? m.span)[0], end: (m.nameSpan ?? m.span)[1], concept: m.generic, action: m.action, negated: m.negated })),
      ],
    };
  });
}
const B = SYSTEM ? systemAnnotations(A) : JSON.parse(fs.readFileSync(fb, 'utf8'));
const byId = new Map(B.map((n) => [n.id, n]));

export function cohensKappa(pairs) {
  if (!pairs.length) return null;
  const labels = [...new Set(pairs.flat().map(String))];
  const n = pairs.length;
  const po = pairs.filter(([a, b]) => String(a) === String(b)).length / n;
  let pe = 0;
  for (const l of labels) pe += (pairs.filter(([a]) => String(a) === l).length / n) * (pairs.filter(([, b]) => String(b) === l).length / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

const TYPES = ['symptom', 'diagnosis', 'medication'];
const ATTRS = { symptom: ['negated'], diagnosis: ['certainty'], medication: ['action'] };
const res = Object.fromEntries(TYPES.map((t) => [t, { exact: { tp: 0, a: 0, b: 0 }, overlap: { tp: 0 }, concept: { same: 0, n: 0 }, attrs: Object.fromEntries(ATTRS[t].map((k) => [k, []])) }]));
const disagreements = [];
let missing = 0;
for (const na of A) {
  const nb = byId.get(na.id);
  if (!nb) { missing++; continue; }
  for (const t of TYPES) {
    const ia = (na.items ?? []).filter((i) => i.type === t); const ib = (nb.items ?? []).filter((i) => i.type === t);
    const r = res[t];
    r.exact.a += ia.length; r.exact.b += ib.length;
    const usedB = new Set();
    for (const x of ia) {
      if (ib.some((y) => y.start === x.start && y.end === x.end)) r.exact.tp++;
      const j = ib.findIndex((y, k) => !usedB.has(k) && y.start < x.end && x.start < y.end);
      if (j < 0) { disagreements.push({ id: na.id, type: t, onlyIn: 'A', text: na.text?.slice(x.start, x.end) }); continue; }
      usedB.add(j); r.overlap.tp++;
      const y = ib[j];
      r.concept.n++; if (String(x.concept).toLowerCase() === String(y.concept).toLowerCase()) r.concept.same++; else disagreements.push({ id: na.id, type: t, concept: [x.concept, y.concept] });
      for (const k of ATTRS[t]) r.attrs[k].push([x[k] ?? null, y[k] ?? null]);
    }
    ib.forEach((y, k) => { if (!usedB.has(k)) disagreements.push({ id: na.id, type: t, onlyIn: 'B', text: na.text?.slice(y.start, y.end) }); });
  }
}

const f1 = (tp, a, b) => (a + b ? (2 * tp) / (a + b) : 1);
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.log(`Notes compared: ${A.length - missing}${missing ? ` (${missing} missing from the second file)` : ''}; ${SYSTEM ? 'annotator vs system' : 'annotator A vs annotator B'}\n`);
console.log('| Type | Items A / B | Span F1 (exact) | Span F1 (overlap) | Same concept | Attribute kappa |');
console.log('|---|---|---|---|---|---|');
for (const t of TYPES) {
  const r = res[t];
  const kap = ATTRS[t].map((k) => `${k} ${r.attrs[k].length ? cohensKappa(r.attrs[k]).toFixed(2) : 'n/a'}`).join(', ');
  console.log(`| ${t} | ${r.exact.a} / ${r.exact.b} | ${pct(f1(r.exact.tp, r.exact.a, r.exact.b))} | ${pct(f1(r.overlap.tp, r.exact.a, r.exact.b))} | ${pct(r.concept.n ? r.concept.same / r.concept.n : null)} | ${kap} |`);
}
console.log('\nKappa guide (Landis & Koch): < 0.40 poor-fair, 0.41-0.60 moderate, 0.61-0.80 substantial, > 0.80 almost perfect.');
if (disagreements.length) {
  console.log(`\nFirst disagreements to adjudicate (${disagreements.length} total):`);
  for (const d of disagreements.slice(0, 15)) console.log(' -', JSON.stringify(d));
}
