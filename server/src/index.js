// Mongoose models. Collection-level $jsonSchema validators are applied in db.js
// so the database itself rejects malformed documents, not just the app.
import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

export const ROLES = ['doctor', 'staff', 'admin'];
export const ENCOUNTER_STATUSES = ['pending', 'needs_review', 'verified'];
export const FOLLOWUP_STATUSES = ['due', 'completed', 'overdue', 'cancelled'];

const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const patientSchema = new Schema({
  patientCode: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  nameLower: { type: String, index: true },
  dob: { type: Date, required: true },
  sex: { type: String, enum: ['F', 'M', 'O'], required: true },
  phoneEnc: { type: String }, // AES-256-GCM, see services/fieldCrypto.js
  allergies: [{ type: String }],
  chronicConditions: [{ _id: false, term: String, code: String }],
  synthetic: { type: Boolean, default: true },
}, { timestamps: true });
patientSchema.pre('save', function setLower(next) { this.nameLower = this.name.toLowerCase(); next(); });

const encounterSchema = new Schema({
  patientId: { type: ObjectId, ref: 'Patient', required: true },
  doctorId: { type: ObjectId, ref: 'User', required: true },
  visitDate: { type: Date, required: true },
  rawNote: { type: String, required: true, maxlength: 20000 },
  status: { type: String, enum: ENCOUNTER_STATUSES, default: 'pending' },
  extraction: { type: Schema.Types.Mixed, default: null },      // current (verified or proposed) structure
  modelExtraction: { type: Schema.Types.Mixed, default: null }, // untouched model output, for accuracy tracking
  corrections: { type: Schema.Types.Mixed, default: null },
  extractorVersion: String,
  processingError: String,
  verifiedBy: { type: ObjectId, ref: 'User' },
  verifiedAt: Date,
  review: { type: Schema.Types.Mixed, default: null }, // seconds spent, auto-accept statistics
}, { timestamps: true });
encounterSchema.index({ patientId: 1, visitDate: -1 });
encounterSchema.index({ status: 1, visitDate: -1 });
encounterSchema.index({ 'extraction.medications.generic': 1, status: 1 });
encounterSchema.index({ 'extraction.diagnoses.code': 1, status: 1 });
encounterSchema.index({ visitDate: -1 });

const noteChunkSchema = new Schema({
  encounterId: { type: ObjectId, ref: 'Encounter', required: true, index: true },
  patientId: { type: ObjectId, ref: 'Patient', required: true },
  visitDate: { type: Date, required: true },
  chunkIndex: { type: Number, default: 0 },
  text: { type: String, required: true },
  embedding: { type: [Number], required: true },
  embeddingModel: { type: String, required: true },
  diagnosisCodes: [String],
});
noteChunkSchema.index({ text: 'text' }, { default_language: 'english', name: 'chunk_text' });
noteChunkSchema.index({ embeddingModel: 1, patientId: 1, visitDate: -1 });

const followupSchema = new Schema({
  patientId: { type: ObjectId, ref: 'Patient', required: true },
  sourceEncounterId: { type: ObjectId, ref: 'Encounter', required: true },
  sourceVisitDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  reason: String,
  status: { type: String, enum: FOLLOWUP_STATUSES, default: 'due' },
  closedByEncounterId: { type: ObjectId, ref: 'Encounter' },
  closedAt: Date,
  reminders: [{ _id: false, at: Date, channel: String, note: String, by: { type: ObjectId, ref: 'User' } }],
}, { timestamps: true });
followupSchema.index({ status: 1, dueDate: 1 });
followupSchema.index({ patientId: 1, status: 1 });
followupSchema.index({ sourceEncounterId: 1 }, { unique: true });

// Time-series collection: created explicitly in db.js
const auditSchema = new Schema({
  at: { type: Date, required: true },
  meta: { userId: ObjectId, role: String, name: String },
  action: String,
  target: String,
  detail: Schema.Types.Mixed,
}, { timeseries: { timeField: 'at', metaField: 'meta', granularity: 'seconds' }, autoCreate: false, versionKey: false });

const assistantLogSchema = new Schema({
  userId: { type: ObjectId, ref: 'User' },
  question: String,
  intent: String,
  confidence: Number,
  slots: Schema.Types.Mixed,
  route: String,
  pipeline: String,
  resultCount: Number,
  answer: String,
  rating: { type: Number, enum: [-1, 1, null], default: null },
  latencyMs: Number,
}, { timestamps: true });
assistantLogSchema.index({ createdAt: -1 });

// Vocabulary the clinic has taught the extractor (from doctors' corrections)
const vocabularySchema = new Schema({
  type: { type: String, enum: ['drug', 'symptom', 'diagnosis'], required: true },
  alias: { type: String, required: true, lowercase: true, trim: true },
  concept: { type: Schema.Types.Mixed, required: true }, // drug {generic, cls, unit} | symptom {term} | diagnosis {term, code}
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  source: { type: String, enum: ['correction', 'manual'], default: 'correction' },
  learnedFrom: { type: ObjectId, ref: 'Encounter' },
  createdBy: { type: ObjectId, ref: 'User' },
  uses: { type: Number, default: 1 },
}, { timestamps: true });
vocabularySchema.index({ type: 1, alias: 1 }, { unique: true });

const groundTruthSchema = new Schema({
  encounterId: { type: ObjectId, ref: 'Encounter', required: true, unique: true },
  truth: Schema.Types.Mixed,
  kind: { type: String, default: 'generated' },
});

export const User = model('User', userSchema);
export const Patient = model('Patient', patientSchema);
export const Encounter = model('Encounter', encounterSchema);
export const NoteChunk = model('NoteChunk', noteChunkSchema, 'note_chunks');
export const Followup = model('Followup', followupSchema);
export const AuditLog = model('AuditLog', auditSchema, 'audit_logs');
export const AssistantLog = model('AssistantLog', assistantLogSchema, 'assistant_logs');
export const Vocabulary = model('Vocabulary', vocabularySchema, 'vocabulary');
export const GroundTruth = model('GroundTruth', groundTruthSchema, 'eval_ground_truth');
