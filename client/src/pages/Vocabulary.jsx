import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { ErrorLine, Loading } from '../components/ui.jsx';

const TYPES = [['drug', 'Medicine'], ['symptom', 'Symptom'], ['diagnosis', 'Diagnosis']];
const conceptText = (r) => (r.type === 'drug' ? r.concept.generic : r.type === 'diagnosis' ? `${r.concept.term} (${r.concept.code})` : r.concept.term);

export default function Vocabulary() {
  const [d, setD] = useState(null);
  const [lex, setLex] = useState({ diagnoses: [], drugs: [] });
  const [form, setForm] = useState({ type: 'drug', alias: '', meaning: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/vocabulary').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); api('/lexicon').then(setLex).catch(() => {}); }, []);

  async function addTerm(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      let concept;
      if (form.type === 'drug') concept = { generic: form.meaning.toLowerCase().trim() };
      else if (form.type === 'symptom') concept = { term: form.meaning.toLowerCase().trim() };
      else {
        const hit = lex.diagnoses.find((x) => x.term.toLowerCase() === form.meaning.toLowerCase().trim());
        if (!hit) throw new Error('Pick a diagnosis from the list so it has an ICD-10 code');
        concept = { term: hit.term, code: hit.code };
      }
      await api('/vocabulary', { method: 'POST', body: { type: form.type, alias: form.alias, concept } });
      setForm({ ...form, alias: '', meaning: '' });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const toggle = async (r) => { await api(`/vocabulary/${r._id}`, { method: 'PATCH', body: { status: r.status === 'active' ? 'disabled' : 'active' } }).catch((e) => setError(e.message)); load(); };

  if (!d) return error ? <ErrorLine error={error} /> : <Loading />;
  return (
    <>
      <datalist id="voc-drugs">{lex.drugs.map((x) => <option key={x.generic} value={x.generic} />)}</datalist>
      <datalist id="voc-dx">{lex.diagnoses.map((x) => <option key={x.code} value={x.term}>{x.code}</option>)}</datalist>
      <div className="page-head">
        <div>
          <h1>Clinic vocabulary</h1>
          <p>Brand names, abbreviations and local wording this clinic has taught the system. Terms are learned when a doctor maps an unknown word or selects text on the review screen, and are used by the rules straight away.</p>
        </div>
      </div>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat"><div className="v">{d.stats.drugs}</div><div className="k">Medicines known</div></div>
        <div className="stat"><div className="v">{d.stats.diagnoses}</div><div className="k">Diagnoses known</div></div>
        <div className="stat"><div className="v">{d.stats.symptoms}</div><div className="k">Symptoms known</div></div>
        <div className="stat"><div className="v">{d.stats.learnedAliases}</div><div className="k">Learned wordings in use</div></div>
      </div>

      <form className="row" onSubmit={addTerm} style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
        <label className="field" style={{ width: 140 }}>Type
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, meaning: '' })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field" style={{ width: 200 }}>Written as<input value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} placeholder="e.g. Pyrigesic" required /></label>
        <label className="field" style={{ width: 240 }}>Means
          <input list={form.type === 'drug' ? 'voc-drugs' : form.type === 'diagnosis' ? 'voc-dx' : undefined} value={form.meaning} onChange={(e) => setForm({ ...form, meaning: e.target.value })} placeholder={form.type === 'drug' ? 'generic name' : form.type === 'diagnosis' ? 'diagnosis' : 'symptom term'} required />
        </label>
        <button type="submit" disabled={busy}>Add term</button>
      </form>
      <ErrorLine error={error} />

      {d.rows.length === 0 ? <p className="muted">Nothing learned yet. When the review screen shows a word under “Not in the vocabulary”, mapping it adds it here.</p> : (
        <table className="table">
          <thead><tr><th>Written as</th><th>Means</th><th>Type</th><th>Learned from</th><th className="num">Times taught</th><th>Added</th><th /></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r._id} style={r.status === 'disabled' ? { opacity: 0.55 } : undefined}>
                <td><strong>{r.alias}</strong></td>
                <td>{conceptText(r)}</td>
                <td>{TYPES.find(([v]) => v === r.type)?.[1]}</td>
                <td>{r.source === 'correction' ? `a correction by ${r.createdBy?.name ?? 'a doctor'}` : `added by ${r.createdBy?.name ?? 'a doctor'}`}</td>
                <td className="num">{r.uses}</td>
                <td>{fmtDate(r.createdAt)}</td>
                <td><button type="button" className="quiet" onClick={() => toggle(r)}>{r.status === 'active' ? 'Turn off' : 'Turn on'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
