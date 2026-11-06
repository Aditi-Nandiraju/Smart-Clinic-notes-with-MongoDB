import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, age, fmtDate } from '../api.js';
import { useAuth } from '../App.jsx';
import { ErrorLine, Loading, StatusTag } from '../components/ui.jsx';

export default function PatientDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api(`/patients/${id}`).then(setD).catch((e) => setError(e.message)); }, [id]);

  if (error) return <ErrorLine error={error} />;
  if (!d) return <Loading />;
  const { patient: p, encounters, followups, summary } = d;
  const isDoctor = user.role !== 'staff';
  const openFu = followups.filter((f) => ['due', 'overdue'].includes(f.status));

  return (
    <>
      <div className="patient-head">
        <div>
          <h1>{p.name}</h1>
          <p className="facts-line">{age(p.dob)} years, {p.sex === 'F' ? 'female' : p.sex === 'M' ? 'male' : 'other'} · {p.patientCode}{p.phoneMasked ? ` · ${p.phoneMasked}` : ''}</p>
          {p.allergies?.length > 0 && <p className="allergy-line">Allergic to {p.allergies.join(', ')}</p>}
        </div>
        {user.role === 'doctor' && <Link className="button" to={`/notes/new?patient=${p._id}`}>Write a note</Link>}
      </div>

      {summary && (
        <section className="panel">
          <h2 style={{ marginBottom: 8 }}>Summary from checked notes</h2>
          <p className="summary-text">{summary.summary}</p>
        </section>
      )}

      <div className="two-col section">
        {summary && (
          <section>
            <h2 style={{ marginBottom: 10 }}>Current medicines</h2>
            {summary.activeMedications.length === 0 ? <p className="muted">None recorded.</p> : (
              <table className="table">
                <thead><tr><th>Medicine</th><th>Dose</th><th>How often</th><th>Since</th></tr></thead>
                <tbody>{summary.activeMedications.map((m) => (
                  <tr key={m.generic}><td>{m.generic}</td><td>{m.dose != null ? `${m.dose} ${m.unit ?? ''}` : '—'}</td><td>{m.frequency ?? '—'}</td><td>{fmtDate(m.since)}</td></tr>
                ))}</tbody>
              </table>
            )}
            {summary.latestLabs.length > 0 && (
              <>
                <h2 style={{ margin: '24px 0 10px' }}>Latest results</h2>
                <table className="table">
                  <thead><tr><th>Test</th><th className="num">Latest</th><th className="num">Before</th><th>Date</th></tr></thead>
                  <tbody>{summary.latestLabs.map((l) => (
                    <tr key={l.test}>
                      <td>{l.test}</td>
                      <td className="num" style={{ color: l.flag === 'high' || l.flag === 'low' || l.flag === 'abnormal' ? 'var(--alert)' : undefined }}>{String(l.value)} {l.unit ?? ''}</td>
                      <td className="num muted">{l.previous ? String(l.previous.value) : '—'}</td>
                      <td>{fmtDate(l.date)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </>
            )}
          </section>
        )}

        <section>
          <h2 style={{ marginBottom: 10 }}>Follow-ups</h2>
          {openFu.length === 0 ? <p className="muted" style={{ marginBottom: 16 }}>No follow-up open.</p> : (
            <ul className="worklist" style={{ marginBottom: 20 }}>
              {openFu.map((f) => <li key={f._id}><span>Due {fmtDate(f.dueDate)}{f.reason ? `, ${f.reason}` : ''}</span><StatusTag status={f.status} /></li>)}
            </ul>
          )}
          <h2 style={{ marginBottom: 12 }}>Visits</h2>
          {encounters.length === 0 && <p className="muted">No visits yet.{user.role === 'doctor' ? ' Write the first note to start this record.' : ''}</p>}
          <ol className="timeline">
            {encounters.map((e) => {
              const dx = (e.extraction?.diagnoses ?? []).filter((x) => x.certainty !== 'ruled_out' && x.context === 'current').map((x) => x.term);
              const changes = (e.extraction?.medications ?? []).filter((m) => ['start', 'stop', 'increase', 'decrease'].includes(m.action)).map((m) => `${m.action === 'decrease' ? 'reduced' : m.action === 'increase' ? 'increased' : m.action === 'start' ? 'started' : 'stopped'} ${m.generic}`);
              return (
                <li key={e._id}>
                  <div className="row" style={{ gap: 8 }}>
                    {isDoctor ? <Link className="when" to={`/notes/${e._id}`}>{fmtDate(e.visitDate)}</Link> : <span className="when">{fmtDate(e.visitDate)}</span>}
                    {e.status !== 'verified' && <StatusTag status={e.status} />}
                  </div>
                  {isDoctor && <div className="what">{[dx.join(', '), changes.join(', ')].filter(Boolean).join('. ') || 'Routine review'}</div>}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </>
  );
}
