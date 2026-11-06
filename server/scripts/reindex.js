// Rebuild the semantic search index: re-embed every verified note with the
// active embedding model (run after switching EMBEDDING_MODE).
//   node scripts/reindex.js
import mongoose from 'mongoose';
import { connectDb } from '../src/db.js';
import { initEmbedder, embeddingModelName } from '../src/nlp/embedder.js';
import { reindexAll } from '../src/services/search.js';

await connectDb();
await initEmbedder();
console.log(`[reindex] model ${embeddingModelName()}`);
const n = await reindexAll();
console.log(`[reindex] done: ${n} notes`);
await mongoose.disconnect();
