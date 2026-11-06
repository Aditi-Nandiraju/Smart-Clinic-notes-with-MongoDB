// Create the Atlas Vector Search index for note_chunks (MongoDB Atlas only).
// Regular indexes and validators are created automatically when the API starts.
//   node scripts/createIndexes.js
// Then set ATLAS_VECTOR_SEARCH=true in .env so search uses $vectorSearch.
import mongoose from 'mongoose';
import { connectDb, VECTOR_INDEX } from '../src/db.js';
import { initEmbedder, embed, embeddingModelName } from '../src/nlp/embedder.js';

await connectDb();
await initEmbedder();
const [v] = await embed(['dimension probe']);
const coll = mongoose.connection.db.collection('note_chunks');
try {
  const existing = await coll.listSearchIndexes().toArray();
  if (existing.some((i) => i.name === 'note_chunks_vector')) {
    console.log('[indexes] note_chunks_vector already exists');
  } else {
    await coll.createSearchIndex(VECTOR_INDEX(v.length));
    console.log(`[indexes] created note_chunks_vector (${v.length} dims, model ${embeddingModelName()}). It takes a minute to build on Atlas.`);
  }
} catch (err) {
  console.error(`[indexes] could not create the vector index: ${err.message}`);
  console.error('This needs MongoDB Atlas (or Atlas local deployment). Without it, search uses an exact cosine scan, which is fine for a clinic-sized dataset.');
}
await mongoose.disconnect();
