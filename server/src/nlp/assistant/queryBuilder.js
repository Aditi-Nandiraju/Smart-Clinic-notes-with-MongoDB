// Turns (intent, slots) into a MongoDB aggregation pipeline plus a description
// of the result table. Pipelines are plain JSON so they can be shown to the
// user ("show query") and checked by validator.js before they run.

import mongoose from 'mongoose';

const ACTIVE_ACTIONS = ['start', 'continue', 'prescribe', 'increase', 'decrease'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const day = 864e5;

function timeMatch(field, time) {
  if (!time) return {};
  return { [field]: { $gte: new Date(time.from), $lt: new Date(time.to) } };
}

function drugMatch(slots, prefix) {
  const ors = [];
  if (slots.drugs.length) ors.push({ [`${prefix}generic`]: { $in: slots.drugs } });
  for (const c of slots.drugClasses) ors.push({ [`${prefix}drugClass`]: { $regex: escapeRe(c), $options: 'i' } });
  if (!ors.length) return null;
  return ors.length === 1 ? ors[0] : { $or: ors };
}

function describeDrugs(slots) {
  return [...slots.drugs, ...slots.drugClasses.map((c) => `${c}s`)].join(' / ');
}

const patientLookup = [
  { $lookup: { from: 'patients', localField: '_id.patientId', foreignField: '_id', as: 'patient' } },
  { $unwind: '$patient' },
];

/** Latest verified encounter for each follow-up's patient, used to filter by drug or diagnosis. */
function latestEncounterLookup() {
  return {
    $lookup: {
      from: 'encounters',
      let: { pid: '$patientId' },
      pipeline: [
        { $match: { status: 'verified', $expr: { $eq: ['$patientId', '$$pid'] } } },
        { $sort: { visitDate: -1 } },
        { $limit: 1 },
        { $project: { visitDate: 1, 'extraction.medications': 1, 'extraction.diagnoses': 1 } },
      ],
      as: 'latest',
    },
  };
}

function followupFilters(slots) {
  const conds = [];
  const dm = drugMatch(slots, 'latest.extraction.medications.');
  if (dm) conds.push(dm);
  if (slots.diagnoses.length) conds.push({ 'latest.extraction.diagnoses.code': { $in: slots.diagnoses.map((d) => d.code) } });
  return conds.length ? [{ $match: conds.length === 1 ? conds[0] : { $and: conds } }] : [];
}

const builders = {
  overdue_followups(slots, now) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const due = { $lt: today };
    if (slots.time) { due.$gte = new Date(slots.time.from); if (new Date(slots.time.to) < today) due.$lt = new Date(slots.time.to); }
    return {
      collection: 'followups',
      title: `Overdue follow-ups${slots.time ? ` (due ${slots.time.label})` : ''}${describeDrugs(slots) ? ` for patients on ${describeDrugs(slots)}` : ''}${slots.diagnoses.length ? ` with ${slots.diagnoses.map((d) => d.term).join(' / ')}` : ''}`,
      pipeline: [
        { $match: { status: { $in: ['due', 'overdue'] }, dueDate: due } },
        latestEncounterLookup(),
        ...followupFilters(slots),
        { $lookup: { from: 'patients', localField: 'patientId', foreignField: '_id', as: 'patient' } },
        { $unwind: '$patient' },
        { $project: { _id: 0, followupId: '$_id', patientId: 1, patient: '$patient.name', code: '$patient.patientCode', dueDate: 1, reason: 1, daysOverdue: { $floor: { $divide: [{ $subtract: [today, '$dueDate'] }, day] } }, lastVisit: { $first: '$latest.visitDate' } } },
        { $sort: { dueDate: 1 } },
        { $limit: slots.limit ?? 200 },
      ],
      columns: [['patient', 'Patient'], ['code', 'ID'], ['dueDate', 'Was due'], ['daysOverdue', 'Days overdue'], ['reason', 'Reason'], ['lastVisit', 'Last visit']],
    };
  },

  upcoming_followups(slots, now) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = slots.time ? new Date(Math.max(new Date(slots.time.from), today)) : today;
    const to = slots.time ? new Date(slots.time.to) : new Date(today.getTime() + 8 * day);
    return {
      collection: 'followups',
      title: `Follow-ups due ${slots.time?.label ?? 'in the next 7 days'}${describeDrugs(slots) ? ` for patients on ${describeDrugs(slots)}` : ''}${slots.diagnoses.length ? ` with ${slots.diagnoses.map((d) => d.term).join(' / ')}` : ''}`,
      pipeline: [
        { $match: { status: 'due', dueDate: { $gte: from, $lt: to } } },
        latestEncounterLookup(),
        ...followupFilters(slots),
        { $lookup: { from: 'patients', localField: 'patientId', foreignField: '_id', as: 'patient' } },
        { $unwind: '$patient' },
        { $project: { _id: 0, followupId: '$_id', patientId: 1, patient: '$patient.name', code: '$patient.patientCode', dueDate: 1, reason: 1, lastVisit: { $first: '$latest.visitDate' } } },
        { $sort: { dueDate: 1 } },
        { $limit: slots.limit ?? 200 },
      ],
      columns: [['patient', 'Patient'], ['code', 'ID'], ['dueDate', 'Due'], ['reason', 'Reason'], ['lastVisit', 'Last visit']],
    };
  },

  patients_on_drug(slots, now) {
    const dm = drugMatch(slots, 'extraction.medications.');
    if (!dm) return { needs: 'drug' };
    const actionFilter = slots.medAction ? { 'extraction.medications.action': slots.medAction } : {};
    const pipeline = [
      { $match: { status: 'verified', ...timeMatch('visitDate', slots.time), ...drugMatch(slots, 'extraction.medications.') } },
      { $unwind: '$extraction.medications' },
      { $match: { ...dm, 'extraction.medications.negated': { $ne: true }, ...actionFilter } },
      { $sort: { visitDate: -1 } },
      { $group: { _id: { patientId: '$patientId', generic: '$extraction.medications.generic' }, lastAction: { $first: '$extraction.medications.action' }, dose: { $first: '$extraction.medications.dose' }, unit: { $first: '$extraction.medications.unit' }, frequency: { $first: '$extraction.medications.frequency' }, lastSeen: { $first: '$visitDate' } } },
    ];
    // "currently on": the latest mention is not a stop, and a one-off prescription is recent
    if (!slots.medAction && !slots.time) {
      pipeline.push({ $match: { $or: [
        { lastAction: { $in: ['start', 'continue', 'increase', 'decrease'] } },
        { lastAction: 'prescribe', lastSeen: { $gte: new Date(now.getTime() - 90 * day) } },
      ] } });
    }
    if (slots.requireAllDrugs) {
      pipeline.push(
        { $group: { _id: { patientId: '$_id.patientId' }, drugs: { $addToSet: '$_id.generic' }, lastSeen: { $max: '$lastSeen' } } },
        { $match: { [`drugs.${slots.drugs.length - 1}`]: { $exists: true } } },
        ...patientLookup,
        { $project: { _id: 0, patientId: '$_id.patientId', patient: '$patient.name', code: '$patient.patientCode', drugs: 1, lastSeen: 1 } },
      );
    } else {
      pipeline.push(
        { $addFields: { patientId: '$_id.patientId' } },
        { $lookup: { from: 'patients', localField: 'patientId', foreignField: '_id', as: 'patient' } },
        { $unwind: '$patient' },
        { $project: { _id: 0, patientId: 1, patient: '$patient.name', code: '$patient.patientCode', drug: '$_id.generic', dose: 1, unit: 1, frequency: 1, lastAction: 1, lastSeen: 1 } },
      );
    }
    pipeline.push({ $sort: { lastSeen: -1 } }, { $limit: slots.limit ?? 300 });
    const verb = slots.medAction === 'start' ? 'started on' : slots.medAction === 'stop' ? 'who stopped' : slots.time ? 'prescribed' : 'currently on';
    return {
      collection: 'encounters',
      title: `Patients ${verb} ${slots.requireAllDrugs ? slots.drugs.join(' and ') : describeDrugs(slots)}${slots.time ? ` (${slots.time.label})` : ''}`,
      pipeline,
      countBy: 'patientId',
      columns: slots.requireAllDrugs
        ? [['patient', 'Patient'], ['code', 'ID'], ['drugs', 'Drugs'], ['lastSeen', 'Last seen']]
        : [['patient', 'Patient'], ['code', 'ID'], ['drug', 'Drug'], ['dose', 'Dose'], ['unit', 'Unit'], ['frequency', 'Frequency'], ['lastAction', 'Last action'], ['lastSeen', 'Last seen']],
    };
  },

  patients_with_diagnosis(slots) {
    if (!slots.diagnoses.length) return { needs: 'diagnosis' };
    const codes = slots.diagnoses.map((d) => d.code);
    const certainty = slots.certainty === 'provisional' ? 'provisional' : { $ne: 'ruled_out' };
    return {
      collection: 'encounters',
      title: `Patients with ${slots.certainty === 'provisional' ? 'suspected ' : ''}${slots.diagnoses.map((d) => d.term).join(' / ')}${slots.time ? ` (${slots.time.label})` : ''}`,
      pipeline: [
        { $match: { status: 'verified', 'extraction.diagnoses.code': { $in: codes }, ...timeMatch('visitDate', slots.time) } },
        { $unwind: '$extraction.diagnoses' },
        { $match: { 'extraction.diagnoses.code': { $in: codes }, 'extraction.diagnoses.certainty': certainty, 'extraction.diagnoses.context': { $ne: 'family' } } },
        { $group: { _id: { patientId: '$patientId' }, diagnosis: { $first: '$extraction.diagnoses.term' }, firstSeen: { $min: '$visitDate' }, lastSeen: { $max: '$visitDate' }, visits: { $sum: 1 } } },
        ...patientLookup,
        { $project: { _id: 0, patientId: '$_id.patientId', patient: '$patient.name', code: '$patient.patientCode', diagnosis: 1, firstSeen: 1, lastSeen: 1, visits: 1 } },
        { $sort: { lastSeen: -1 } },
        { $limit: slots.limit ?? 300 },
      ],
      columns: [['patient', 'Patient'], ['code', 'ID'], ['diagnosis', 'Diagnosis'], ['firstSeen', 'First recorded'], ['lastSeen', 'Last recorded'], ['visits', 'Visits']],
    };
  },

  patients_with_symptom(slots, now) {
    if (!slots.symptoms.length) return { needs: 'symptom' };
    const time = slots.time ?? { from: new Date(now.getTime() - 30 * day).toISOString(), to: new Date(now.getTime() + day).toISOString(), label: 'last 30 days' };
    return {
      collection: 'encounters',
      title: `Patients reporting ${slots.symptoms.join(' / ')} (${time.label})`,
      pipeline: [
        { $match: { status: 'verified', 'extraction.symptoms.term': { $in: slots.symptoms }, ...timeMatch('visitDate', time) } },
        { $unwind: '$extraction.symptoms' },
        { $match: { 'extraction.symptoms.term': { $in: slots.symptoms }, 'extraction.symptoms.negated': false } },
        { $group: { _id: { patientId: '$patientId' }, symptom: { $first: '$extraction.symptoms.term' }, duration: { $first: '$extraction.symptoms.duration' }, lastSeen: { $max: '$visitDate' }, encounterId: { $first: '$_id' } } },
        ...patientLookup,
        { $project: { _id: 0, patientId: '$_id.patientId', patient: '$patient.name', code: '$patient.patientCode', symptom: 1, duration: 1, lastSeen: 1, encounterId: 1 } },
        { $sort: { lastSeen: -1 } },
        { $limit: slots.limit ?? 300 },
      ],
      columns: [['patient', 'Patient'], ['code', 'ID'], ['symptom', 'Symptom'], ['duration', 'Duration'], ['lastSeen', 'Visit']],
    };
  },

  lab_threshold(slots) {
    if (!slots.lab) return { needs: 'lab' };
    const { test, op, value } = slots.lab;
    const cond = op ? { latestValue: { [op]: value } } : {};
    return {
      collection: 'encounters',
      title: `Patients whose latest ${test}${op ? ` is ${op === '$gt' ? 'above' : 'below'} ${value}` : ''}${slots.time ? ` (${slots.time.label})` : ''}`,
      pipeline: [
        { $match: { status: 'verified', 'extraction.labs.test': test, ...timeMatch('visitDate', slots.time) } },
        { $unwind: '$extraction.labs' },
        { $match: { 'extraction.labs.test': test } },
        { $sort: { visitDate: -1 } },
        { $group: { _id: { patientId: '$patientId' }, latestValue: { $first: '$extraction.labs.value' }, unit: { $first: '$extraction.labs.unit' }, flag: { $first: '$extraction.labs.flag' }, measuredOn: { $first: '$visitDate' }, values: { $push: '$extraction.labs.value' } } },
        { $match: { latestValue: { $type: 'number' }, ...cond } },
        ...patientLookup,
        { $project: { _id: 0, patientId: '$_id.patientId', patient: '$patient.name', code: '$patient.patientCode', latestValue: 1, unit: 1, flag: 1, measuredOn: 1, previous: { $arrayElemAt: ['$values', 1] } } },
        { $sort: { latestValue: op === '$lt' ? 1 : -1 } },
        { $limit: slots.limit ?? 300 },
      ],
      columns: [['patient', 'Patient'], ['code', 'ID'], ['latestValue', `Latest ${test}`], ['unit', 'Unit'], ['previous', 'Previous'], ['measuredOn', 'Measured on']],
    };
  },

  top_diagnoses(slots, now) {
    const time = slots.time ?? { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: new Date(now.getTime() + day).toISOString(), label: 'this month' };
    return {
      collection: 'encounters',
      title: `Most common diagnoses (${time.label})`,
      pipeline: [
        { $match: { status: 'verified', ...timeMatch('visitDate', time) } },
        { $unwind: '$extraction.diagnoses' },
        { $match: { 'extraction.diagnoses.certainty': { $ne: 'ruled_out' }, 'extraction.diagnoses.context': { $in: ['current', 'known'] } } },
        { $group: { _id: '$extraction.diagnoses.code', diagnosis: { $first: '$extraction.diagnoses.term' }, visits: { $sum: 1 }, patients: { $addToSet: '$patientId' } } },
        { $project: { _id: 0, code: '$_id', diagnosis: 1, visits: 1, patients: { $size: '$patients' } } },
        { $sort: { visits: -1 } },
        { $limit: slots.limit ?? 10 },
      ],
      chart: { x: 'diagnosis', y: 'visits' },
      columns: [['diagnosis', 'Diagnosis'], ['code', 'ICD-10'], ['visits', 'Visits'], ['patients', 'Patients']],
    };
  },

  top_medications(slots, now) {
    const time = slots.time ?? { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: new Date(now.getTime() + day).toISOString(), label: 'this month' };
    const dm = drugMatch(slots, 'extraction.medications.');
    return {
      collection: 'encounters',
      title: `Most prescribed ${describeDrugs(slots) || 'medications'} (${time.label})`,
      pipeline: [
        { $match: { status: 'verified', ...timeMatch('visitDate', time) } },
        { $unwind: '$extraction.medications' },
        { $match: { 'extraction.medications.action': { $in: slots.medAction === 'start' ? ['start'] : ['start', 'prescribe', 'increase', 'decrease', 'continue'] }, 'extraction.medications.negated': { $ne: true }, ...(dm ?? {}) } },
        { $group: { _id: '$extraction.medications.generic', drugClass: { $first: '$extraction.medications.drugClass' }, prescriptions: { $sum: 1 }, patients: { $addToSet: '$patientId' } } },
        { $project: { _id: 0, drug: '$_id', drugClass: 1, prescriptions: 1, patients: { $size: '$patients' } } },
        { $sort: { prescriptions: -1 } },
        { $limit: slots.limit ?? 10 },
      ],
      chart: { x: 'drug', y: 'prescriptions' },
      columns: [['drug', 'Medication'], ['drugClass', 'Class'], ['prescriptions', 'Prescriptions'], ['patients', 'Patients']],
    };
  },

  visit_stats(slots, now, question) {
    if (/\breview\b|\bpending\b|\bunverified\b|\bwaiting\b/i.test(question)) {
      return {
        collection: 'encounters',
        title: 'Notes waiting for review',
        unverified: true,
        pipeline: [
          { $match: { status: { $in: ['pending', 'needs_review'] } } },
          { $group: { _id: '$status', notes: { $sum: 1 }, oldest: { $min: '$visitDate' } } },
          { $project: { _id: 0, status: '$_id', notes: 1, oldest: 1 } },
          { $sort: { status: 1 } },
        ],
        columns: [['status', 'Status'], ['notes', 'Notes'], ['oldest', 'Oldest visit']],
        sumField: 'notes',
      };
    }
    const time = slots.time ?? { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: new Date(now.getTime() + day).toISOString(), label: 'this month' };
    const span = (new Date(time.to) - new Date(time.from)) / day;
    const unit = span > 62 ? 'month' : span > 14 ? 'week' : 'day';
    return {
      collection: 'encounters',
      title: `Visits (${time.label}), by ${unit}`,
      pipeline: [
        { $match: { status: 'verified', ...timeMatch('visitDate', time) } },
        { $group: { _id: { $dateTrunc: { date: '$visitDate', unit, startOfWeek: 'monday' } }, visits: { $sum: 1 }, patients: { $addToSet: '$patientId' } } },
        { $project: { _id: 0, period: '$_id', visits: 1, patients: { $size: '$patients' } } },
        { $sort: { period: 1 } },
        { $limit: 400 },
      ],
      chart: { x: 'period', y: 'visits' },
      columns: [['period', unit === 'day' ? 'Date' : `${unit[0].toUpperCase()}${unit.slice(1)} of`], ['visits', 'Visits'], ['patients', 'Patients']],
      sumField: 'visits',
    };
  },
};

export function buildQuery(intent, slots, { now = new Date(), question = '' } = {}) {
  const b = builders[intent];
  if (!b) return null;
  return b(slots, now, question);
}

/** Render a pipeline for display, with dates and ObjectIds in shell syntax. */
export function pipelineToString(collection, pipeline) {
  const json = JSON.stringify(pipeline, (k, v) => {
    if (v instanceof mongoose.Types.ObjectId) return `__OID__${v}`;
    return v;
  }, 2)
    .replace(/"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/g, 'ISODate("$1")')
    .replace(/"__OID__([a-f0-9]{24})"/g, 'ObjectId("$1")');
  return `db.${collection}.aggregate(${json})`;
}

export const ACTIVE_MED_ACTIONS = ACTIVE_ACTIONS;
