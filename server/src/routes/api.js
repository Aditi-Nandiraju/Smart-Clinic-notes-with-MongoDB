import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User, Patient, Encounter, Followup, AuditLog, AssistantLog, Vocabulary } from '../models/index.js';
import { requireAuth, requireRole, signToken, audit } from '../middleware/auth.js';
import { entitySpans, EXTRACTOR_VERSION, lexiconStats, REVIEW_THRESHOLD } from '../nlp/extractor.js';
import { processEncounter, verifyEncounter, maybeRetrainNer } from '../services/encounters.js';
import { runExtraction } from '../services/extraction.js';
import { loadVocabulary } from '../services/vocabulary.js';
import { nerStatus } from '../nlp/ml/nerService.js';
import { ollamaStatus } from '../nlp/llm/ollama.js';
import { patientResource, encounterResources, bundle } from '../services/fhir.js';
import { config } from '../config.js';
import { changeStreamsAvailable } from '../services/changeStreams.js';
import { searchNotes } from '../services/search.js';
import { encrypt, decrypt, maskPhone } from '../services/fieldCrypto.js';
import { answerQuestion, assistantInfo, summarisePatient, invalidatePatientNames } from '../nlp/assistant/assistant.js';
import { embeddingModelName } from '../nlp/embedder.js';
import { DIAGNOSES } from '../nlp/lexicon/conditions.js';
import { DRUGS } from '../nlp/lexicon/drugs.js';
import { analyticsRouter } from './analytics.js';

const { isValidObjectId } = mongoose;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DOCTORS = ['doctor', 'admin'];
const ALL = ['doctor', 'staff', 'admin'];

export const api = Router();

api.get('/health', wrap(async (req, res) => {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  res.json({
    ok: true,
    database: mongoose.connection.name,
    replicaSet: hello.setName ?? null,
    changeStreams: changeStreamsAvailable(),
    extractor: EXTRACTOR_VERSION,
    embeddingModel: embeddingModelName(),
    assistant: assistantInfo(),
    ner: nerStatus(),
    ollama: await ollamaStatus(),
    lexicon: lexiconStats(),
  });
}));

// --- auth ------------------------------------------------------------------
api.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await User.findOne({ email: String(email ?? '').toLowerCase() });
  if (!user || !user.active || !(await bcrypt.compare(String(password ?? ''), user.passwordHash))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  req.user = user;
  audit(req, 'login', `user:${user._id}`);
  res.json({ token: signToken(user), user: { id: user._id, name: user.name, role: user.role, email: user.email } });
}));

api.use(requireAuth);

api.get('/auth/me', (req, res) => res.json({ id: req.user._id, name: req.user.name, role: req.user.role, email: req.user.email }));

api.get('/lexicon', (req, res) => res.json({
  diagnoses: DIAGNOSES.map((d) => ({ term: d.term, code: d.code })),
  drugs: DRUGS.map((d) => ({ generic: d.generic, cls: d.cls, unit: d.unit })),
}));

// --- patients ---------------------------------------------------------------
api.get('/patients', requireRole(...ALL), wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const filter = q ? { $or: [{ nameLower: { $regex: q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }, { patientCode: q.toUpperCase() }] } : {};
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  const [patients, total] = await Promise.all([
    Patient.aggregate([
      { $match: filter },
      { $sort: { name: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'encounters', let: { pid: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$patientId', '$$pid'] } } }, { $sort: { visitDate: -1 } }, { $limit: 1 }, { $project: { visitDate: 1, status: 1 } }], as: 'last' } },
      { $lookup: { from: 'followups', let: { pid: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$patientId', '$$pid'] }, status: { $in: ['due', 'overdue'] } } }, { $sort: { dueDate: 1 } }, { $limit: 1 }], as: 'fu' } },
      { $project: { name: 1, patientCode: 1, dob: 1, sex: 1, chronicConditions: 1, lastVisit: { $first: '$last.visitDate' }, nextFollowup: { $first: '$fu' } } },
    ]),
    Patient.countDocuments(filter),
  ]);
  res.json({ total, patients });
}));

api.post('/patients', requireRole(...ALL), wrap(async (req, res) => {
  const { name, dob, sex, phone, allergies } = req.body ?? {};
  if (!name || !dob || !['F', 'M', 'O'].includes(sex)) return res.status(400).json({ error: 'Name, date of birth and sex are required' });
  const count = await Patient.estimatedDocumentCount();
  const patient = await Patient.create({
    patientCode: `P${String(count + 1001).padStart(5, '0')}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    name, dob: new Date(dob), sex, phoneEnc: encrypt(phone), allergies: allergies ?? [], synthetic: false,
  });
  invalidatePatientNames();
  audit(req, 'patient.create', `patient:${patient._id}`);
  res.status(201).json(patient);
}));

api.get('/patients/:id', requireRole(...ALL), wrap(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const p = await Patient.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  const showNotes = DOCTORS.includes(req.user.role);
  const encounters = await Encounter.find({ patientId: p._id }).sort({ visitDate: -1 })
    .select(showNotes ? 'visitDate status rawNote extraction.diagnoses extraction.medications extraction.followUp verifiedAt' : 'visitDate status').lean();
  const followups = await Followup.find({ patientId: p._id }).sort({ dueDate: -1 }).lean();
  const summary = showNotes ? await summarisePatient(p._id, 3) : null;
  audit(req, 'patient.view', `patient:${p._id}`);
  res.json({
    patient: { ...p, phoneEnc: undefined, phoneMasked: maskPhone(decrypt(p.phoneEnc)) },
    encounters, followups, summary,
  });
}));

api.get('/patients/:id/contact', requireRole('staff', 'admin'), wrap(async (req, res) => {
  const p = await Patient.findById(req.params.id).select('name phoneEnc').lean();
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  audit(req, 'patient.contact_reveal', `patient:${p._id}`);
  res.json({ name: p.name, phone: decrypt(p.phoneEnc) });
}));

// --- notes / encounters ----------------------------------------------------
api.post('/nlp/extract', requireRole(...DOCTORS), wrap(async (req, res) => {
  const { text, visitDate, llm } = req.body ?? {};
  // live preview uses rules + ML only (fast); pass llm: true to include the local LLM
  const extraction = await runExtraction(String(text ?? '').slice(0, 20000), { visitDate: visitDate ? new Date(visitDate) : new Date(), llm: llm ? 'auto' : 'off' });
  res.json({ extraction, entities: entitySpans(extraction) });
}));

api.post('/encounters', requireRole('doctor'), wrap(async (req, res) => {
  const { patientId, visitDate, rawNote } = req.body ?? {};
  if (!isValidObjectId(patientId) || !(await Patient.exists({ _id: patientId }))) return res.status(400).json({ error: 'Choose a valid patient' });
  if (!rawNote || !String(rawNote).trim()) return res.status(400).json({ error: 'The note is empty' });
  const enc = await Encounter.create({ patientId, doctorId: req.user._id, visitDate: visitDate ? new Date(visitDate) : new Date(), rawNote: String(rawNote).trim(), status: 'pending' });
  audit(req, 'encounter.create', `encounter:${enc._id}`);
  // with change streams the extraction queue picks this up; otherwise process inline
  if (!changeStreamsAvailable()) await processEncounter(enc._id);
  res.status(201).json({ id: enc._id, status: changeStreamsAvailable() ? 'pending' : 'needs_review' });
}));

api.get('/encounters', requireRole(...DOCTORS), wrap(async (req, res) => {
  const status = String(req.query.status ?? 'needs_review');
  const filter = status === 'queue' ? { status: { $in: ['pending', 'needs_review'] } } : { status };
  const rows = await Encounter.aggregate([
    { $match: filter },
    { $sort: { visitDate: 1 } },
    { $limit: 200 },
    { $lookup: { from: 'patients', localField: 'patientId', foreignField: '_id', as: 'patient' } },
    { $unwind: '$patient' },
    { $project: { visitDate: 1, status: 1, patientId: 1, patientName: '$patient.name', patientCode: '$patient.patientCode', preview: { $substrCP: ['$rawNote', 0, 140] }, warnings: { $size: { $ifNull: ['$extraction.meta.warnings', []] } }, createdAt: 1 } },
  ]);
  res.json(rows);
}));

api.get('/encounters/:id', requireRole(...DOCTORS), wrap(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const enc = await Encounter.findById(req.params.id).lean();
  if (!enc) return res.status(404).json({ error: 'Note not found' });
  const patient = await Patient.findById(enc.patientId).select('name patientCode dob sex allergies').lean();
  const doctor = await User.findById(enc.doctorId).select('name').lean();
  audit(req, 'encounter.view', `encounter:${enc._id}`);
  res.json({ encounter: enc, patient, doctor, entities: enc.extraction ? entitySpans(enc.extraction) : [] });
}));

api.post('/encounters/:id/reextract', requireRole('doctor'), wrap(async (req, res) => {
  const enc = await Encounter.findById(req.params.id);
  if (!enc) return res.status(404).json({ error: 'Note not found' });
  if (enc.status === 'verified') return res.status(409).json({ error: 'Verified notes are not re-extracted' });
  enc.status = 'pending';
  await enc.save();
  const out = await processEncounter(enc._id);
  res.json({ encounter: out, entities: entitySpans(out.extraction) });
}));

api.post('/encounters/:id/verify', requireRole('doctor'), wrap(async (req, res) => {
  const result = await verifyEncounter(req.params.id, req.body?.extraction, req.user, { reviewSeconds: req.body?.reviewSeconds });
  audit(req, 'encounter.verify', `encounter:${req.params.id}`, { closedFollowups: result.closedFollowups, edited: result.encounter.corrections?.edited ?? null, learned: result.learned.length });
  res.json({ ok: true, closedFollowups: result.closedFollowups, followup: result.followup, corrections: result.encounter.corrections, review: result.encounter.review, learned: result.learned });
}));

// --- FHIR export --------------------------------------------------------------
api.get('/encounters/:id/fhir', requireRole(...DOCTORS), wrap(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const enc = await Encounter.findById(req.params.id).lean();
  if (!enc) return res.status(404).json({ error: 'Note not found' });
  if (enc.status !== 'verified') return res.status(409).json({ error: 'Only verified notes can be exported' });
  const p = await Patient.findById(enc.patientId).lean();
  audit(req, 'fhir.export', `encounter:${enc._id}`);
  res.type('application/fhir+json').json(bundle([patientResource(p), ...encounterResources(enc, { includeNote: req.query.note === '1' })]));
}));

api.get('/patients/:id/fhir', requireRole(...DOCTORS), wrap(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const p = await Patient.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  const encs = await Encounter.find({ patientId: p._id, status: 'verified' }).sort({ visitDate: 1 }).lean();
  audit(req, 'fhir.export', `patient:${p._id}`, { encounters: encs.length });
  res.type('application/fhir+json').json(bundle([patientResource(p), ...encs.flatMap((e) => encounterResources(e, { includeNote: req.query.note === '1' }))]));
}));

// --- vocabulary learned from corrections ----------------------------------------
api.get('/vocabulary', requireRole(...DOCTORS), wrap(async (req, res) => {
  const rows = await Vocabulary.find().sort({ updatedAt: -1 }).limit(500).populate('createdBy', 'name').lean();
  res.json({ rows, stats: lexiconStats() });
}));

api.post('/vocabulary', requireRole(...DOCTORS), wrap(async (req, res) => {
  const { type, alias, concept } = req.body ?? {};
  if (!['drug', 'symptom', 'diagnosis'].includes(type) || !alias || !concept) return res.status(400).json({ error: 'type, alias and concept are required' });
  if (type === 'diagnosis' && !/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/.test(concept.code ?? '')) return res.status(400).json({ error: 'A diagnosis needs a valid ICD-10 code' });
  const row = await Vocabulary.findOneAndUpdate({ type, alias: String(alias).toLowerCase().trim() }, { $set: { concept, status: 'active', source: 'manual', createdBy: req.user._id } }, { upsert: true, new: true });
  await loadVocabulary();
  audit(req, 'vocabulary.add', `vocabulary:${row._id}`, { type, alias });
  res.status(201).json(row);
}));

api.patch('/vocabulary/:id', requireRole(...DOCTORS), wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'status must be active or disabled' });
  const row = await Vocabulary.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
  if (!row) return res.status(404).json({ error: 'Not found' });
  await loadVocabulary();
  audit(req, 'vocabulary.update', `vocabulary:${row._id}`, { status });
  res.json(row);
}));

// --- models ---------------------------------------------------------------------
api.get('/models', requireRole(...ALL), wrap(async (req, res) => {
  res.json({
    rules: { version: EXTRACTOR_VERSION, lexicon: lexiconStats(), reviewThreshold: REVIEW_THRESHOLD },
    ner: nerStatus(),
    llm: { ...(await ollamaStatus(true)), url: config.ollamaUrl, extraction: config.llmExtraction, assistant: config.llmAssistant },
    embeddings: embeddingModelName(),
    assistant: assistantInfo(),
  });
}));

api.post('/admin/retrain', requireRole('admin', 'doctor'), wrap(async (req, res) => {
  const meta = await maybeRetrainNer(true);
  if (!meta) return res.status(409).json({ error: 'Training is already running or there are too few verified notes with marked text' });
  audit(req, 'ner.retrain', 'ner-model', { f1: meta.heldOut?.f1 });
  res.json(meta);
}));

// --- follow-ups -------------------------------------------------------------
api.get('/followups', requireRole(...ALL), wrap(async (req, res) => {
  const status = String(req.query.status ?? 'overdue');
  const match = { status: { $in: status.split(',') } };
  if (req.query.from || req.query.to) match.dueDate = { ...(req.query.from ? { $gte: new Date(req.query.from) } : {}), ...(req.query.to ? { $lt: new Date(req.query.to) } : {}) };
  const rows = await Followup.aggregate([
    { $match: match },
    { $sort: { dueDate: 1 } },
    { $limit: 300 },
    { $lookup: { from: 'patients', localField: 'patientId', foreignField: '_id', as: 'patient' } },
    { $unwind: '$patient' },
    { $project: { dueDate: 1, status: 1, reason: 1, reminders: 1, patientId: 1, sourceEncounterId: 1, sourceVisitDate: 1, patientName: '$patient.name', patientCode: '$patient.patientCode' } },
  ]);
  res.json(rows);
}));

api.post('/followups/:id/remind', requireRole('staff', 'admin', 'doctor'), wrap(async (req, res) => {
  const { channel = 'phone', note = '' } = req.body ?? {};
  const fu = await Followup.findByIdAndUpdate(req.params.id, { $push: { reminders: { at: new Date(), channel, note: String(note).slice(0, 300), by: req.user._id } } }, { new: true });
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
  audit(req, 'followup.remind', `followup:${fu._id}`, { channel });
  res.json(fu);
}));

api.patch('/followups/:id', requireRole(...ALL), wrap(async (req, res) => {
  const set = {};
  if (req.body?.status && ['cancelled', 'due'].includes(req.body.status)) set.status = req.body.status;
  if (req.body?.dueDate) { set.dueDate = new Date(req.body.dueDate); set.status = 'due'; }
  const fu = await Followup.findByIdAndUpdate(req.params.id, { $set: set }, { new: true, runValidators: true });
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
  audit(req, 'followup.update', `followup:${fu._id}`, set);
  res.json(fu);
}));

// --- search and assistant ---------------------------------------------------
api.get('/search', requireRole(...DOCTORS), wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ results: [] });
  const t0 = Date.now();
  const results = await searchNotes(q, { mode: req.query.mode, limit: req.query.limit, patientId: isValidObjectId(req.query.patientId) ? req.query.patientId : undefined, diagnosisCode: req.query.diagnosisCode || undefined, from: req.query.from || undefined, to: req.query.to || undefined });
  audit(req, 'search', 'note_chunks', { q, n: results.length });
  res.json({ results, ms: Date.now() - t0, embeddingModel: embeddingModelName() });
}));

api.post('/assistant', requireRole(...ALL), wrap(async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Ask a question' });
  let out = await answerQuestion(question, { user: req.user });
  if (req.user.role === 'staff' && ['note_search', 'patient_summary'].includes(out.intent)) {
    out = { ...out, kind: 'refusal', answer: 'Clinical note content is available to doctors only. You can ask about follow-ups, visit counts and patient lists.', results: undefined, summary: undefined, rows: undefined };
  }
  audit(req, 'assistant.ask', 'assistant', { intent: out.intent, logId: out.id });
  res.json(out);
}));

api.post('/assistant/:id/feedback', requireRole(...ALL), wrap(async (req, res) => {
  const rating = Number(req.body?.rating);
  if (![1, -1].includes(rating)) return res.status(400).json({ error: 'rating must be 1 or -1' });
  await AssistantLog.updateOne({ _id: req.params.id, userId: req.user._id }, { $set: { rating } });
  res.json({ ok: true });
}));

api.get('/assistant/info', (req, res) => res.json(assistantInfo()));

// --- analytics and admin ---------------------------------------------------
api.use('/analytics', requireRole(...ALL), analyticsRouter);

api.get('/admin/audit', requireRole('admin'), wrap(async (req, res) => {
  const rows = await AuditLog.find().sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 100, 500)).lean();
  res.json(rows);
}));

api.get('/admin/users', requireRole('admin'), wrap(async (req, res) => {
  res.json(await User.find().select('-passwordHash').sort({ role: 1, name: 1 }).lean());
}));

api.post('/admin/users', requireRole('admin'), wrap(async (req, res) => {
  const { name, email, password, role } = req.body ?? {};
  if (!name || !email || !password || String(password).length < 8) return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required' });
  const user = await User.create({ name, email, role, passwordHash: await bcrypt.hash(password, 10) });
  audit(req, 'user.create', `user:${user._id}`, { role });
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
}));
