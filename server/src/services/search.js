// Hybrid note search: vector similarity + keyword ($text), fused with
// reciprocal rank fusion. Uses Atlas $vectorSearch when available, otherwise an
// exact cosine scan of the candidate chunks (fine for a clinic-sized dataset).
import mongoose from 'mongoose';
import { NoteChunk, Encounter, Patient } from '../models/index.js';
import { embed, embeddingModelName, chunkNote, cosine, mentionedWords } from '../nlp/embedder.js';
import { config } from '../config.js';

const { Types } = mongoose;

/** (Re)build search chunks for one verified encounter. */
export async function indexEncounter(encounter, session) {
  const codes = (encounter.extraction?.diagnoses ?? []).filter((d) => d.certainty !== 'ruled_out').map((d) => d.code);
  const texts = chunkNote(encounter.rawNote);
  const vectors = await embed(texts);
  await NoteChunk.deleteMany({ encounterId: encounter._id }, { session });
  await NoteChunk.insertMany(texts.map((text, i) => ({
    encounterId: encounter._id,
    patientId: encounter.patientId,
    visitDate: encounter.visitDate,
    chunkIndex: i,
    text,
    embedding: vectors[i],
    embeddingModel: embeddingModelName(),
    diagnosisCodes: codes,
  })), { session });
}

function buildFilter({ patientId, from, to, diagnosisCode }) {
  const f = { embeddingModel: embeddingModelName() };
  if (patientId) f.patientId = new Types.ObjectId(String(patientId));
  if (from || to) f.visitDate = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
  if (diagnosisCode) f.diagnosisCodes = diagnosisCode;
  return f;
}

async function vectorRanked(qv, filter, limit) {
  if (config.atlasVectorSearch) {
    const rows = await NoteChunk.aggregate([
      { $vectorSearch: { index: 'note_chunks_vector', path: 'embedding', queryVector: qv, numCandidates: limit * 10, limit, filter } },
      { $project: { embedding: 0, score: { $meta: 'vectorSearchScore' } } },
    ]);
    return rows;
  }
  const cands = await NoteChunk.find(filter).select('+embedding').lean();
  return cands
    .map((c) => ({ ...c, score: cosine(qv, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ embedding, ...rest }) => rest);
}

async function keywordRanked(query, filter, limit, qv, minScore) {
  try {
    const hits = await NoteChunk.find({ ...filter, $text: { $search: query } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } }).limit(limit).lean();
    // $text ignores negation ("no rash" matches "rash"), so keyword hits must
    // also be at least loosely similar in meaning to the query
    // drop notes where every query term that appears is negated ("No SOB" for "breathlessness")
    const q = mentionedWords(query).pos;
    return hits
      .filter((h) => {
        const { pos, neg } = mentionedWords(h.text);
        const shared = [...q].filter((w) => pos.has(w) || neg.has(w));
        return shared.length === 0 || shared.some((w) => pos.has(w));
      })
      .map(({ embedding, ...rest }) => ({ ...rest, semantic: embedding ? cosine(qv, embedding) : 0 }))
      .filter((h) => h.semantic >= minScore * 0.6);
  } catch {
    return [];
  }
}

/**
 * @returns encounter-level results with fused score, the best chunk as snippet,
 *          and which retriever(s) found it.
 */
export async function searchNotes(query, opts = {}) {
  const limit = Math.min(Number(opts.limit) || 10, 50);
  const mode = opts.mode || 'hybrid';
  const filter = buildFilter(opts);
  const depth = limit * 4;
  const minScore = opts.minScore ?? 0.12;
  const [qv] = await embed([query]);
  const [vec, kw] = await Promise.all([
    mode === 'keyword' ? [] : vectorRanked(qv, filter, depth),
    mode === 'semantic' ? [] : keywordRanked(query, filter, depth, qv, mode === 'keyword' ? 0 : minScore),
  ]);

  const K = 60; // reciprocal rank fusion constant
  const byEnc = new Map();
  const addList = (list, kind) => list.forEach((c, rank) => {
    const id = String(c.encounterId);
    const cur = byEnc.get(id) ?? { encounterId: id, rrf: 0, sources: new Set(), chunk: c, semanticScore: null };
    cur.rrf += (kind === 'keyword' ? 0.5 : 1) / (K + rank + 1); // meaning first, exact words as a tiebreaker
    cur.sources.add(kind);
    if (kind === 'semantic') { cur.semanticScore = Math.max(cur.semanticScore ?? -1, c.score); cur.chunk = c; }
    if (kind === 'keyword' && cur.semanticScore == null) cur.semanticScore = c.semantic;
    byEnc.set(id, cur);
  });
  addList(vec, 'semantic');
  addList(kw, 'keyword');

  // drop weak semantic-only hits so unrelated notes are not shown as matches
  let ranked = [...byEnc.values()].filter((r) => mode === 'keyword' || (r.semanticScore ?? 0) >= minScore * (r.sources.size > 1 ? 0.6 : 1));
  ranked = ranked.sort((a, b) => b.rrf - a.rrf).slice(0, limit);

  const encs = await Encounter.find({ _id: { $in: ranked.map((r) => r.encounterId) } })
    .select('patientId visitDate status extraction.diagnoses rawNote').lean();
  const pats = await Patient.find({ _id: { $in: encs.map((e) => e.patientId) } }).select('name patientCode').lean();
  const encMap = new Map(encs.map((e) => [String(e._id), e]));
  const patMap = new Map(pats.map((p) => [String(p._id), p]));

  return ranked.map((r) => {
    const e = encMap.get(r.encounterId);
    if (!e) return null;
    const p = patMap.get(String(e.patientId));
    return {
      encounterId: r.encounterId,
      patientId: String(e.patientId),
      patientName: p?.name,
      patientCode: p?.patientCode,
      visitDate: e.visitDate,
      snippet: r.chunk.text,
      diagnoses: (e.extraction?.diagnoses ?? []).filter((d) => d.certainty !== 'ruled_out').map((d) => d.term),
      score: Number(r.rrf.toFixed(4)),
      semanticScore: r.semanticScore == null ? null : Number(r.semanticScore.toFixed(3)),
      matchedBy: [...r.sources],
    };
  }).filter(Boolean);
}

/**
 * Re-embed all verified notes with the active model. Runs automatically at
 * startup when the stored vectors came from a different embedding model.
 */
export async function reindexAll(log = console) {
  const { Encounter: Enc } = await import('../models/index.js');
  const encs = await Enc.find({ status: 'verified' }).lean();
  let n = 0;
  for (const e of encs) {
    await indexEncounter(e);
    n++;
    if (n % 250 === 0) log.info?.(`[search] re-indexed ${n}/${encs.length} notes`);
  }
  await NoteChunk.deleteMany({ embeddingModel: { $ne: embeddingModelName() } });
  return n;
}

export async function indexNeedsRebuild() {
  const [active, other] = await Promise.all([
    NoteChunk.countDocuments({ embeddingModel: embeddingModelName() }),
    NoteChunk.countDocuments({ embeddingModel: { $ne: embeddingModelName() } }),
  ]);
  return active === 0 && other > 0;
}
