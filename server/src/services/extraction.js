// The extraction ensemble: rules (always) + local ML tagger (when trained)
// + local LLM through Ollama (when running). Rules read all attributes.
import { extractNote } from '../nlp/extractor.js';
import { nerCandidates, nerStatus } from '../nlp/ml/nerService.js';
import { llmCandidates } from '../nlp/llm/llmExtractor.js';
import { llmEnabled } from '../nlp/llm/ollama.js';

/**
 * @param {string} text   the note
 * @param {object} opts   visitDate; llm: 'auto' | 'on' | 'off'
 */
export async function runExtraction(text, { visitDate = new Date(), llm = 'auto' } = {}) {
  const models = {};
  const extra = [];

  const ml = nerCandidates(text);
  if (nerStatus().available) { extra.push(...ml); models.ml = { proposed: ml.length, trainedAt: nerStatus().trainedAt }; }

  if (llm !== 'off' && (llm === 'on' || await llmEnabled('extraction'))) {
    try {
      const r = await llmCandidates(text);
      extra.push(...r.candidates);
      models.llm = { model: r.model, proposed: r.candidates.length, discardedNotInNote: r.rejected, ms: r.ms };
    } catch (e) {
      models.llm = { error: e.message };
    }
  }
  return extractNote(text, { visitDate, extraCandidates: extra, models });
}
