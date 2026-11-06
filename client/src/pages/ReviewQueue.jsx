import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, getSocket } from '../api.js';
import { Loading, ErrorLine, StatusTag } from '../components/ui.jsx';

export default function ReviewQueue() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const load = () => api('/encounters?status=queue').then(setRows).catch((e) => setError(e.message));
    load();
    const s = getSocket();
    s?.on('encounter:changed', load);
    return () => s?.off('encounter:changed', load);
  }, []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review notes</h1>
          <p>Nothing from a note is used in search, the assistant or analytics until a doctor confirms it. Oldest first.</p>
        </div>
      </div>
      <ErrorLine error={error} />
      {!rows ? <Loading /> : rows.length === 0 ? <p className="muted">The queue is empty. New notes appear here as soon as they are saved.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Patient</th><th>Visit</th><th>Note</th><th>To check</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td><Link to={`/notes/${r._id}`}>{r.patientName}</Link></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.visitDate)}</td>
                  <td style={{ fontFamily: 'var(--serif)', maxWidth: 480 }}>{r.preview}{r.preview?.length >= 140 ? '…' : ''}</td>
                  <td className="num">{r.warnings || '—'}</td>
                  <td><StatusTag status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
