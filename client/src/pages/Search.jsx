import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { ErrorLine, Loading } from '../components/ui.jsx';

const MODES = [['hybrid', 'Meaning and words'], ['semantic', 'Meaning only'], ['keyword', 'Exact words only']];

/** Bold the query's words inside a snippet (display only). */
function Snippet({ text, query }) {
  const words = [...new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3))];
  if (!words.length) return <p className="snippet">{text}</p>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <p className="snippet">{text.split(re).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</p>;
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [mode, setMode] = useState(params.get('mode') ?? 'hybrid');
  const [dx, setDx] = useState('');
  const [lex, setLex] = useState({ diagnoses: [] });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { api('/lexicon').then(setLex).catch(() => {}); }, []);

  async function run(e) {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setError(null);
    setParams({ q, mode });
    try {
      setRes(await api(`/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20${dx ? `&diagnosisCode=${encodeURIComponent(dx)}` : ''}`));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  useEffect(() => { if (params.get('q')) run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Search notes</h1>
          <p>Describe what you are looking for in your own words. "Breathless on climbing stairs" also finds "SOB on exertion", and "No SOB" does not count as a match.</p>
        </div>
      </div>
      <form onSubmit={run} className="row" style={{ alignItems: 'end', marginBottom: 20 }}>
        <label className="field" style={{ flex: '1 1 360px' }}>Look for<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. breathless on climbing stairs" /></label>
        <label className="field" style={{ width: 190 }}>Match by<select value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field" style={{ width: 230 }}>Only diagnosis<select value={dx} onChange={(e) => setDx(e.target.value)}><option value="">Any</option>{lex.diagnoses.map((d) => <option key={d.code} value={d.code}>{d.term}</option>)}</select></label>
        <button type="submit" disabled={busy || !q.trim()}>Search</button>
      </form>
      <ErrorLine error={error} />
      {busy && <Loading what="Searching" />}
      {res && !busy && (
        res.results.length === 0
          ? <p className="muted">No checked notes match. Try describing the problem differently, or switch to "Meaning only".</p>
          : (
            <>
              <p className="muted small" style={{ marginBottom: 8 }}>{res.results.length} notes in {res.ms} ms, using the {res.embeddingModel} model on this server.</p>
              <ul className="hits">
                {res.results.map((r) => (
                  <li key={r.encounterId}>
                    <div className="meta">
                      <Link to={`/patients/${r.patientId}`}><strong>{r.patientName}</strong></Link>
                      <Link to={`/notes/${r.encounterId}`}>{fmtDate(r.visitDate)}</Link>
                      {r.diagnoses.length > 0 && <span>{r.diagnoses.join(', ')}</span>}
                      <span>{r.matchedBy.includes('semantic') && r.matchedBy.includes('keyword') ? 'matched meaning and words' : r.matchedBy.includes('semantic') ? 'matched meaning' : 'matched words'}{r.semanticScore != null ? `, similarity ${r.semanticScore}` : ''}</span>
                    </div>
                    <Snippet text={r.snippet} query={q} />
                  </li>
                ))}
              </ul>
            </>
          )
      )}
    </>
  );
}
