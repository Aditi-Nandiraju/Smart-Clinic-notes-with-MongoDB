import React, { useEffect, useState } from 'react';
import { api, fmtDate, pct } from '../api.js';
import { ErrorLine, Loading } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const Dot = ({ ok }) => <span className={`status-dot ${ok ? 'ok' : 'off'}`} aria-hidden="true" />;

export default function Models() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [training, setTraining] = useState(false);
  const [trained, setTrained] = useState(null);
  const load = () => api('/models').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function retrain() {
    setTraining(true); setError(null);
    try { setTrained(await api('/admin/retrain', { method: 'POST' })); await load(); } catch (e) { setError(e.message); } finally { setTraining(false); }
  }

  if (!d) return error ? <ErrorLine error={error} /> : <Loading />;
  const { rules, ner, llm } = d;
  const llmOk = llm.reachable && llm.modelAvailable;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Models</h1>
          <p>Everything runs on this machine. Three extractors read each note and their agreement sets the confidence; nothing is sent to an outside service.</p>
        </div>
      </div>

      <div className="two-col">
        <section className="stat">
          <h2><Dot ok />Rules and lexicon</h2>
          <p className="muted small">Dictionary matching with Indian brand names, fuzzy spelling, and negation / uncertainty rules. Always on.</p>
          <p>Version <strong>{rules.version}</strong> · {rules.lexicon.drugs} medicines, {rules.lexicon.diagnoses} diagnoses, {rules.lexicon.symptoms} symptoms, {rules.lexicon.learnedAliases} learned wordings. Items below {Math.round(rules.reviewThreshold * 100)}% confidence are flagged for checking.</p>
        </section>

        <section className="stat">
          <h2><Dot ok={ner.available} />ML tagger</h2>
          <p className="muted small">Averaged structured perceptron over word, shape, context and lexicon features, trained on this clinic’s verified notes. Finds mentions from context, including brand names the lexicon has never seen.</p>
          {ner.available ? (
            <p>Trained {fmtDate(ner.trainedAt)} on {ner.trainNotes} notes · held-out span F1 <strong>{pct(ner.heldOut?.f1)}</strong> on {ner.heldOut?.notes} notes. Retrains automatically as notes are verified.</p>
          ) : <p>Not trained yet: it needs at least 20 verified notes.</p>}
          {user.role !== 'staff' && <button type="button" className="secondary" onClick={retrain} disabled={training}>{training ? 'Training…' : 'Retrain now'}</button>}
          {trained && <p className="ok small" role="status">Retrained on {trained.trainNotes} notes; held-out F1 {pct(trained.heldOut?.f1)}.</p>}
        </section>
      </div>

      <section className="stat section">
        <h2><Dot ok={llmOk} />Local LLM (Ollama)</h2>
        <p className="muted small">Proposes extra mentions (each one must be found word-for-word in the note, or it is thrown away), understands assistant questions the classifier is unsure about, and writes short cited summaries of search results. The system works fully without it.</p>
        {llmOk ? (
          <p><strong>{llm.model}</strong> is ready at {llm.url}. Extraction: {llm.extraction}; assistant: {llm.assistant}.</p>
        ) : llm.reachable ? (
          <p>Ollama is running at {llm.url} but <strong>{llm.model}</strong> is not pulled. Run <code>ollama pull {llm.model}</code>.</p>
        ) : (
          <p>Ollama is not reachable at {llm.url}{llm.error ? ` (${llm.error})` : ''}. Install it from ollama.com, run <code>ollama pull {llm.model}</code>, and it will be picked up within 30 seconds.</p>
        )}
        {llm.models?.length > 0 && <p className="small muted">Models installed: {llm.models.join(', ')}</p>}
      </section>

      <section className="stat section">
        <h2><Dot ok />Assistant and search</h2>
        <p>Intent classifier: {d.assistant.model} on {d.assistant.examples} examples. Embeddings: {d.embeddings}.</p>
      </section>
      <ErrorLine error={error} />
    </>
  );
}
