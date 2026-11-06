// Local machine-learning NER: a linear-chain sequence tagger (averaged
// structured perceptron, Collins 2002) with BIO labels and Viterbi decoding.
// It is trained on the clinic's own verified notes, runs on a CPU in
// milliseconds, and needs no external service.
//
// Why it helps next to the rules: it learns from context ("c/o ___ x 3 days",
// "Tab ___ 500 mg BD"), so it can find symptoms and drug names that are not in
// the lexicon yet. To force that, lexicon-match features are randomly dropped
// during training (lexicon dropout), so the model cannot rely on them alone.

import fs from 'node:fs';
import path from 'node:path';

export const LABELS = ['O', 'B-SYM', 'I-SYM', 'B-DX', 'I-DX', 'B-DRUG', 'I-DRUG'];
const L = LABELS.length;
const TYPE_TO_TAG = { symptom: 'SYM', diagnosis: 'DX', medication: 'DRUG' };
const TAG_TO_TYPE = { SYM: 'symptom', DX: 'diagnosis', DRUG: 'medication' };
const FORMS = new Set(['tab', 'tabs', 'cap', 'caps', 'syp', 'inj', 't', 'susp', 'oint', 'inh', 'cream', 'gel']);
const FREQ = new Set(['od', 'bd', 'tds', 'qid', 'hs', 'sos', 'prn', 'bid', 'tid', 'stat']);

/** Tokens with character offsets. */
export function tokenize(text) {
  const out = [];
  const re = /[A-Za-z]+(?:[-'][A-Za-z]+)*|\d+(?:\.\d+)?|[^\sA-Za-z\d]/g;
  let m;
  while ((m = re.exec(text))) out.push({ text: m[0], lower: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

function shape(t) {
  return t.replace(/[A-Z]+/g, 'X').replace(/[a-z]+/g, 'x').replace(/\d+/g, 'd');
}

/**
 * Feature strings for each token. `lex` holds lexicon BIO tags per token
 * (from the dictionary matcher) and is omitted when `dropLexicon` is set.
 */
function features(tokens, lex, dropLexicon) {
  const w = (i) => (i < 0 ? '<s>' : i >= tokens.length ? '</s>' : tokens[i].lower);
  return tokens.map((t, i) => {
    const f = ['b', `w=${t.lower}`, `sh=${shape(t.text)}`, `p3=${t.lower.slice(0, 3)}`, `s3=${t.lower.slice(-3)}`, `s4=${t.lower.slice(-4)}`,
      `w-1=${w(i - 1)}`, `w+1=${w(i + 1)}`, `w-2=${w(i - 2)}`, `w+2=${w(i + 2)}`, `w-1|w=${w(i - 1)}|${t.lower}`, `w|w+1=${t.lower}|${w(i + 1)}`,
      `w-2|w-1=${w(i - 2)}|${w(i - 1)}`];
    if (t.lower.length > 6) f.push('long');
    if (/^\d/.test(t.text)) f.push('num');
    if (/^\d/.test(w(i + 1))) f.push('next_num');
    if (/^\d/.test(w(i + 2)) && w(i + 1) !== '.') f.push('next2_num');
    if (FORMS.has(w(i - 1)) || (w(i - 1) === '.' && FORMS.has(w(i - 2)))) f.push('after_form');
    if (FREQ.has(w(i + 1)) || FREQ.has(w(i + 2)) || FREQ.has(w(i + 3))) f.push('freq_near');
    if (t.text === t.text.toUpperCase() && /[A-Z]/.test(t.text)) f.push('allcaps');
    if (/^[A-Z][a-z]/.test(t.text)) f.push('title');
    if (!dropLexicon && lex && lex[i]) f.push(`lex=${lex[i]}`, `lex|w-1=${lex[i]}|${w(i - 1)}`);
    return f;
  });
}

/** BIO tags for token spans. spans: [{ type, start, end }] */
export function spansToTags(tokens, spans) {
  const tags = tokens.map(() => 'O');
  for (const s of spans) {
    const tag = TYPE_TO_TAG[s.type];
    if (!tag) continue;
    let first = true;
    tokens.forEach((t, i) => {
      if (t.start >= s.start && t.end <= s.end) { tags[i] = `${first ? 'B' : 'I'}-${tag}`; first = false; }
    });
  }
  return tags;
}

const allowed = (prev, cur) => {
  if (!cur.startsWith('I-')) return true;
  const t = cur.slice(2);
  return prev === `B-${t}` || prev === `I-${t}`;
};

export class SequenceTagger {
  constructor() {
    this.w = new Map(); // feature -> Float64Array(L)
    this.trans = Array.from({ length: L + 1 }, () => new Float64Array(L)); // row L = start
    this.meta = {};
  }

  emission(feats) {
    const s = new Float64Array(L);
    for (const f of feats) {
      const v = this.w.get(f);
      if (v) for (let y = 0; y < L; y++) s[y] += v[y];
    }
    return s;
  }

  viterbi(featSeq) {
    const n = featSeq.length;
    if (!n) return { tags: [], margins: [] };
    const em = featSeq.map((f) => this.emission(f));
    const score = Array.from({ length: n }, () => new Float64Array(L).fill(-Infinity));
    const back = Array.from({ length: n }, () => new Int16Array(L));
    for (let y = 0; y < L; y++) if (allowed('O', LABELS[y])) score[0][y] = this.trans[L][y] + em[0][y];
    for (let i = 1; i < n; i++) {
      for (let y = 0; y < L; y++) {
        let best = -Infinity; let arg = 0;
        for (let p = 0; p < L; p++) {
          if (!allowed(LABELS[p], LABELS[y]) || score[i - 1][p] === -Infinity) continue;
          const v = score[i - 1][p] + this.trans[p][y];
          if (v > best) { best = v; arg = p; }
        }
        score[i][y] = best + em[i][y];
        back[i][y] = arg;
      }
    }
    let last = 0;
    for (let y = 1; y < L; y++) if (score[n - 1][y] > score[n - 1][last]) last = y;
    const idx = new Array(n);
    idx[n - 1] = last;
    for (let i = n - 1; i > 0; i--) idx[i - 1] = back[i][idx[i]];
    // per-token margin between the chosen label and the best alternative (local emission scores)
    const margins = idx.map((y, i) => {
      let second = -Infinity;
      for (let k = 0; k < L; k++) if (k !== y && em[i][k] > second) second = em[i][k];
      return em[i][y] - second;
    });
    return { tags: idx.map((y) => LABELS[y]), margins };
  }

  /**
   * Averaged structured perceptron training.
   * examples: [{ tokens, tags, lex }]
   */
  train(examples, { epochs = 10, lexiconDropout = 0.5, seed = 13, log = () => {} } = {}) {
    let s = seed;
    const rand = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
    const acc = new Map(); const ts = new Map();
    const tAcc = Array.from({ length: L + 1 }, () => new Float64Array(L));
    const tTs = Array.from({ length: L + 1 }, () => new Float64Array(L));
    let t = 1;
    const bump = (f, y, d) => {
      let v = this.w.get(f);
      if (!v) { v = new Float64Array(L); this.w.set(f, v); acc.set(f, new Float64Array(L)); ts.set(f, new Float64Array(L)); }
      const a = acc.get(f); const tt = ts.get(f);
      a[y] += (t - tt[y]) * v[y]; tt[y] = t; v[y] += d;
    };
    const bumpT = (p, y, d) => {
      tAcc[p][y] += (t - tTs[p][y]) * this.trans[p][y]; tTs[p][y] = t; this.trans[p][y] += d;
    };
    const order = examples.map((_, i) => i);
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      let errors = 0; let total = 0;
      for (const k of order) {
        const ex = examples[k];
        const feats = features(ex.tokens, ex.lex, rand() < lexiconDropout);
        const pred = this.viterbi(feats).tags;
        total += ex.tags.length;
        for (let i = 0; i < ex.tags.length; i++) {
          const g = LABELS.indexOf(ex.tags[i]); const p = LABELS.indexOf(pred[i]);
          const gPrev = i ? LABELS.indexOf(ex.tags[i - 1]) : L; const pPrev = i ? LABELS.indexOf(pred[i - 1]) : L;
          if (g !== p) { errors++; for (const f of feats[i]) { bump(f, g, 1); bump(f, p, -1); } }
          if (g !== p || gPrev !== pPrev) { bumpT(gPrev, g, 1); bumpT(pPrev, p, -1); }
        }
        t++;
      }
      log(`epoch ${ep + 1}: token error ${(errors / Math.max(1, total) * 100).toFixed(2)}%`);
    }
    // average and prune
    for (const [f, v] of this.w) {
      const a = acc.get(f); const tt = ts.get(f);
      let keep = false;
      for (let y = 0; y < L; y++) { v[y] = (a[y] + (t - tt[y]) * v[y]) / t; if (Math.abs(v[y]) > 1e-4) keep = true; }
      if (!keep) this.w.delete(f);
    }
    for (let p = 0; p <= L; p++) for (let y = 0; y < L; y++) this.trans[p][y] = (tAcc[p][y] + (t - tTs[p][y]) * this.trans[p][y]) / t;
    this.meta = { trainedAt: new Date().toISOString(), examples: examples.length, features: this.w.size, epochs, lexiconDropout };
    return this;
  }

  /** Predict entity spans in a note. lex: lexicon BIO tags (optional). */
  predict(text, lex) {
    const tokens = tokenize(text);
    const lexTags = lex ? lex(tokens) : null;
    const { tags, margins } = this.viterbi(features(tokens, lexTags, false));
    const spans = [];
    let cur = null;
    tags.forEach((tag, i) => {
      if (tag.startsWith('B-') || (tag.startsWith('I-') && !cur)) {
        if (cur) spans.push(cur);
        cur = { type: TAG_TO_TYPE[tag.slice(2)], start: tokens[i].start, end: tokens[i].end, margins: [margins[i]] };
      } else if (tag.startsWith('I-') && cur) {
        cur.end = tokens[i].end; cur.margins.push(margins[i]);
      } else if (cur) { spans.push(cur); cur = null; }
    });
    if (cur) spans.push(cur);
    return spans.map((sp) => {
      const m = sp.margins.reduce((a, b) => a + b, 0) / sp.margins.length;
      return { type: sp.type, start: sp.start, end: sp.end, surface: text.slice(sp.start, sp.end), source: 'ml', score: Number((1 / (1 + Math.exp(-m / 2))).toFixed(3)) };
    });
  }

  toJSON() {
    const w = {};
    for (const [f, v] of this.w) w[f] = Array.from(v, (x) => Number(x.toFixed(4)));
    return { labels: LABELS, meta: this.meta, trans: this.trans.map((r) => Array.from(r, (x) => Number(x.toFixed(4)))), w };
  }

  static fromJSON(json) {
    const m = new SequenceTagger();
    m.meta = json.meta ?? {};
    m.trans = json.trans.map((r) => Float64Array.from(r));
    for (const [f, v] of Object.entries(json.w)) m.w.set(f, Float64Array.from(v));
    return m;
  }

  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.toJSON()));
  }

  static load(file) {
    return SequenceTagger.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
}

/** Token-level and span-level scores against gold spans. */
export function spanF1(predSpans, goldSpans) {
  const key = (s) => `${s.type}|${s.start}|${s.end}`;
  const p = new Set(predSpans.map(key)); const g = new Set(goldSpans.map(key));
  let tp = 0;
  for (const k of p) if (g.has(k)) tp++;
  const precision = p.size ? tp / p.size : 1; const recall = g.size ? tp / g.size : 1;
  return { tp, fp: p.size - tp, fn: g.size - tp, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}
