import React, { useEffect, useState } from 'react';
import { api, pct } from '../api.js';
import { RankBars, TimeBars, Loading, ErrorLine } from '../components/ui.jsx';

const month = (d) => new Date(d).toLocaleDateString('en-IN', { month: 'short' });

export default function Analytics() {
  const [days, setDays] = useState(90);
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api('/analytics/visits?months=8'),
      api(`/analytics/diagnoses?days=${days}&limit=10`),
      api(`/analytics/medications?days=${days}&limit=10`),
      api('/analytics/followup-compliance?months=8'),
      api('/analytics/extraction-quality'),
      api('/analytics/review'),
    ]).then(([visits, dx, meds, fu, quality, review]) => setD({ visits, dx, meds, fu, quality, review })).catch((e) => setError(e.message));
  }, [days]);

  if (error) return <ErrorLine error={error} />;
  if (!d) return <Loading />;
  const fuRows = d.fu.map((r) => ({ month: r.month, kept: r.counts.completed ?? 0, missed: r.counts.overdue ?? 0, open: r.counts.due ?? 0 }));
  const keptTotal = fuRows.reduce((s, r) => s + r.kept, 0);
  const missedTotal = fuRows.reduce((s, r) => s + r.missed, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Clinic analytics</h1>
          <p>Computed from verified notes with MongoDB aggregation pipelines.</p>
        </div>
        <label className="field" style={{ width: 180 }}>Period for rankings
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option>
          </select>
        </label>
      </div>

      <div className="two-col">
        <section>
          <h2 style={{ marginBottom: 12 }}>Visits per month</h2>
          <TimeBars rows={d.visits} x="month" series={[{ key: 'visits', label: 'Visits', className: 's-main' }]} formatX={month} />
        </section>
        <section>
          <h2 style={{ marginBottom: 4 }}>Follow-ups kept and missed</h2>
          <p className="muted small" style={{ marginBottom: 8 }}>{pct(keptTotal / Math.max(1, keptTotal + missedTotal))} of follow-ups that fell due were kept.</p>
          <TimeBars rows={fuRows} x="month" series={[{ key: 'kept', label: 'Kept', className: 's-good' }, { key: 'missed', label: 'Missed', className: 's-alert' }]} formatX={month} />
        </section>
      </div>

      <div className="two-col section">
        <section>
          <h2 style={{ marginBottom: 12 }}>Most common diagnoses</h2>
          <RankBars rows={d.dx} label="term" value="visits" />
        </section>
        <section>
          <h2 style={{ marginBottom: 12 }}>Most prescribed medicines</h2>
          <RankBars rows={d.meds} label="drug" value="prescriptions" />
        </section>
      </div>

      <section className="section">
        <h2>How accurate is the extraction?</h2>
        <p className="muted" style={{ margin: '6px 0 12px', maxWidth: '72ch' }}>
          Each time a doctor verifies a note, the system compares what it proposed with what the doctor confirmed. Precision is the share of proposed items the doctor kept; recall is the share of confirmed items the system had found. Based on {d.quality.notes} checked notes; follow-up dates were right {pct(d.quality.followUpAccuracy)} of the time.
        </p>
        <table className="table" style={{ maxWidth: 680 }}>
          <thead><tr><th>Field</th><th className="num">Precision</th><th className="num">Recall</th><th className="num">Kept</th><th className="num">Wrong</th><th className="num">Missed</th></tr></thead>
          <tbody>
            {d.quality.fields.map((f) => (
              <tr key={f.field}><td style={{ textTransform: 'capitalize' }}>{f.field}</td><td className="num">{pct(f.precision)}</td><td className="num">{pct(f.recall)}</td><td className="num">{f.tp}</td><td className="num">{f.fp}</td><td className="num">{f.fn}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {d.review.notes > 0 && (
        <section className="section">
          <h2>Review effort and triage</h2>
          <p className="muted" style={{ margin: '6px 0 12px', maxWidth: '72ch' }}>
            Items the models agree on with high confidence are auto-accepted; the rest are flagged for checking. If auto-accepted items are almost never changed by the doctor, the triage is safe to rely on. Based on {d.review.notes} verified notes with a recorded review time.{d.review.simulated > 0 && ` In this demo, ${d.review.simulated} of them are seeded notes whose review times are simulated; only notes verified through this screen have real times.`}
          </p>
          <div className="stat-grid">
            <div className="stat"><div className="v">{Math.round(d.review.seconds)} s</div><div className="k">Average review time</div></div>
            <div className="stat"><div className="v">{d.review.secondsNoCheck != null ? `${Math.round(d.review.secondsNoCheck)} s` : '—'}</div><div className="k">…when nothing was flagged ({d.review.noCheck} notes)</div></div>
            <div className="stat"><div className="v">{d.review.secondsWithCheck != null ? `${Math.round(d.review.secondsWithCheck)} s` : '—'}</div><div className="k">…when something was flagged</div></div>
            <div className="stat"><div className="v">{pct(d.review.autoShare)}</div><div className="k">Items auto-accepted</div></div>
            <div className="stat"><div className="v">{pct(d.review.autoPrecision)}</div><div className="k">Auto-accepted items kept unchanged</div></div>
            <div className="stat"><div className="v">{d.review.learnedTerms}</div><div className="k">Terms learned from doctors</div></div>
          </div>
        </section>
      )}
    </>
  );
}
