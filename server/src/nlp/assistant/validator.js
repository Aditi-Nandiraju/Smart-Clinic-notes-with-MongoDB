// Safety validator for assistant pipelines. Every generated pipeline passes
// through here before it runs, so a bug in the query builder (or a future
// model-generated query) cannot write data, read secrets or run arbitrary code.

export const ALLOWED_COLLECTIONS = new Set(['encounters', 'followups', 'patients']);
const ALLOWED_STAGES = new Set(['$match', '$lookup', '$unwind', '$group', '$project', '$addFields', '$set', '$sort', '$limit', '$count', '$skip']);
const FORBIDDEN_OPERATORS = new Set(['$where', '$function', '$accumulator', '$out', '$merge', '$unionWith', '$currentOp', '$collStats', '$indexStats', '$planCacheStats', '$listSessions', '$listLocalSessions', '$graphLookup', '$documents', '$changeStream', '$sample']);
const FORBIDDEN_FIELDS = /phoneEnc|passwordHash|email/;
export const MAX_RESULTS = 500;

export class UnsafeQueryError extends Error {
  constructor(msg) { super(msg); this.name = 'UnsafeQueryError'; }
}

function walk(node, fn, path = []) {
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, fn, [...path, i]));
  else if (node && typeof node === 'object' && !(node instanceof Date) && node.constructor?.name !== 'ObjectId') {
    for (const [k, v] of Object.entries(node)) { fn(k, v, path); walk(v, fn, [...path, k]); }
  } else if (typeof node === 'string') fn(null, node, path);
}

function hasVerifiedFilter(match) {
  return match && (match.status === 'verified' || match.status?.$eq === 'verified');
}

function validateStages(pipeline, collection, depth = 0, opts = {}) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) throw new UnsafeQueryError('Pipeline must be a non-empty array');
  if (depth > 1) throw new UnsafeQueryError('Nested lookups deeper than one level are not allowed');
  pipeline.forEach((stage, i) => {
    const keys = Object.keys(stage);
    if (keys.length !== 1) throw new UnsafeQueryError(`Stage ${i} must have exactly one operator`);
    const op = keys[0];
    if (!ALLOWED_STAGES.has(op)) throw new UnsafeQueryError(`Stage ${op} is not allowed`);
    if (op === '$lookup') {
      const lk = stage.$lookup;
      if (!ALLOWED_COLLECTIONS.has(lk.from)) throw new UnsafeQueryError(`Lookup into ${lk.from} is not allowed`);
      if (lk.pipeline) validateStages(lk.pipeline, lk.from, depth + 1);
      if (lk.from === 'encounters') {
        const first = lk.pipeline?.[0]?.$match;
        if (!lk.pipeline || !hasVerifiedFilter(first)) throw new UnsafeQueryError('Lookups into encounters must filter status: "verified" first');
      }
    }
    if (op === '$limit' && (typeof stage.$limit !== 'number' || stage.$limit > MAX_RESULTS)) throw new UnsafeQueryError(`$limit must be a number <= ${MAX_RESULTS}`);
  });
  const countsOnly = opts.allowUnverifiedCounts && depth === 0 && pipeline.some((s) => s.$group)
    && !JSON.stringify(pipeline).match(/rawNote|extraction/);
  if (collection === 'encounters' && !hasVerifiedFilter(pipeline[0].$match) && !countsOnly) {
    throw new UnsafeQueryError('Queries on encounters must start with $match on status: "verified"');
  }
}

/**
 * Validate and harden a pipeline. Returns a new pipeline with a result cap.
 * Throws UnsafeQueryError on anything outside the allowlist.
 */
export function validatePipeline(collection, pipeline, opts = {}) {
  if (!ALLOWED_COLLECTIONS.has(collection)) throw new UnsafeQueryError(`Collection ${collection} is not allowed`);
  walk(pipeline, (k, v) => {
    if (k && FORBIDDEN_OPERATORS.has(k)) throw new UnsafeQueryError(`Operator ${k} is not allowed`);
    if (k && FORBIDDEN_FIELDS.test(k)) throw new UnsafeQueryError(`Field ${k} is not allowed`);
    if (typeof v === 'string' && /^\$/.test(v) && FORBIDDEN_FIELDS.test(v)) throw new UnsafeQueryError(`Field ${v} is not allowed`);
  });
  validateStages(pipeline, collection, 0, opts);
  const out = [...pipeline];
  const last = out[out.length - 1];
  if (!last.$limit && !last.$count) out.push({ $limit: MAX_RESULTS });
  return out;
}
