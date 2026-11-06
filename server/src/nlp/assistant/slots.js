// Slot filling for assistant questions: finds drugs, drug classes, diagnoses,
// symptoms, lab thresholds, time ranges, patient names, limits and count/list
// wording, and returns the question with those spans masked as slot tokens
// for the intent classifier.

import natural from 'natural';
import { DRUGS } from '../lexicon/drugs.js';
import { DIAGNOSES, SYMPTOMS, CONTEXT_ONLY_DX_ALIASES } from '../lexicon/conditions.js';
import { LABS } from '../lexicon/measurements.js';
import { compileAliasRegex, parseNumberWord } from '../textUtils.js';

const drugByAlias = new Map();
for (const d of DRUGS) for (const a of d.aliases) drugByAlias.set(a, d);
const dxByAlias = new Map();
for (const d of DIAGNOSES) for (const a of d.aliases) dxByAlias.set(a, d);
const sxByAlias = new Map();
for (const s of SYMPTOMS) for (const a of s.aliases) sxByAlias.set(a, s);
const labByAlias = new Map();
for (const l of LABS) for (const a of l.aliases) labByAlias.set(a, l);

const DRUG_RE = compileAliasRegex([...drugByAlias.keys()].filter((a) => a.length > 3 || ['ors', 'pcm'].includes(a)));
const DX_RE = compileAliasRegex([...dxByAlias.keys()]);
const SX_RE = compileAliasRegex([...sxByAlias.keys()]);
const LAB_RE = compileAliasRegex([...labByAlias.keys()]);

export const DRUG_CLASS_WORDS = [
  { re: /\bstatins?\b/i, cls: 'statin' },
  { re: /\bantibiotics?\b|\babx\b/i, cls: 'antibiotic' },
  { re: /\binsulins?\b/i, cls: 'insulin' },
  { re: /\bbeta[- ]?blockers?\b/i, cls: 'beta blocker' },
  { re: /\bppis?\b|\bproton pump inhibitors?\b/i, cls: 'proton pump inhibitor' },
  { re: /\bssris?\b/i, cls: 'SSRI' },
  { re: /\bantihistamines?\b/i, cls: 'antihistamine' },
  { re: /\bnsaids?\b|\bpainkillers?\b/i, cls: 'NSAID' },
  { re: /\bsulfonylureas?\b/i, cls: 'sulfonylurea' },
  { re: /\barbs?\b|\bangiotensin receptor blockers?\b/i, cls: 'ARB' },
  { re: /\bace inhibitors?\b/i, cls: 'ACE inhibitor' },
  { re: /\bdiuretics?\b/i, cls: 'diuretic' },
  { re: /\bbenzodiazepines?\b/i, cls: 'benzodiazepine' },
  { re: /\bantiplatelets?\b/i, cls: 'antiplatelet' },
  { re: /\bsglt2 inhibitors?\b|\bgliflozins?\b/i, cls: 'SGLT2 inhibitor' },
  { re: /\bdpp-?4 inhibitors?\b|\bgliptins?\b/i, cls: 'DPP-4 inhibitor' },
  { re: /\bcalcium channel blockers?\b|\bccbs?\b/i, cls: 'calcium channel blocker' },
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = new RegExp(`\\b(?:in|for|during|of|since)?\\s*(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\\s+(\\d{4}))?\\b`, 'i');

const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const startOfDay = (d) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

/** Parse a relative or named time range. `to` is exclusive. */
export function parseTimeRange(text, now = new Date()) {
  const q = text.toLowerCase();
  const today = startOfDay(now);
  const y = today.getUTCFullYear(); const m = today.getUTCMonth();
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = addDays(today, -dow);
  const qStart = utc(y, Math.floor(m / 3) * 3, 1);
  const tests = [
    [/\btoday\b/, () => ({ from: today, to: addDays(today, 1), label: 'today' })],
    [/\byesterday\b/, () => ({ from: addDays(today, -1), to: today, label: 'yesterday' })],
    [/\btomorrow\b/, () => ({ from: addDays(today, 1), to: addDays(today, 2), label: 'tomorrow' })],
    [/\b(?:last|past|previous)\s+week\b/, () => ({ from: addDays(weekStart, -7), to: weekStart, label: 'last week' })],
    [/\bnext\s+week\b/, () => ({ from: addDays(weekStart, 7), to: addDays(weekStart, 14), label: 'next week' })],
    [/\bthis\s+week\b/, () => ({ from: weekStart, to: addDays(weekStart, 7), label: 'this week' })],
    [/\b(?:last|past|previous)\s+month\b/, () => ({ from: utc(y, m - 1, 1), to: utc(y, m, 1), label: 'last month' })],
    [/\bnext\s+month\b/, () => ({ from: utc(y, m + 1, 1), to: utc(y, m + 2, 1), label: 'next month' })],
    [/\bthis\s+month\b/, () => ({ from: utc(y, m, 1), to: utc(y, m + 1, 1), label: 'this month' })],
    [/\b(?:last|past|previous)\s+quarter\b/, () => ({ from: utc(y, qStart.getUTCMonth() - 3, 1), to: qStart, label: 'last quarter' })],
    [/\bthis\s+quarter\b/, () => ({ from: qStart, to: utc(y, qStart.getUTCMonth() + 3, 1), label: 'this quarter' })],
    [/\b(?:last|past|previous)\s+year\b/, () => ({ from: utc(y - 1, 0, 1), to: utc(y, 0, 1), label: 'last year' })],
    [/\bthis\s+year\b/, () => ({ from: utc(y, 0, 1), to: utc(y + 1, 0, 1), label: 'this year' })],
  ];
  const nm = q.match(/\b(?:last|past|previous|in the last|in the past|within the last)\s+(\d+|one|two|three|four|six|seven|ten|twelve|fifteen)\s*(days?|weeks?|months?)\b/);
  if (nm) {
    const n = parseNumberWord(nm[1]);
    const days = /day/.test(nm[2]) ? n : /week/.test(nm[2]) ? n * 7 : n * 30;
    return { from: addDays(today, -days + 1), to: addDays(today, 1), label: `last ${n} ${nm[2]}`, match: nm[0] };
  }
  const fm = q.match(/\b(?:next|in the next|within the next|coming)\s+(\d+|one|two|three|four|seven|ten|fourteen|thirty)\s*(days?|weeks?|months?)\b/);
  if (fm) {
    const n = parseNumberWord(fm[1]) ?? Number(fm[1]);
    const days = /day/.test(fm[2]) ? n : /week/.test(fm[2]) ? n * 7 : n * 30;
    return { from: today, to: addDays(today, days + 1), label: `next ${n} ${fm[2]}`, match: fm[0] };
  }
  for (const [re, fn] of tests) {
    const mm = q.match(re);
    if (mm) return { ...fn(), match: mm[0] };
  }
  const mon = q.match(MONTH_RE);
  if (mon && !/\bmay\b/.test(mon[1]) || (mon && /\b(?:in|for|during|since)\s+may\b/.test(q))) {
    const idx = MONTHS.findIndex((x) => x.startsWith(mon[1].slice(0, 3)));
    let year = mon[2] ? Number(mon[2]) : y;
    if (!mon[2] && idx > m) year -= 1; // "in november" asked in october means last november
    const since = /\bsince\b/.test(mon[0]);
    return { from: utc(year, idx, 1), to: since ? addDays(today, 1) : utc(year, idx + 1, 1), label: since ? `since ${MONTHS[idx]} ${year}` : `${MONTHS[idx]} ${year}`, match: mon[0] };
  }
  return null;
}

const COMPARATORS = [
  { re: /(?:above|over|greater than|more than|higher than|exceeding|>=?|≥|at least)\s*(\d+(?:\.\d+)?)/i, op: '$gt' },
  { re: /(?:below|under|less than|lower than|<=?|≤|at most)\s*(\d+(?:\.\d+)?)/i, op: '$lt' },
];

/** Patient name matching with fuzzy tolerance for typos ("Ravi Kumaar"). */
function findPatient(q, patients) {
  const lower = q.toLowerCase();
  let best = null;
  for (const p of patients) {
    const name = p.name.toLowerCase();
    const idx = lower.indexOf(name);
    if (idx >= 0) return { patient: p, start: idx, end: idx + name.length, score: 1 };
  }
  // fuzzy: compare every two-word window with each full name
  const words = [...lower.matchAll(/[a-z]+/g)];
  for (let i = 0; i + 1 < words.length; i++) {
    const phrase = `${words[i][0]} ${words[i + 1][0]}`;
    for (const p of patients) {
      const s = natural.JaroWinklerDistance(phrase, p.name.toLowerCase());
      if (s >= 0.93 && (!best || s > best.score)) best = { patient: p, start: words[i].index, end: words[i + 1].index + words[i + 1][0].length, score: s };
    }
  }
  return best;
}

export function extractSlots(question, { patients = [], now = new Date() } = {}) {
  const q = String(question);
  const spans = [];
  const slots = { drugs: [], drugClasses: [], diagnoses: [], symptoms: [], lab: null, time: null, patient: null, limit: null, wantsCount: false, lastVisits: null, medAction: null, certainty: null };
  const mark = (start, end, token) => spans.push({ start, end, token });

  const patient = findPatient(q, patients);
  if (patient) { slots.patient = { id: String(patient.patient._id), name: patient.patient.name, matchScore: Number(patient.score.toFixed(2)) }; mark(patient.start, patient.end, 'slot_patient'); }

  const taken = () => spans.map((s) => [s.start, s.end]);
  const free = (s, e) => !taken().some(([a, b]) => s < b && a < e);

  for (const re of [DRUG_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(q))) {
      const d = drugByAlias.get(m[0].toLowerCase().replace(/\s+/g, ' '));
      if (d && free(m.index, m.index + m[0].length) && !slots.drugs.includes(d.generic)) { slots.drugs.push(d.generic); mark(m.index, m.index + m[0].length, 'slot_drug'); }
    }
  }
  for (const c of DRUG_CLASS_WORDS) {
    const m = q.match(c.re);
    if (m && free(m.index, m.index + m[0].length)) { slots.drugClasses.push(c.cls); mark(m.index, m.index + m[0].length, 'slot_drug'); }
  }
  LAB_RE.lastIndex = 0;
  let lm;
  while ((lm = LAB_RE.exec(q))) {
    const lab = labByAlias.get(lm[0].toLowerCase().replace(/\s+/g, ' '));
    if (!lab || !free(lm.index, lm.index + lm[0].length)) continue;
    const tail = q.slice(lm.index + lm[0].length, lm.index + lm[0].length + 40);
    let cmp = null;
    for (const c of COMPARATORS) { const cm = tail.match(c.re); if (cm) { cmp = { op: c.op, value: Number(cm[1]) }; break; } }
    if (!cmp && /\b(?:abnormal|high|raised|elevated|uncontrolled)\b/i.test(q)) cmp = { op: lab.high != null ? '$gt' : '$lt', value: lab.high ?? lab.low, reason: 'reference range' };
    if (!cmp && /\b(?:low|deficient)\b/i.test(q) && lab.low != null) cmp = { op: '$lt', value: lab.low, reason: 'reference range' };
    slots.lab = { test: lab.test, unit: lab.unit, ...(cmp ?? {}) };
    mark(lm.index, lm.index + lm[0].length, 'slot_lab');
    break;
  }
  DX_RE.lastIndex = 0;
  let dm;
  while ((dm = DX_RE.exec(q))) {
    const key = dm[0].toLowerCase().replace(/\s+/g, ' ');
    const d = dxByAlias.get(key);
    if (!d || !free(dm.index, dm.index + dm[0].length)) continue;
    if (CONTEXT_ONLY_DX_ALIASES.has(key) && dm[0] !== dm[0].toUpperCase()) continue;
    if (!slots.diagnoses.some((x) => x.code === d.code)) slots.diagnoses.push({ term: d.term, code: d.code });
    mark(dm.index, dm.index + dm[0].length, 'slot_diagnosis');
  }
  SX_RE.lastIndex = 0;
  let sm;
  while ((sm = SX_RE.exec(q))) {
    const s = sxByAlias.get(sm[0].toLowerCase().replace(/\s+/g, ' '));
    if (!s || !free(sm.index, sm.index + sm[0].length)) continue;
    if (sm[0].toLowerCase() === 'cold') continue;
    if (!slots.symptoms.includes(s.term)) slots.symptoms.push(s.term);
    mark(sm.index, sm.index + sm[0].length, 'slot_symptom');
  }

  const time = parseTimeRange(q, now);
  if (time) {
    slots.time = { from: time.from.toISOString(), to: time.to.toISOString(), label: time.label };
    const i = q.toLowerCase().indexOf(time.match);
    if (i >= 0 && free(i, i + time.match.length)) mark(i, i + time.match.length, 'slot_time');
  }

  const lim = q.match(/\btop\s+(\d+|five|ten|three)\b/i) || q.match(/\b(\d+)\s+(?:most|top)\b/i);
  if (lim) slots.limit = Math.min(parseNumberWord(lim[1]) ?? 10, 50);
  slots.wantsCount = /\b(?:how many|count|number of|total)\b/i.test(q);
  const lv = q.match(/\blast\s+(\d+|two|three|four|five)\s+(?:visits?|consultations?|encounters?)\b/i);
  if (lv) slots.lastVisits = parseNumberWord(lv[1]);
  if (/\b(?:started|initiated|begun|newly prescribed|added)\b/i.test(q)) slots.medAction = 'start';
  else if (/\b(?:stopped|discontinued|taken off)\b/i.test(q)) slots.medAction = 'stop';
  if (/\b(?:suspected|provisional|possible|probable)\b/i.test(q)) slots.certainty = 'provisional';
  slots.requireAllDrugs = slots.drugs.length > 1 && /\bboth\b|\band\b/i.test(q) && !/\bor\b/i.test(q);

  // masked text for the classifier
  let masked = q;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) masked = `${masked.slice(0, s.start)} ${s.token} ${masked.slice(s.end)}`;
  masked = masked.replace(/\b\d+(?:\.\d+)?\b/g, ' slot_num ');
  return { slots, masked: masked.replace(/\s+/g, ' ').trim() };
}
