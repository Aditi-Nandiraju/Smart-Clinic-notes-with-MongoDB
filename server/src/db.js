import mongoose from 'mongoose';
import { config } from './config.js';
import { ENCOUNTER_STATUSES, FOLLOWUP_STATUSES, ROLES } from './models/index.js';

// Database-level validators: the last line of defence if the NLP layer or an
// API bug produces a malformed document.
const VALIDATORS = {
  encounters: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['patientId', 'doctorId', 'visitDate', 'rawNote', 'status'],
      properties: {
        patientId: { bsonType: 'objectId' },
        doctorId: { bsonType: 'objectId' },
        visitDate: { bsonType: 'date' },
        rawNote: { bsonType: 'string', minLength: 1, maxLength: 20000 },
        status: { enum: ENCOUNTER_STATUSES },
        extraction: {
          bsonType: ['object', 'null'],
          properties: {
            symptoms: { bsonType: 'array', items: { bsonType: 'object', required: ['term', 'negated'], properties: { term: { bsonType: 'string' }, negated: { bsonType: 'bool' } } } },
            diagnoses: { bsonType: 'array', items: { bsonType: 'object', required: ['term', 'code', 'certainty'], properties: { code: { bsonType: 'string', pattern: '^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$' }, certainty: { enum: ['confirmed', 'provisional', 'ruled_out'] } } } },
            medications: { bsonType: 'array', items: { bsonType: 'object', required: ['generic', 'action'], properties: { generic: { bsonType: 'string' }, dose: { bsonType: ['double', 'int', 'long', 'decimal', 'null'], minimum: 0 }, action: { enum: ['start', 'continue', 'stop', 'increase', 'decrease', 'prescribe', 'mention'] } } } },
            followUp: { bsonType: ['object', 'null'], properties: { dueDate: { bsonType: ['string', 'null'] }, inDays: { bsonType: ['int', 'double', 'long', 'null'], minimum: 0 } } },
          },
        },
      },
    },
  },
  followups: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['patientId', 'sourceEncounterId', 'dueDate', 'status'],
      properties: { status: { enum: FOLLOWUP_STATUSES }, dueDate: { bsonType: 'date' } },
    },
  },
  patients: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['patientCode', 'name', 'dob', 'sex'],
      properties: { sex: { enum: ['F', 'M', 'O'] }, dob: { bsonType: 'date' }, phoneEnc: { bsonType: ['string', 'null'] } },
    },
  },
  users: {
    $jsonSchema: { bsonType: 'object', required: ['email', 'role', 'passwordHash'], properties: { role: { enum: ROLES } } },
  },
};

export async function connectDb(uri = config.mongoUri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoCreate: false, autoIndex: false });
  await ensureCollections();
  return mongoose.connection;
}

let readOnlyConn = null;
/** Connection used to run assistant-generated queries; read-only user when configured. */
export async function getReadConnection() {
  if (!config.readOnlyMongoUri) return mongoose.connection;
  if (!readOnlyConn) readOnlyConn = await mongoose.createConnection(config.readOnlyMongoUri).asPromise();
  return readOnlyConn;
}

export async function ensureCollections() {
  const db = mongoose.connection.db;
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, validator] of Object.entries(VALIDATORS)) {
    if (existing.has(name)) await db.command({ collMod: name, validator, validationLevel: 'moderate' });
    else await db.createCollection(name, { validator, validationLevel: 'moderate' });
  }
  if (!existing.has('audit_logs')) {
    await db.createCollection('audit_logs', {
      timeseries: { timeField: 'at', metaField: 'meta', granularity: 'seconds' },
      expireAfterSeconds: 60 * 60 * 24 * 365 * 2, // keep two years of access logs
    });
  }
  const { Encounter, NoteChunk, Followup, Patient, User, AssistantLog, GroundTruth, Vocabulary } = await import('./models/index.js');
  await Promise.all([Encounter, NoteChunk, Followup, Patient, User, AssistantLog, GroundTruth, Vocabulary].map((m) => m.syncIndexes()));
}

/** Atlas Vector Search index definition (only runs on Atlas). */
export const VECTOR_INDEX = (dims) => ({
  name: 'note_chunks_vector',
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: dims, similarity: 'cosine' },
      { type: 'filter', path: 'embeddingModel' },
      { type: 'filter', path: 'patientId' },
      { type: 'filter', path: 'visitDate' },
      { type: 'filter', path: 'diagnosisCodes' },
    ],
  },
});
