// Minimal client for a local Ollama server. Nothing leaves the machine:
// Ollama runs the model locally (default http://127.0.0.1:11434).
import { config } from '../../config.js';

let status = { checkedAt: 0, reachable: false, models: [], error: null };

async function call(pathname, body, timeoutMs = config.ollamaTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.ollamaUrl}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${pathname} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Is Ollama running, and is the configured model pulled? Cached for 30 s. */
export async function ollamaStatus(force = false) {
  if (!force && Date.now() - status.checkedAt < 30_000) return status;
  try {
    const tags = await call('/api/tags', null, 3000);
    const models = (tags.models ?? []).map((m) => m.name);
    const has = (name) => models.some((m) => m === name || m === `${name}:latest` || (!name.includes(':') && m.startsWith(`${name}:`)));
    status = { checkedAt: Date.now(), reachable: true, models, model: config.ollamaModel, modelAvailable: has(config.ollamaModel), embedModelAvailable: has(config.ollamaEmbedModel), error: null };
  } catch (e) {
    status = { checkedAt: Date.now(), reachable: false, models: [], model: config.ollamaModel, modelAvailable: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
  }
  return status;
}

export async function llmEnabled(kind) {
  const setting = kind === 'assistant' ? config.llmAssistant : config.llmExtraction;
  if (setting === 'off') return false;
  const s = await ollamaStatus();
  return s.reachable && s.modelAvailable;
}

/**
 * Chat with structured JSON output. `schema` is a JSON Schema; Ollama
 * constrains generation to it. Temperature 0 for repeatable output.
 */
export async function chatJSON({ system, user, schema, temperature = 0, numCtx = 4096 }) {
  const res = await call('/api/chat', {
    model: config.ollamaModel,
    stream: false,
    format: schema,
    options: { temperature, num_ctx: numCtx },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const text = res?.message?.content ?? '';
  try {
    return { data: JSON.parse(text), raw: text, model: res.model ?? config.ollamaModel, ms: Math.round((res.total_duration ?? 0) / 1e6) };
  } catch {
    throw new Error('Ollama returned text that is not valid JSON');
  }
}

/** Embeddings from a local Ollama embedding model (optional search backend). */
export async function embedOllama(texts) {
  const res = await call('/api/embed', { model: config.ollamaEmbedModel, input: texts });
  return res.embeddings;
}
