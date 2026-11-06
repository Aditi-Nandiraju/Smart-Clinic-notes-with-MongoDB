// Simulated doctor review for seeding: start from the extractor's output, keep
// every item the doctor would accept (with its source span), fix attributes,
// add what the extractor missed and drop false positives.
import { DIAGNOSES } from '../../src/nlp/lexicon/conditions.js';
import { DRUGS } from '../../src/nlp/lexicon/drugs.js';
import { LABS } from '../../src/nlp/lexicon/measurements.js';

const dxByCode = new Map(DIAGNOSES.map((d) => [d.code, d]));
const drugBy = new Map(DRUGS.map((d) => [d.generic, d]));
const labBy = new Map(LABS.map((l) => [l.test, l]));

export function mergeWithTruth(model, gt) {
  const used = new Set();
  const take = (list, pred) => {
    const i = (list ?? []).findIndex((x, k) => !used.has(`${list === model.medications ? 'm' : ''}${k}${list.length}`) && pred(x));
    return i >= 0 ? list[i] : null;
  };
  const symptoms = gt.symptoms.map((s) => {
    const m = take(model.symptoms, (x) => x.term === s.term && x.negated === s.negated);
    return m ? { ...m } : { term: s.term, negated: s.negated, durationDays: null, duration: null, span: null, addedByReviewer: true };
  });
  const diagnoses = gt.diagnoses.map((d) => {
    const m = take(model.diagnoses, (x) => x.code === d.code && x.certainty === d.certainty);
    const ref = dxByCode.get(d.code);
    return m ? { ...m, context: d.context } : { term: ref?.term ?? d.code, code: d.code, chronic: !!ref?.chronic, certainty: d.certainty, context: d.context, span: null, addedByReviewer: true };
  });
  const medications = gt.medications.map((g) => {
    const m = take(model.medications, (x) => x.generic === g.generic && x.action === g.action) ?? take(model.medications, (x) => x.generic === g.generic);
    const base = m ?? { generic: g.generic, drugClass: drugBy.get(g.generic)?.cls ?? null, form: null, span: null, flags: [], addedByReviewer: true };
    return { ...base, dose: g.dose ?? null, unit: g.unit ?? null, frequency: g.frequency ?? null, action: g.action, durationDays: g.durationDays ?? base.durationDays ?? null, negated: false };
  });
  const labs = gt.labs.map((g) => {
    const m = take(model.labs, (x) => x.test === g.test);
    const ref = labBy.get(g.test);
    let flag = m?.flag ?? null;
    if (typeof g.value === 'number' && ref) flag = ref.high != null && g.value > ref.high ? 'high' : ref.low != null && g.value < ref.low ? 'low' : 'normal';
    if (typeof g.value === 'string') flag = g.value === 'positive' ? 'abnormal' : 'normal';
    return { ...(m ?? { span: null, addedByReviewer: true }), test: g.test, value: g.value, unit: m?.unit ?? ref?.unit ?? null, flag };
  });
  const vitals = gt.vitals.map((g) => {
    const m = take(model.vitals, (x) => x.name === g.name);
    return { ...(m ?? { span: null, unit: null, addedByReviewer: true }), name: g.name, value: g.value };
  });
  let followUp = null;
  if (gt.followUp) {
    const mf = model.followUp;
    followUp = {
      dueDate: gt.followUp.dueDate,
      inDays: mf?.dueDate === gt.followUp.dueDate ? mf.inDays : null,
      asNeeded: gt.followUp.asNeeded,
      purpose: mf?.purpose ?? null,
      span: mf?.span ?? null,
    };
  }
  return { symptoms, diagnoses, medications, allergies: model.allergies, nkda: model.nkda, vitals, labs, followUp, meta: { ...model.meta, reviewed: true } };
}
