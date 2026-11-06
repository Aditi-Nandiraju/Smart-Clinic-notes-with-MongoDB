// Clinic analytics, all computed with aggregation pipelines over verified data.
import { Router } from 'express';
import { Encounter, Followup, Patient, AssistantLog, Vocabulary } from '../models/index.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const daysAgo = (n) => new Date(Date.now() - n * 864e5);

export const analyticsRouter = Router();

analyticsRouter.get('/overview', wrap(async (req, res) => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [patients, visitsThisMonth, queue, overdue, dueThisWeek, compliance, quality, feedback] = await Promise.all([
    Patient.estimatedDocumentCount(),
    Encounter.countDocuments({ status: 'verified', visitDate: { $gte: monthStart } }),
    Encounter.countDocuments({ status: { $in: ['pending', 'needs_review'] } }),
    Followup.countDocuments({ status: 'overdue' }),
    Followup.countDocuments({ status: 'due', dueDate: { $gte: daysAgo(1), $lt: new Date(Date.now() + 7 * 864e5) } }),
    Followup.aggregate([
      { $match: { dueDate: { $gte: daysAgo(90), $lt: now }, status: { $in: ['completed', 'overdue'] } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Encounter.aggregate([
      { $match: { status: 'verified', 'corrections.f1': { $exists: true } } },
      { $group: { _id: null, f1: { $avg: '$corrections.f1' }, precision: { $avg: '$corrections.precision' }, recall: { $avg: '$corrections.recall' }, edited: { $sum: { $cond: ['$corrections.edited', 1, 0] } }, n: { $sum: 1 } } },
    ]),
    AssistantLog.aggregate([
      { $match: { rating: { $in: [1, -1] } } },
      { $group: { _id: null, up: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } }, n: { $sum: 1 } } },
    ]),
  ]);
  const c = Object.fromEntries(compliance.map((x) => [x._id, x.n]));
  const done = c.completed ?? 0; const missed = c.overdue ?? 0;
  res.json({
    patients,
    visitsThisMonth,
    reviewQueue: queue,
    overdueFollowups: overdue,
    dueNext7Days: dueThisWeek,
    followupCompliance90d: done + missed ? done / (done + missed) : null,
    extraction: quality[0] ? { f1: quality[0].f1, precision: quality[0].precision, recall: quality[0].recall, editedShare: quality[0].edited / quality[0].n, reviewed: quality[0].n } : null,
    assistantHelpful: feedback[0] ? { share: feedback[0].up / feedback[0].n, ratings: feedback[0].n } : null,
  });
}));

analyticsRouter.get('/visits', wrap(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - months + 1, 1));
  res.json(await Encounter.aggregate([
    { $match: { status: 'verified', visitDate: { $gte: from } } },
    { $group: { _id: { $dateTrunc: { date: '$visitDate', unit: 'month' } }, visits: { $sum: 1 }, patients: { $addToSet: '$patientId' } } },
    { $project: { _id: 0, month: '$_id', visits: 1, patients: { $size: '$patients' } } },
    { $sort: { month: 1 } },
  ]));
}));

analyticsRouter.get('/diagnoses', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 730);
  res.json(await Encounter.aggregate([
    { $match: { status: 'verified', visitDate: { $gte: daysAgo(days) } } },
    { $unwind: '$extraction.diagnoses' },
    { $match: { 'extraction.diagnoses.certainty': { $ne: 'ruled_out' }, 'extraction.diagnoses.context': 'current' } },
    { $group: { _id: '$extraction.diagnoses.code', term: { $first: '$extraction.diagnoses.term' }, visits: { $sum: 1 }, patients: { $addToSet: '$patientId' } } },
    { $project: { _id: 0, code: '$_id', term: 1, visits: 1, patients: { $size: '$patients' } } },
    { $sort: { visits: -1 } },
    { $limit: Number(req.query.limit) || 12 },
  ]));
}));

analyticsRouter.get('/diagnosis-trend', wrap(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - months + 1, 1));
  const top = await Encounter.aggregate([
    { $match: { status: 'verified', visitDate: { $gte: from } } },
    { $unwind: '$extraction.diagnoses' },
    { $match: { 'extraction.diagnoses.certainty': { $ne: 'ruled_out' }, 'extraction.diagnoses.context': 'current' } },
    { $group: { _id: { code: '$extraction.diagnoses.code', month: { $dateTrunc: { date: '$visitDate', unit: 'month' } } }, term: { $first: '$extraction.diagnoses.term' }, n: { $sum: 1 } } },
    { $sort: { '_id.month': 1 } },
  ]);
  res.json(top.map((r) => ({ code: r._id.code, term: r.term, month: r._id.month, visits: r.n })));
}));

analyticsRouter.get('/medications', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 730);
  res.json(await Encounter.aggregate([
    { $match: { status: 'verified', visitDate: { $gte: daysAgo(days) } } },
    { $unwind: '$extraction.medications' },
    { $match: { 'extraction.medications.action': { $in: ['start', 'prescribe', 'increase', 'decrease', 'continue'] }, 'extraction.medications.negated': { $ne: true } } },
    { $group: { _id: '$extraction.medications.generic', drugClass: { $first: '$extraction.medications.drugClass' }, prescriptions: { $sum: 1 }, patients: { $addToSet: '$patientId' } } },
    { $project: { _id: 0, drug: '$_id', drugClass: 1, prescriptions: 1, patients: { $size: '$patients' } } },
    { $sort: { prescriptions: -1 } },
    { $limit: Number(req.query.limit) || 12 },
  ]));
}));

analyticsRouter.get('/followup-compliance', wrap(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - months + 1, 1));
  res.json(await Followup.aggregate([
    { $match: { dueDate: { $gte: from, $lt: new Date() } } },
    { $group: { _id: { month: { $dateTrunc: { date: '$dueDate', unit: 'month' } }, status: '$status' }, n: { $sum: 1 } } },
    { $group: { _id: '$_id.month', counts: { $push: { k: '$_id.status', v: '$n' } } } },
    { $project: { _id: 0, month: '$_id', counts: { $arrayToObject: '$counts' } } },
    { $sort: { month: 1 } },
  ]));
}));

// Review effort and triage safety, from what doctors actually did when verifying
analyticsRouter.get('/review', wrap(async (req, res) => {
  const [r] = await Encounter.aggregate([
    { $match: { status: 'verified', 'review.seconds': { $type: 'number' } } },
    { $group: { _id: null, notes: { $sum: 1 }, simulated: { $sum: { $cond: ['$review.simulated', 1, 0] } }, seconds: { $avg: '$review.seconds' }, autoAccepted: { $sum: '$review.autoAccepted' }, autoKept: { $sum: '$review.autoKept' }, flagged: { $sum: '$review.flagged' }, flaggedKept: { $sum: '$review.flaggedKept' }, noCheck: { $sum: { $cond: [{ $eq: ['$review.flagged', 0] }, 1, 0] } }, secondsNoCheck: { $avg: { $cond: [{ $eq: ['$review.flagged', 0] }, '$review.seconds', null] } }, secondsWithCheck: { $avg: { $cond: [{ $gt: ['$review.flagged', 0] }, '$review.seconds', null] } } } },
  ]);
  const [learned] = await Vocabulary.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, n: { $sum: 1 }, uses: { $sum: '$uses' } } }]);
  res.json(r ? { ...r, _id: undefined, autoPrecision: r.autoAccepted ? r.autoKept / r.autoAccepted : null, autoShare: r.autoAccepted + r.flagged ? r.autoAccepted / (r.autoAccepted + r.flagged) : null, learnedTerms: learned?.n ?? 0 } : { notes: 0, learnedTerms: learned?.n ?? 0 });
}));

analyticsRouter.get('/extraction-quality', wrap(async (req, res) => {
  const fields = ['symptoms', 'diagnoses', 'medications', 'labs', 'vitals'];
  const group = { _id: null, notes: { $sum: 1 }, followUpMatch: { $sum: { $cond: ['$corrections.fields.followUp.match', 1, 0] } } };
  for (const f of fields) for (const k of ['tp', 'fp', 'fn']) group[`${f}_${k}`] = { $sum: `$corrections.fields.${f}.${k}` };
  const [r] = await Encounter.aggregate([{ $match: { status: 'verified', corrections: { $ne: null } } }, { $group: group }]);
  if (!r) return res.json({ notes: 0, fields: [] });
  res.json({
    notes: r.notes,
    followUpAccuracy: r.followUpMatch / r.notes,
    fields: fields.map((f) => {
      const tp = r[`${f}_tp`]; const fp = r[`${f}_fp`]; const fn = r[`${f}_fn`];
      const precision = tp + fp ? tp / (tp + fp) : null; const recall = tp + fn ? tp / (tp + fn) : null;
      return { field: f, tp, fp, fn, precision, recall, f1: precision && recall ? (2 * precision * recall) / (precision + recall) : null };
    }),
  });
}));
