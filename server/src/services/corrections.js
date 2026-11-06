// Compare the extractor's output with the doctor-verified version. Stored on
// each encounter, this gives a running, real-world accuracy measure.

const keyers = {
  symptoms: (s) => `${s.term}|${s.negated ? 'neg' : 'pos'}`,
  diagnoses: (d) => `${d.code}|${d.certainty}`,
  medications: (m) => `${m.generic}|${m.dose ?? ''}|${m.frequency ?? ''}|${m.action}`,
  labs: (l) => `${l.test}|${l.value}`,
  vitals: (v) => `${v.name}|${v.value}`,
};

export function compareExtractions(model, verified) {
  const out = { fields: {}, totals: { tp: 0, fp: 0, fn: 0 } };
  for (const [field, key] of Object.entries(keyers)) {
    const a = new Set((model?.[field] ?? []).map(key));
    const b = new Set((verified?.[field] ?? []).map(key));
    const tp = [...a].filter((k) => b.has(k)).length;
    const fp = [...a].filter((k) => !b.has(k));
    const fn = [...b].filter((k) => !a.has(k));
    out.fields[field] = { tp, fp: fp.length, fn: fn.length, removed: fp, added: fn };
    out.totals.tp += tp; out.totals.fp += fp.length; out.totals.fn += fn.length;
  }
  const mf = model?.followUp?.dueDate ?? null;
  const vf = verified?.followUp?.dueDate ?? null;
  out.fields.followUp = { match: mf === vf, model: mf, verified: vf };
  const { tp, fp, fn } = out.totals;
  out.precision = tp + fp ? tp / (tp + fp) : 1;
  out.recall = tp + fn ? tp / (tp + fn) : 1;
  out.f1 = out.precision + out.recall ? (2 * out.precision * out.recall) / (out.precision + out.recall) : 0;
  out.edited = fp + fn > 0 || !out.fields.followUp.match;
  return out;
}

/**
 * How safe was triage? Items the extractor did not flag ("auto-accepted")
 * should survive the doctor's review unchanged.
 */
export function triageStats(model, verified) {
  let autoAccepted = 0; let autoKept = 0; let flagged = 0; let flaggedKept = 0;
  for (const [field, key] of Object.entries(keyers)) {
    const finalKeys = new Set((verified?.[field] ?? []).map(key));
    for (const item of model?.[field] ?? []) {
      const kept = finalKeys.has(key(item));
      if (item.check) { flagged++; if (kept) flaggedKept++; } else { autoAccepted++; if (kept) autoKept++; }
    }
  }
  return { autoAccepted, autoKept, flagged, flaggedKept, autoPrecision: autoAccepted ? autoKept / autoAccepted : null };
}
