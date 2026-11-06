import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getSocket, fmtShort, pct } from '../api.js';
import { useAuth } from '../App.jsx';
import { Loading, ErrorLine, StatusTag } from '../components/ui.jsx';

function Reminder({ fu, onDone }) {
  const { user } = useAuth();
  const [phone, setPhone] = useState(null);
  const [busy, setBusy] = useState(false);
  const canReveal = user.role === 'staff' || user.role === 'admin';
  async function reveal() {
    const r = await api(`/patients/${fu.patientId}/contact`);
    setPhone(r.phone ?? 'No number on file');
  }
  async function log() {
    setBusy(true);
    await api(`/followups/${fu._id}/remind`, { method: 'POST', body: { channel: 'phone' } });
    setBusy(false);
    onDone();
  }
  const reminded = fu.reminders?.length ? fu.reminders[fu.reminders.length - 1] : null;
  return (
    <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
      {canReveal && (phone ? <span className="small">{phone}</span> : <button type="button" className="quiet" onClick={reveal}>Show phone</button>)}
      {reminded
        ? <span className="small muted">Reminded {fmtShort(reminded.at)}</span>
        : <button type="button" className="secondary" disabled={busy} onClick={log}>Log reminder call</button>}
    </span>
  );
}

export default function Today() {
  const { user } = useAuth();
  const isDoctor = user.role !== 'staff';
  const [overview, setOverview] = useState(null);
  const [queue, setQueue] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [due, setDue] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const weekAhead = new Date(Date.now() + 8 * 864e5).toISOString();
      const [o, od, dd, q] = await Promise.all([
        api('/analytics/overview'),
        api('/followups?status=overdue'),
        api(`/followups?status=due&from=${new Date(Date.now() - 864e5).toISOString()}&to=${weekAhead}`),
        isDoctor ? api('/encounters?status=queue') : Promise.resolve([]),
      ]);
      setOverview(o); setOverdue([...od].sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate))); setDue(dd); setQueue(q);
    } catch (e) { setError(e.message); }
  }, [isDoctor]);

  useEffect(() => {
    load();
    const s = getSocket();
    const refresh = () => load();
    s?.on('followup:changed', refresh);
    s?.on('encounter:changed', refresh);
    return () => { s?.off('followup:changed', refresh); s?.off('encounter:changed', refresh); };
  }, [load]);

  if (error) return <ErrorLine error={error} />;
  if (!overview) return <Loading />;
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting}, {user.name.split(' ').slice(0, 2).join(' ')}</h1>
          <p className="lede" style={{ marginTop: 10 }}>
            {isDoctor && <><strong>{overview.reviewQueue} note{overview.reviewQueue === 1 ? '' : 's'}</strong> waiting for your check. </>}
            <strong>{overview.overdueFollowups} patient{overview.overdueFollowups === 1 ? ' has' : 's have'}</strong> missed a review, and <strong>{overview.dueNext7Days}</strong> are due in the next 7 days.
            {' '}{overview.visitsThisMonth} verified visits so far this month.
          </p>
        </div>
        {user.role === 'doctor' && <Link className="button" to="/notes/new">Write a note</Link>}
      </div>

      <div className="two-col">
        {isDoctor && (
          <section>
            <h2 style={{ marginBottom: 10 }}>Notes to review</h2>
            {queue.length === 0 ? <p className="muted">All notes are checked. New notes appear here as soon as they are saved.</p> : (
              <ul className="worklist">
                {queue.slice(0, 8).map((n) => (
                  <li key={n._id}>
                    <Link to={`/notes/${n._id}`}><strong>{n.patientName}</strong></Link>
                    <StatusTag status={n.status} />
                    <span className="sub">{fmtShort(n.visitDate)} · {n.warnings ? `${n.warnings} thing${n.warnings === 1 ? '' : 's'} to check` : 'No warnings'}</span>
                    <span className="preview">{n.preview}</span>
                  </li>
                ))}
              </ul>
            )}
            {queue.length > 8 && <p style={{ marginTop: 10 }}><Link to="/review">See all {queue.length}</Link></p>}
          </section>
        )}

        <section>
          <h2 style={{ marginBottom: 10 }}>Missed follow-ups, most recent first</h2>
          {overdue.length === 0 ? <p className="muted">Nobody is overdue.</p> : (
            <ul className="worklist">
              {overdue.slice(0, isDoctor ? 8 : 20).map((f) => (
                <li key={f._id}>
                  <Link to={`/patients/${f.patientId}`}><strong>{f.patientName}</strong></Link>
                  <span className="tag tag-overdue">{Math.floor((Date.now() - new Date(f.dueDate)) / 864e5)} days late</span>
                  <span className="sub" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span>Was due {fmtShort(f.dueDate)}{f.reason ? `, ${f.reason}` : ''}</span>
                    <Reminder fu={f} onDone={load} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {overdue.length > (isDoctor ? 8 : 20) && <p style={{ marginTop: 10 }}><Link to="/assistant?q=list overdue follow ups">See all {overdue.length}</Link></p>}
        </section>

        {!isDoctor && (
          <section>
            <h2 style={{ marginBottom: 10 }}>Due this week</h2>
            <ul className="worklist">
              {due.slice(0, 20).map((f) => (
                <li key={f._id}>
                  <Link to={`/patients/${f.patientId}`}><strong>{f.patientName}</strong></Link>
                  <span className="small">{fmtShort(f.dueDate)}</span>
                  {f.reason && <span className="sub">{f.reason}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <section className="section">
        <h2>How the system is doing</h2>
        <p className="muted" style={{ marginTop: 6, maxWidth: '70ch' }}>
          {overview.extraction
            ? <>Across {overview.extraction.reviewed} checked notes, doctors kept {pct(overview.extraction.precision)} of what the extractor found and it found {pct(overview.extraction.recall)} of what they confirmed. {pct(overview.extraction.editedShare)} of notes needed an edit. </>
            : 'No checked notes yet. '}
          {overview.followupCompliance90d != null && <>{pct(overview.followupCompliance90d)} of follow-ups due in the last 90 days were kept. </>}
          {overview.assistantHelpful && <>Staff rated {pct(overview.assistantHelpful.share)} of assistant answers helpful.</>}
          {' '}<Link to="/analytics">Open analytics</Link>
        </p>
      </section>
    </>
  );
}
