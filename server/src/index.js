// API entry point: connects to MongoDB, loads the local models, then serves the
// REST API, Socket.IO live updates and (after `npm run build`) the client app.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { config } from './config.js';
import { connectDb } from './db.js';
import { api } from './routes/api.js';
import { initEmbedder, embeddingModelName } from './nlp/embedder.js';
import { loadNer, nerStatus } from './nlp/ml/nerService.js';
import { trainAssistant } from './nlp/assistant/assistant.js';
import { ollamaStatus } from './nlp/llm/ollama.js';
import { loadVocabulary } from './services/vocabulary.js';
import { indexNeedsRebuild, reindexAll } from './services/search.js';
import { startChangeStreams } from './services/changeStreams.js';
import { startScheduler } from './services/followups.js';
import { processEncounter } from './services/encounters.js';
import { Encounter } from './models/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

async function main() {
  await connectDb();
  console.log(`[db] connected to ${mongoose.connection.name}`);

  await initEmbedder();
  console.log(`[embed] ${embeddingModelName()}`);
  loadNer();
  console.log(`[ner] ${nerStatus().available ? 'model loaded' : 'no trained model yet (run npm run seed)'}`);
  trainAssistant();
  await loadVocabulary();
  ollamaStatus(true).then((s) => console.log(`[ollama] ${s.reachable ? (s.modelAvailable ? `using ${s.model}` : `reachable, but ${s.model} is not pulled`) : 'not reachable; using rules + ML'}`)).catch(() => {});

  const app = express();
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  if (fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist));
    app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[api]', err);
    const status = err.status ?? (err.name === 'ValidationError' || err.name === 'CastError' ? 400 : 500);
    res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
  });

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.clientOrigin } });
  io.use((socket, next) => {
    try {
      socket.user = jwt.verify(socket.handshake.auth?.token ?? '', config.jwtSecret);
      next();
    } catch {
      next(new Error('unauthorised'));
    }
  });

  startChangeStreams(io);
  startScheduler();

  // Notes saved while the server was down are still pending: process them now.
  const pending = await Encounter.find({ status: 'pending' }).select('_id').lean();
  for (const { _id } of pending) await processEncounter(_id).catch((e) => console.error('[extract] failed', e));

  server.listen(config.port, () => console.log(`[api] listening on http://localhost:${config.port}`));

  // Re-embed in the background if the embedding model changed since the last index.
  if (await indexNeedsRebuild()) {
    console.log('[search] embedding model changed, re-indexing in the background');
    reindexAll().then((n) => console.log(`[search] re-indexed ${n} notes`)).catch((e) => console.error('[search] reindex failed', e));
  }
}

main().catch((err) => {
  console.error('[startup] failed:', err);
  process.exit(1);
});
