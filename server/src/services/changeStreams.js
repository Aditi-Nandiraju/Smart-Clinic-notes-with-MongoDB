// Change streams drive two things:
//  1. the extraction queue: a newly inserted pending encounter is processed at once
//  2. live updates: follow-up and encounter changes are pushed to browsers via Socket.IO
// Change streams need a replica set (Atlas clusters are replica sets; locally,
// start mongod with --replSet). Without one, the API falls back to processing
// notes inline and clients poll.
import { Encounter, Followup } from '../models/index.js';
import { processEncounter } from './encounters.js';

let available = false;
export const changeStreamsAvailable = () => available;

export function startChangeStreams(io, log = console) {
  try {
    const encStream = Encounter.watch(
      [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }],
      { fullDocument: 'updateLookup' },
    );
    encStream.on('change', async (ch) => {
      const doc = ch.fullDocument;
      if (!doc) return;
      if (ch.operationType === 'insert' && doc.status === 'pending') {
        await processEncounter(doc._id).catch((e) => log.error?.('[extract] failed', e));
        return; // the status update from processing emits its own event
      }
      io.emit('encounter:changed', { id: String(doc._id), patientId: String(doc.patientId), status: doc.status });
    });
    encStream.on('error', (e) => { available = false; log.error?.('[changeStream] encounters', e.message); });

    const fuStream = Followup.watch([], { fullDocument: 'updateLookup' });
    fuStream.on('change', (ch) => {
      const doc = ch.fullDocument;
      if (!doc) return;
      io.emit('followup:changed', { id: String(doc._id), patientId: String(doc.patientId), status: doc.status, dueDate: doc.dueDate });
    });
    fuStream.on('error', (e) => { available = false; log.error?.('[changeStream] followups', e.message); });
    available = true;
    return [encStream, fuStream];
  } catch (err) {
    log.warn?.(`[changeStream] unavailable (${err.message}); falling back to inline processing`);
    available = false;
    return [];
  }
}
