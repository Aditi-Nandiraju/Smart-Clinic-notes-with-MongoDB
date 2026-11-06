import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 4000),
  mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cnis?replicaSet=rs0',
  // Optional second connection string for a database user with only the `read` role.
  // The assistant runs its generated queries through it.
  readOnlyMongoUri: env.READONLY_MONGODB_URI || null,
  jwtSecret: env.JWT_SECRET || 'dev-only-change-me',
  fieldEncKey: env.FIELD_ENC_KEY || null,
  // 'auto' tries the local transformer model and falls back to the hashing model
  embeddingMode: env.EMBEDDING_MODE || 'auto',
  embeddingModelId: env.EMBEDDING_MODEL_ID || 'Xenova/all-MiniLM-L6-v2',
  modelCacheDir: env.MODEL_CACHE_DIR || './models',
  // true on MongoDB Atlas with the vector index created by `npm run indexes`
  atlasVectorSearch: env.ATLAS_VECTOR_SEARCH === 'true',
  followupGraceDays: Number(env.FOLLOWUP_GRACE_DAYS || 3),
  overdueCron: env.OVERDUE_CRON || '0 8 * * *',
  clientOrigin: env.CLIENT_ORIGIN || 'http://localhost:5173',
  // Local LLM through Ollama (https://ollama.com). 'auto' uses it when reachable.
  ollamaUrl: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  ollamaModel: env.OLLAMA_MODEL || 'qwen2.5:7b',
  ollamaEmbedModel: env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  ollamaTimeoutMs: Number(env.OLLAMA_TIMEOUT_MS || 90000),
  llmExtraction: env.LLM_EXTRACTION || 'auto', // auto | on | off
  llmAssistant: env.LLM_ASSISTANT || 'auto',   // auto | on | off
  // ML tagger trained on verified notes: auto-retrain after this many new verifications (0 = never)
  nerRetrainEvery: Number(env.NER_RETRAIN_EVERY || 50),
};

if (config.jwtSecret === 'dev-only-change-me' && env.NODE_ENV === 'production') {
  throw new Error('Set JWT_SECRET in production');
}
