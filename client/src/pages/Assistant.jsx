import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, fmtDate, pct } from '../api.js';
import { useAuth } from '../App.jsx';
import { ResultTable, RankBars, ErrorLine } from '../components/ui.jsx';

const DOCTOR_EXAMPLES = [
  'Which patients on metformin missed follow-ups this month?',
  'Patients with HbA1c above 8',
  'Most common diagnoses last month',
  'Have we seen patients with a rash after starting an antibiotic?',
  'Who is due for review next week?',
  'How many patients are on telmisartan?',
];
const STAFF_EXAMPLES = [
  'Who missed their follow-up this week?',
  'Who is due for review tomorrow?',
  'How many visits this month?',
  'Overdue follow-ups for diabetic patients',
];

function Answer({ a }) {
  const [showQuery, setShowQuery] = useState(false);
  const [rated, setRated] = useState(null);
  async function rate(r) { setRated(r); await api(`/assistant/${a.id}/feedback`, { method: 'POST', body: { rating: r } }).catch(() => {}); }
  return (
    <div className={`answer${a.kind === 'refusal' || a.kind === 'abstain' ? ' refusal' : ''}`}>
      <p className="answer-text">{a.answer}</p>
      {a.generated?.text && (
        <div className="generated">
          <p>{a.generated.text}</p>
          <p className="small muted">Summary written by the local LLM ({a.generated.model}) from the numbered notes below; every sentence cites a note and was checked to add no new numbers.</p>
        </div>
      )}

      {a.kind === 'table' && a.chart && a.rows.length > 0 && a.chart.x !== 'period' && (
        <div style={{ maxWidth: 620 }}><RankBars rows={a.rows} label={a.chart.x} value={a.chart.y} /></div>
      )}
      {a.kind === 'table' && <ResultTable columns={a.columns} rows={a.rows.slice(0, 100)} />}
      {a.kind === 'table' && a.rows.length > 100 && <p className="muted small">Showing 100 of {a.rows.length} rows.</p>}

      {a.kind === 'search' && a.results?.length > 0 && (
        <ul className="hits">
          {a.results.map((r, i) => (
            <li key={r.encounterId}>
              <div className="meta">{a.generated?.text && <span className="cite">[{i + 1}]</span>}<Link to={`/patients/${r.patientId}`}><strong>{r.patientName}</strong></Link><Link to={`/notes/${r.encounterId}`}>{fmtDate(r.visitDate)}</Link>{r.diagnoses.length > 0 && <span>{r.diagnoses.join(', ')}</span>}</div>
              <p className="snippet">{r.snippet}</p>
            </li>
          ))}
        </ul>
      )}

      {a.kind === 'summary' && a.summary && (
        <>
          <p><Link to={`/patients/${a.summary.patient.id}`}>Open {a.summary.patient.name}'s record</Link></p>
          <ResultTable
            columns={[['visitDate', 'Visit'], ['diagnoses', 'Diagnoses'], ['medicationChanges', 'Medicine changes'], ['followUp', 'Follow-up']]}
            rows={a.summary.recent}
          />
        </>
      )}

      <div className="how">
        <span>Understood as: {a.intentLabel} ({pct(a.confidence)} sure{a.route !== 'classifier' ? `, ${a.route}` : ''})</span>
        <span>{a.latencyMs} ms</span>
        {a.query && <button type="button" className="link" onClick={() => setShowQuery(!showQuery)}>{showQuery ? 'Hide the query' : 'Show the query'}</button>}
        {a.kind !== 'help' && (rated == null ? (
          <span className="row" style={{ gap: 4 }}>Was this right?
            <button type="button" className="quiet" onClick={() => rate(1)}>Yes</button>
            <button type="button" className="quiet" onClick={() => rate(-1)}>No</button>
          </span>
        ) : <span>Thanks, noted.</span>)}
      </div>
      {showQuery && <pre className="query-box">{a.query}</pre>}
    </div>
  );
}

export default function Assistant() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bottom = useRef(null);
  const examples = user.role === 'staff' ? STAFF_EXAMPLES : DOCTOR_EXAMPLES;

  async function ask(question) {
    const text = (question ?? q).trim();
    if (!text) return;
    setBusy(true); setError(null); setQ('');
    try {
      const a = await api('/assistant', { method: 'POST', body: { question: text } });
      setThread((t) => [...t, a]);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { if (params.get('q')) ask(params.get('q')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [thread.length, busy]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ask the records</h1>
          <p>Answers come only from checked notes. Every list and number is read straight from the database, and you can see the exact query behind it. The assistant does not give clinical advice or change records.</p>
        </div>
      </div>

      <div className="chat">
        {thread.length === 0 && !busy && <p className="muted">Try one of the questions below, or ask your own.</p>}
        {thread.map((a) => (
          <div key={a.id}>
            <p className="q">{a.question}</p>
            <Answer a={a} />
          </div>
        ))}
        {busy && <p className="muted" aria-live="polite">Looking it up…</p>}
        <div ref={bottom} />
      </div>

      <div className="ask">
        <ErrorLine error={error} />
        <form onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about patients, medicines, follow-ups or results" aria-label="Your question" />
          <button type="submit" disabled={busy || !q.trim()}>Ask</button>
        </form>
        <div className="suggestions">{examples.map((e) => <button key={e} type="button" onClick={() => ask(e)} disabled={busy}>{e}</button>)}</div>
      </div>
    </>
  );
}
