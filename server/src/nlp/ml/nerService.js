// Loads, trains and runs the local ML tagger.
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../../config.js';
import { SequenceTagger, tokenize, spansToTags, spanF1 } from './tagger.js';
import { lexiconSpans } from '../extractor.js';

const MODEL_FILE = () => path.resolve(config.modelCacheDir, 'ner-model.json');
let model = null;

/** Lexicon BIO tags per token, from exact dictionary matches. */
export function lexiconTagger(text) {
  const spans = lexiconSpans(text);
  return (tokens) => spansToTags(tokens, spans).map((t) => (t === 'O' ? null : t));
}

export function loadNer() {
  try {
    if (fs.existsSync(MODEL_FILE())) model = SequenceTagger.load(MODEL_FILE());
  } catch (e) {
    console.warn('[ner] could not load model:', e.message);
    model = null;
  }
  return model;
}

export function nerStatus() {
  return model ? { available: true, ...model.meta } : { available: false };
}

/** Entity mentions proposed by the ML tagger (empty if no model is trained yet). */
export function nerCandidates(text) {
  if (!model || !text) return [];
  return model.predict(text, lexiconTagger(text)).filter((c) => c.surface.trim().length > 1);
}

/** Gold spans from a verified extraction; null when any item lacks a span. */
export function goldSpans(extraction) {
  const spans = [];
  for (const s of extraction?.symptoms ?? []) { if (!s.span) return null; spans.push({ type: 'symptom', start: s.span[0], end: s.span[1] }); }
  for (const d of extraction?.diagnoses ?? []) { if (!d.span) return null; spans.push({ type: 'diagnosis', start: d.span[0], end: d.span[1] }); }
  for (const m of extraction?.medications ?? []) {
    const sp = m.nameSpan ?? null;
    if (!sp) return null;
    spans.push({ type: 'medication', start: sp[0], end: sp[1] });
  }
  return spans;
}

export function buildExamples(encounters) {
  const out = [];
  for (const e of encounters) {
    const gold = goldSpans(e.extraction);
    if (!gold) continue; // skip notes with items the doctor added without marking text
    const tokens = tokenize(e.rawNote);
    out.push({ tokens, tags: spansToTags(tokens, gold), lex: lexiconTagger(e.rawNote)(tokens), text: e.rawNote, gold });
  }
  return out;
}

/** Train on verified notes, hold out 10% to report span F1, save, and swap in. */
export function trainNer(encounters, { epochs = 10, log = () => {} } = {}) {
  const examples = buildExamples(encounters);
  if (examples.length < 20) throw new Error(`Need at least 20 verified notes with marked text to train; found ${examples.length}`);
  const cut = Math.floor(examples.length * 0.9);
  const train = examples.slice(0, cut); const test = examples.slice(cut);
  const m = new SequenceTagger().train(train, { epochs, log });
  let tp = 0; let fp = 0; let fn = 0;
  for (const ex of test) {
    const pred = m.predict(ex.text, () => ex.lex);
    const r = spanF1(pred, ex.gold);
    tp += r.tp; fp += r.fp; fn += r.fn;
  }
  const precision = tp / Math.max(1, tp + fp); const recall = tp / Math.max(1, tp + fn);
  m.meta.heldOut = { notes: test.length, precision, recall, f1: (2 * precision * recall) / Math.max(1e-9, precision + recall) };
  m.meta.trainNotes = train.length;
  m.save(MODEL_FILE());
  model = m;
  return m.meta;
}
