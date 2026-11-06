import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { HighlightedNote, ErrorLine } from '../components/ui.jsx';

const SAMPLE = 'Pt c/o fatigue and polyuria x 3 wks. No fever. FBS 162. Dx T2DM. Start metformin 500 mg BD. Review in 4 wks with HbA1c.';
const mark = (word, type, label = word) => {
  const s = SAMPLE.indexOf(word);
  return { type, label, span: [s, s + word.length] };
};
const SAMPLE_ENTITIES = [
  mark('fatigue', 'symptom'), mark('polyuria', 'symptom'), mark('fever', 'negated', 'fever (absent)'),
  mark('FBS 162', 'lab'), mark('T2DM', 'diagnosis', 'type 2 diabetes (E11)'),
  mark('metformin 500 mg BD', 'medication', 'metformin 500 mg twice daily, start'),
  mark('Review in 4 wks with HbA1c', 'followup', 'follow-up in 28 days'),
];

const DEMO = [
  { email: 'doctor@clinic.test', who: 'Dr. Asha Mehra', role: 'Doctor' },
  { email: 'staff@clinic.test', who: 'Neha', role: 'Front desk' },
  { email: 'admin@clinic.test', who: 'Clinic Admin', role: 'Administrator' },
];

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('doctor@clinic.test');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e, override) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api('/auth/login', { method: 'POST', body: override ?? { email, password } });
      login(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-art" aria-label="What the system does">
        <h1>Notes stay as written. The records become searchable.</h1>
        <HighlightedNote text={SAMPLE} entities={SAMPLE_ENTITIES} />
        <p className="muted">
          Every underline is read from the doctor's note by models running on this server, then checked by a doctor before it counts.
        </p>
      </section>
      <section className="login-form">
        <h2>Sign in</h2>
        <form onSubmit={submit} className="facts" style={{ gap: 12 }}>
          <label className="field">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
          <label className="field">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
          <ErrorLine error={error} />
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div>
          <p className="muted small" style={{ marginBottom: 8 }}>Demo accounts (password demo1234)</p>
          <div className="demo-accounts">
            {DEMO.map((d) => (
              <button key={d.email} type="button" className="secondary" disabled={busy} onClick={() => submit(null, { email: d.email, password: 'demo1234' })}>
                <span>Sign in as {d.who}</span><span className="muted small">{d.role}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
