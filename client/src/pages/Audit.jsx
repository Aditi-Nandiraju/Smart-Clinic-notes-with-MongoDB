import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorLine } from '../components/ui.jsx';

const ACTIONS = {
  login: 'Signed in', 'patient.view': 'Opened patient', 'patient.create': 'Registered patient', 'patient.contact_reveal': 'Viewed phone number',
  'encounter.create': 'Saved note', 'encounter.view': 'Opened note', 'encounter.verify': 'Verified note', search: 'Searched notes',
  'assistant.ask': 'Asked the assistant', 'followup.remind': 'Logged reminder', 'followup.update': 'Changed follow-up', 'user.create': 'Created user',
};

export default function Audit() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/admin/audit?limit=200').then(setRows).catch((e) => setError(e.message)); }, []);
  return (
    <>
      <div className="page-head"><div><h1>Access log</h1><p>Who opened, searched or changed what. Stored in a MongoDB time-series collection and kept for two years.</p></div></div>
      <ErrorLine error={error} />
      {!rows ? <Loading /> : rows.length === 0 ? <p className="muted">No activity recorded yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Item</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{r.meta?.name ?? '—'} <span className="muted small">{r.meta?.role}</span></td>
                  <td>{ACTIONS[r.action] ?? r.action}</td>
                  <td className="muted small">{r.target}</td>
                  <td className="muted small">{r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
