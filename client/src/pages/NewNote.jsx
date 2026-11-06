import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, age, fmtDate } from '../api.js';
import { HighlightedNote, Legend, ErrorLine } from '../components/ui.jsx';

function PatientPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  useEffect(() => {
    if (value || q.length < 2) { setList([]); return undefined; }
    const t = setTimeout(() => api(`/patients?limit=8&q=${encodeURIComponent(q)}`).then((d) => setList(d.patients)), 200);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><strong>{value.name}</strong> <span className="muted">{age(value.dob)}{value.sex} · {value.patientCode}</span></span>
        <button type="button" className="quiet" onClick={() => onChange(null)}>Change patient</button>
      </div>
    );
  }
  return (
    <div>
      <input type="search" placeholder="Type a patient name or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find patient" autoFocus />
      {list.length > 0 && (
        <ul className="worklist" style={{ marginTop: 6 }}>
          {list.map((p) => (
            <li key={p._id}><button type="button" className="link" onClick={() => onChange(p)}>{p.name}</button><span className="muted small">{age(p.dob)}{p.sex} · {p.patientCode}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function NewNote() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [patient, setPatient] = useState(null);
  const [visitDate, setVisitDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [withLlm, setWithLlm] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const id = params.get('patient');
    if (id) api(`/patients/${id}`).then((d) => setPatient(d.patient)).catch(() => {});
  }, [params]);

  // live preview: the same local extractor that runs after saving
  useEffect(() => {
    if (!text.trim()) { setPreview(null); return undefined; }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await api('/nlp/extract', { method: 'POST', body: { text, visitDate, llm: withLlm } }).catch(() => null);
      if (r && n === seq.current) setPreview(r);
    }, withLlm ? 1200 : 350);
    return () => clearTimeout(t);
  }, [text, visitDate, withLlm]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const r = await api('/encounters', { method: 'POST', body: { patientId: patient._id, visitDate, rawNote: text } });
      navigate(`/notes/${r.id}`);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const x = preview?.extraction;
  const counts = x ? [
    [x.symptoms.filter((s) => !s.negated).length, 'symptom'], [new Set(x.diagnoses.filter((d) => d.certainty !== 'ruled_out').map((d) => d.code)).size, 'diagnosis', 'diagnoses'],
    [x.medications.length, 'medicine'], [x.labs.length + x.vitals.length, 'measurement'],
  ].filter(([n]) => n).map(([n, w, pl]) => `${n} ${n === 1 ? w : pl ?? `${w}s`}`).join(', ') : '';

  return (
    <>
      <div className="page-head"><div><h1>Write a note</h1><p>Write the way you normally do. Abbreviations, brand names and shorthand like BD, x 3/7 and f/u 1/52 are understood.</p></div></div>
      <div className="review">
        <div className="facts" style={{ gap: 16 }}>
          <label className="field" htmlFor="pp">Patient</label>
          <PatientPicker value={patient} onChange={setPatient} />
          <label className="field" style={{ maxWidth: 200 }}>Visit date<input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} /></label>
          <label className="field">Consultation note
            <textarea
              rows={12}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. C/o fever and dry cough x 4 days. No SOB. Temp 101F. Dx: URTI. Rx: Tab Dolo 650 TDS x 3 days. Review after 5 days."
              style={{ fontFamily: 'var(--serif)', fontSize: 17, lineHeight: 1.6 }}
            />
          </label>
          <ErrorLine error={error} />
          <div className="row">
            <button type="button" onClick={save} disabled={!patient || !text.trim() || busy}>{busy ? 'Saving…' : 'Save and review'}</button>
            {!patient && <span className="muted small">Choose a patient first.</span>}
          </div>
        </div>
        <aside>
          <h2 style={{ marginBottom: 10 }}>What will be recorded</h2>
          <label className="check small" style={{ marginBottom: 10 }}><input type="checkbox" checked={withLlm} onChange={(e) => setWithLlm(e.target.checked)} />Also ask the local LLM in the preview (slower; it always runs after saving if Ollama is on)</label>
          {!x ? <p className="muted">Start typing. Each item the system recognises is underlined here, so you can see what it will record before you save.</p> : (
            <>
              <HighlightedNote text={text} entities={preview.entities} />
              <Legend types={['symptom', 'negated', 'diagnosis', 'medication', 'lab', 'vital', 'allergy', 'followup', 'unmapped']} />
              {x.meta.models?.llm?.discardedNotInNote?.length > 0 && <p className="small muted" style={{ marginTop: 8 }}>Discarded from the LLM because the words are not in the note: {x.meta.models.llm.discardedNotInNote.join(', ')}</p>}
              {x.meta.models?.llm?.error && <p className="small muted" style={{ marginTop: 8 }}>LLM not used: {x.meta.models.llm.error}</p>}
              <p style={{ marginTop: 14 }}>{counts || 'Nothing recognised yet.'}{x.followUp?.dueDate ? `, follow-up on ${fmtDate(x.followUp.dueDate)}` : x.followUp?.asNeeded ? ', follow-up as needed' : ''}.</p>
              {x.meta.warnings.length > 0 && <ul className="warnings" style={{ marginTop: 10 }}>{x.meta.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
