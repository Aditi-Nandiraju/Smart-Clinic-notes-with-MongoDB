// Local sentence embeddings. No external API.
//
// Two built-in models, both producing 384-dimensional L2-normalised vectors
// (EMBEDDING_MODE=ollama uses an Ollama embedding model instead):
//  - "minilm":  all-MiniLM-L6-v2 run locally through ONNX (@huggingface/transformers).
//               The ~23 MB model is downloaded once into MODEL_CACHE_DIR, then works offline.
//  - "clinhash": a clinical hashing embedder: lexicon normalisation (brand -> generic,
//               abbreviation -> term), clinical synonym expansion, word uni/bi-grams and
//               character 4-grams hashed into 384 signed buckets. Needs no download, so
//               the system always works on an air-gapped machine.
// The model name is stored on every chunk, and search only compares vectors from the
// same model, so switching models never mixes incompatible vectors.

import path from 'node:path';
import { config } from '../config.js';
import { DRUGS } from './lexicon/drugs.js';
import { DIAGNOSES, SYMPTOMS } from './lexicon/conditions.js';
import { compileAliasRegex } from './textUtils.js';

export const DIMS = 384;

// --- clinical normalisation shared by the hashing model -------------------
const canon = new Map();
for (const d of DRUGS) for (const a of d.aliases) canon.set(a, `${d.generic} ${d.cls}`);
for (const d of DIAGNOSES) for (const a of d.aliases) if (a.length > 3 || /^[a-z]+\d/.test(a)) canon.set(a, d.term);
for (const s of SYMPTOMS) for (const a of s.aliases) canon.set(a, s.term);
const CANON_RE = compileAliasRegex([...canon.keys()]);

// small paraphrase table for wording that the lexicons do not cover
const SYNONYMS = [
  [/\b(?:on exertion|exertional|climbing stairs|walking uphill|on walking|after walking|effort)\b/g, ' exertion '],
  [/\b(?:at night|nocturnal|night time|nighttime)\b/g, ' nocturnal '],
  [/\b(?:after food|after meals|post[- ]?prandial)\b/g, ' postprandial '],
  [/\b(?:on and off|intermittent(?:ly)?|episodic)\b/g, ' intermittent '],
  [/\b(?:worse|worsening|aggravated|increased)\b/g, ' worsening '],
  [/\b(?:better|improved|improving|relieved|resolved|subsided)\b/g, ' improving '],
  [/\b(?:antibiotics?|abx)\b/g, ' antibiotic '],
  [/\b(?:sugar|glucose|glycaemic|glycemic)\b/g, ' glucose '],
  [/\b(?:bp)\b/g, ' blood pressure '],
  [/\b(?:pt|patient)\b/g, ' '],
  [/\b(?:c\/o|complains of|complaining of|presents with)\b/g, ' complaint '],
];
// drug classes expanded to the plain words people search with
const CLASS_CONCEPTS = [
  [/penicillin antibiotic|macrolide antibiotic|fluoroquinolone antibiotic|cephalosporin antibiotic|tetracycline antibiotic|urinary antibiotic|nitroimidazole/g, 'antibiotic'],
  [/calcium channel blocker|\barb\b|ace inhibitor|beta blocker|thiazide diuretic|loop diuretic/g, 'blood pressure medicine'],
  [/\bstatin\b/g, 'cholesterol medicine'],
  [/biguanide|sulfonylurea|dpp 4 inhibitor|dpp-4 inhibitor|sglt2 inhibitor|\binsulin\b/g, 'diabetes glucose medicine'],
  [/thyroid hormone/g, 'thyroid medicine'],
];

export function clinicalNormalise(text) {
  let t = ` ${String(text).toLowerCase()} `;
  CANON_RE.lastIndex = 0;
  t = t.replace(CANON_RE, (m) => ` ${canon.get(m.toLowerCase().replace(/\s+/g, ' ')) ?? m} `);
  for (const [re, concept] of CLASS_CONCEPTS) t = t.replace(re, (m) => `${m} ${concept}`);
  for (const [re, rep] of SYNONYMS) t = t.replace(re, rep);
  return t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set('a an the of and or to in on for x is was were be been have had his her pt this that at by from as it its are after since'.split(' '));

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const NEG_TRIGGER = /^(no|not|nil|denies|denied|without|negative|absent)$/;
const NEG_RESET = /^(but|however|though|although|complaint|has|with|now|except)$/;

/** Weighted features of a text: words, bigrams, char 4-grams and negated words. */
function featuresOf(text) {
  const feats = [];
  for (const sentence of String(text).split(/[.;\n]+/)) {
    const words = clinicalNormalise(sentence).split(' ').filter(Boolean);
    let negated = false;
    const content = [];
    for (const w of words) {
      if (NEG_TRIGGER.test(w)) { negated = true; continue; }
      if (NEG_RESET.test(w)) negated = false;
      if (STOP.has(w) || /^\d+$/.test(w)) continue; // numbers carry no meaning for search
      content.push({ w, negated });
    }
    for (const { w, negated: n } of content) {
      if (n) { feats.push([`neg:${w}`, 0.8]); continue; } // "no fever" must not look like "fever"
      feats.push([`w:${w}`, 1.0]);
      const padded = `#${w}#`;
      if (padded.length > 5) for (let i = 0; i + 4 <= padded.length; i++) feats.push([`c:${padded.slice(i, i + 4)}`, 0.2]);
    }
    for (let i = 0; i + 1 < content.length; i++) {
      if (!content[i].negated && !content[i + 1].negated) feats.push([`b:${content[i].w}_${content[i + 1].w}`, 0.6]);
    }
  }
  return feats;
}

/** Content words of a text, split into those mentioned positively and those only under negation. */
export function mentionedWords(text) {
  const pos = new Set(); const neg = new Set();
  for (const [f] of featuresOf(text)) {
    if (f.startsWith('w:')) pos.add(f.slice(2));
    else if (f.startsWith('neg:')) neg.add(f.slice(4));
  }
  return { pos, neg };
}

export function hashEmbed(text) {
  const v = new Float32Array(DIMS);
  for (const [feat, w] of featuresOf(text)) {
    const h = fnv1a(feat);
    v[h % DIMS] += (h & 0x80000000 ? -1 : 1) * w;
  }
  let norm = 0;
  for (let i = 0; i < DIMS; i++) { v[i] = Math.sign(v[i]) * Math.log1p(Math.abs(v[i])); norm += v[i] * v[i]; }
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => Number((x / norm).toFixed(6)));
}

// --- transformer model -------------------------------------------------------
let extractorPromise = null;
let activeModel = null;

async function loadTransformer() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.resolve(config.modelCacheDir);
  env.allowRemoteModels = process.env.ALLOW_MODEL_DOWNLOAD !== 'false';
  return pipeline('feature-extraction', config.embeddingModelId, { dtype: 'q8' });
}

/** Resolve which model is in use. Called once at startup. */
export async function initEmbedder() {
  if (activeModel) return activeModel;
  if (config.embeddingMode === 'hashing') {
    activeModel = 'clinhash-384';
    return activeModel;
  }
  if (config.embeddingMode === 'ollama') {
    // embeddings from a local Ollama model (e.g. nomic-embed-text, 768 dims);
    // run `npm run reindex` after switching so stored vectors match
    const { embedOllama } = await import('./llm/ollama.js');
    try {
      await embedOllama(['probe']);
      activeModel = `ollama:${config.ollamaEmbedModel}`;
      return activeModel;
    } catch (err) {
      console.warn(`[embedder] Ollama embeddings unavailable (${err.message}); using clinhash-384`);
      activeModel = 'clinhash-384';
      return activeModel;
    }
  }
  try {
    extractorPromise = loadTransformer();
    await extractorPromise;
    activeModel = 'minilm-l6-v2';
  } catch (err) {
    if (config.embeddingMode === 'transformer') throw err;
    console.warn(`[embedder] transformer model unavailable (${err.message.split('\n')[0]}); using clinhash-384`);
    extractorPromise = null;
    activeModel = 'clinhash-384';
  }
  return activeModel;
}

export function embeddingModelName() {
  return activeModel ?? 'clinhash-384';
}

export async function embed(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!activeModel) await initEmbedder();
  if (activeModel === 'minilm-l6-v2') {
    const extractor = await extractorPromise;
    // the model reads plain English better than shorthand, so expand abbreviations first
    const out = await extractor(list.map((t) => clinicalNormalise(t)), { pooling: 'mean', normalize: true });
    return out.tolist().map((row) => row.map((x) => Number(x.toFixed(6))));
  }
  if (activeModel.startsWith('ollama:')) {
    const { embedOllama } = await import('./llm/ollama.js');
    const out = await embedOllama(list.map((t) => clinicalNormalise(t)));
    return out.map((row) => { const n = Math.hypot(...row) || 1; return row.map((x) => Number((x / n).toFixed(6))); });
  }
  return list.map((t) => hashEmbed(t));
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalised
}

/** Notes are short, but long ones are split into ~80-word windows with overlap. */
export function chunkNote(text, maxWords = 80, overlap = 15) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [words.join(' ')];
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords - overlap) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
    if (i + maxWords >= words.length) break;
  }
  return chunks;
}
