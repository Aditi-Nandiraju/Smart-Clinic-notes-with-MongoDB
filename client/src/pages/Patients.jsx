import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, age, fmtDate } from '../api.js';
import { ErrorLine, Loading, StatusTag } from '../components/ui.jsx';

function AddPatient({ onCancel }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', dob: '', sex: 'F', phone: '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    try {
      const p = await api('/patients', { method: 'POST', body: form });
      navigate(`/patients/${p._id}`);
    } catch (err) { setError(err.message); }
  }
  return (
    <form className="panel" onSubmit={save} style={{ display: 'grid', gap: 12, marginBottom: 20, maxWidth: 640 }}>
      <h2>Register a patient</h2>
      <div className="row" style={{ alignItems: 'end' }}>
        <label className="field" style={{ flex: 2 }}>Full name<input value={form.name} onChange={set('name')} required /></label>
        <label className="field" style={{ flex: 1 }}>Date of birth<input type="date" value={form.dob} onChange={set('dob')} required /></label>
        <label className="field" style={{ width: 90 }}>Sex<select value={form.sex} onChange={set('sex')}><option>F</option><option>M</option><option>O</option></select></label>
      </div>
      <label className="field">Phone (stored encrypted)<input value={form.phone} onChange={set('phone')} inputMode="tel" /></label>
      <ErrorLine error={error} />
      <div className="row"><button type="submit">Register patient</button><button type="button" className="quiet" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

export default function Patients() {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/patients?limit=100&q=${encodeURIComponent(q)}`).then(setData).catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <p>{data ? `${data.total} registered` : ' '}</p>
        </div>
        {!adding && <button type="button" className="secondary" onClick={() => setAdding(true)}>Register a patient</button>}
      </div>
      {adding && <AddPatient onCancel={() => setAdding(false)} />}
      <input type="search" placeholder="Search by name or patient ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search patients" style={{ maxWidth: 420, marginBottom: 16 }} />
      <ErrorLine error={error} />
      {!data ? <Loading /> : data.patients.length === 0 ? <p className="muted">No patient matches "{q}". Check the spelling or search by patient ID.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>ID</th><th>Age</th><th>Last visit</th><th>Next follow-up</th></tr></thead>
            <tbody>
              {data.patients.map((p) => (
                <tr key={p._id}>
                  <td><Link to={`/patients/${p._id}`}>{p.name}</Link></td>
                  <td className="muted">{p.patientCode}</td>
                  <td>{age(p.dob)}{p.sex}</td>
                  <td>{fmtDate(p.lastVisit)}</td>
                  <td>{p.nextFollowup ? <span className="row" style={{ gap: 8 }}>{fmtDate(p.nextFollowup.dueDate)} <StatusTag status={p.nextFollowup.status} /></span> : <span className="muted">None open</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
