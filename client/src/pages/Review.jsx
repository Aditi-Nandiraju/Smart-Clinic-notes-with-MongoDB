import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, age, fmtDate, getSocket } from '../api.js';
import { useAuth } from '../App.jsx';
import { HighlightedNote, Legend, ErrorLine, Loading, StatusTag, ItemWhy } from '../components/ui.jsx';

const FREQS = ['once daily', 'twice daily', 'three times daily', 'four times daily', 'at bedtime', 'as needed', 'once weekly', 'once immediately'];
const ACTIONS = [['prescribe', 'Prescribed'], ['start', 'Started'], ['continue', 'Continued'], ['increase', 'Increased'], ['decrease', 'Reduced'], ['stop', 'Stopped'], ['mention', 'Mentioned only']];
const CERTAINTY = [['confirmed', 'Confirmed'], ['provisional', 'Provisional'], ['ruled_out', 'Ruled out']];
const CONTEXT = [['current', 'This visit'], ['known', 'Known condition'], ['history', 'Past history'], ['family', 'Family history']];

/** Highlightable entities from the editable extraction, keyed so list and note stay linked. */
function entitiesOf(x) {
  if (!x) return [];
  const out = [];
  (x.symptoms ?? []).forEach((s, i) => out.push({ key: `symptoms:${i}`, type: s.negated ? 'negated' : 'symptom', label: s.term, span: s.span }));
  (x.diagnoses ?? []).forEach((d, i) => out.push({ key: `diagnoses:${i}`, type: d.certainty === 'ruled_out' ? 'negated' : 'diagnosis', label: `${d.term} (${d.code})`, span: d.span }));
  (x.medications ?? []).forEach((m, i) => out.push({ key: `medications:${i}`, type: 'medication', label: m.generic, span: m.span }));
  (x.labs ?? []).forEach((l, i) => out.push({ key: `labs:${i}`, type: 'lab', label: l.test, span: l.span }));
  (x.vitals ?? []).forEach((v, i) => out.push({ key: `vitals:${i}`, type: 'vital', label: v.name, span: v.span }));
  (x.allergies ?? []).forEach((a, i) => out.push({ key: `allergies:${i}`, type: 'allergy', label: a.substance, span: a.span }));
  if (x.followUp?.span) out.push({ key: 'followUp', type: 'followup', label: 'follow-up', span: x.followUp.span });
  (x.unmapped ?? []).forEach((u, i) => out.push({ key: `unmapped:${i}`, type: 'unmapped', label: `${u.type}, not in vocabulary`, span: u.span }));
  return out.filter((e) => Array.isArray(e.span));
}

function Group({ title, single, items, onAdd, readOnly, children, head }) {
  return (
    <section className="fact-group">
      <h3>{title}<span className="count">{items.length || 'none'}</span></h3>
      {items.length > 0 && head}
      {children}
      {!readOnly && onAdd && <button type="button" className="quiet" onClick={onAdd}>Add {single}</button>}
    </section>
  );
}

export default function Review() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [x, setX] = useState(null);
  const [lex, setLex] = useState({ diagnoses: [], drugs: [] });
  const [active, setActive] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [onlyCheck, setOnlyCheck] = useState(false);
  const [selection, setSelection] = useState(null);
  const [mapTo, setMapTo] = useState({});
  const factRefs = useRef({});
  const openedAt = useRef(Date.now());

  async function load() {
    const d = await api(`/encounters/${id}`);
    setData(d);
    if (d.encounter.status === 'needs_review') openedAt.current = Date.now();
    setX(d.encounter.extraction ? structuredClone(d.encounter.extraction) : null);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api('/lexicon').then(setLex).catch(() => {});
    const s = getSocket();
    const onChange = (ev) => { if (ev.id === id) load(); };
    s?.on('encounter:changed', onChange);
    return () => s?.off('encounter:changed', onChange);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // fallback while the extraction queue works, in case live updates are off
  useEffect(() => {
    if (data?.encounter.status !== 'pending') return undefined;
    const t = setInterval(() => load().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [data?.encounter.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const entities = useMemo(() => entitiesOf(x), [x]);
  const readOnly = data?.encounter.status === 'verified' || user.role !== 'doctor';

  if (error) return <ErrorLine error={error} />;
  if (!data) return <Loading />;
  const { encounter: enc, patient, doctor } = data;

  const update = (field, i, patch) => setX((cur) => {
    const next = structuredClone(cur);
    if (field === 'followUp') next.followUp = { ...(next.followUp ?? {}), ...patch };
    else next[field][i] = { ...next[field][i], ...patch };
    return next;
  });
  const remove = (field, i) => setX((cur) => { const n = structuredClone(cur); n[field].splice(i, 1); return n; });
  const add = (field, item, span = null) => setX((cur) => { const n = structuredClone(cur); n[field] = [...(n[field] ?? []), { ...item, span, addedByReviewer: true }]; return n; });
  const pick = (key) => {
    setActive(key);
    factRefs.current[key]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    factRefs.current[key]?.querySelector('input,select')?.focus({ preventScroll: true });
  };
  const factProps = (key, type, added, item) => ({
    ref: (el) => { factRefs.current[key] = el; },
    className: `fact fact-${type}${active === key ? ' is-active' : ''}${added ? ' added' : ''}${item?.check && !readOnly ? ' needs-check' : ''}${onlyCheck && !readOnly && item && !item.check && !added ? ' is-hidden' : ''}`,
    onMouseEnter: () => setActive(key),
    onFocus: () => setActive(key),
  });
  const Remove = ({ field, i }) => (readOnly ? <span /> : <button type="button" className="quiet" aria-label="Remove" onClick={() => remove(field, i)}>Remove</button>);

  // add a mention the doctor selected in the note, or an unmapped suggestion;
  // `learn` asks the server to remember the wording for next time
  function addFromText(kind, sel, concept) {
    const span = [sel.start, sel.end];
    if (kind === 'symptom') add('symptoms', { term: (concept || sel.text).toLowerCase(), negated: false, durationDays: null, learn: true, surface: sel.text }, span);
    if (kind === 'diagnosis') {
      const hit = lex.diagnoses.find((d) => d.term.toLowerCase() === (concept || '').toLowerCase());
      add('diagnoses', { term: hit?.term ?? concept ?? sel.text, code: hit?.code ?? '', certainty: 'confirmed', context: 'current', learn: true, surface: sel.text }, span);
    }
    if (kind === 'medication') add('medications', { generic: (concept || '').toLowerCase(), dose: null, unit: 'mg', frequency: null, action: 'prescribe', learn: true, surface: sel.text, nameSpan: span, flags: [] }, span);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }
  const dismissUnmapped = (i) => setX((cur) => { const n = structuredClone(cur); n.unmapped.splice(i, 1); return n; });
  function mapUnmapped(i) {
    const u = x.unmapped[i];
    addFromText(u.type, { start: u.span[0], end: u.span[1], text: u.surface }, mapTo[u.span[0]] ?? (u.type === 'symptom' ? u.surface : ''));
    dismissUnmapped(i);
  }
  const toCheck = x ? [...x.symptoms, ...x.diagnoses, ...x.medications, ...(x.allergies ?? [])].filter((i) => i.check).length + (x.unmapped?.length ?? 0) : 0;
  const totalItems = x ? x.symptoms.length + x.diagnoses.length + x.medications.length + x.labs.length + x.vitals.length + (x.allergies?.length ?? 0) : 0;

  async function downloadFhir() {
    try {
      const b = await api(`/encounters/${id}/fhir`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/fhir+json' }));
      const a = document.createElement('a'); a.href = url; a.download = `encounter-${id}.fhir.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.message); }
  }

  async function verify() {
    setBusy(true); setError(null);
    try {
      const reviewSeconds = Math.round((Date.now() - openedAt.current) / 1000);
      const r = await api(`/encounters/${id}/verify`, { method: 'POST', body: { extraction: x, reviewSeconds } });
      setDone(r);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function reextract() {
    setBusy(true);
    try { await api(`/encounters/${id}/reextract`, { method: 'POST' }); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <datalist id="dx-list">{lex.diagnoses.map((d) => <option key={d.code} value={d.term}>{d.code}</option>)}</datalist>
      <datalist id="drug-list">{lex.drugs.map((d) => <option key={d.generic} value={d.generic}>{d.cls}</option>)}</datalist>

      <div className="page-head">
        <div>
          <h1>{enc.status === 'verified' ? 'Checked note' : 'Check this note'}</h1>
          <p>
            <Link to={`/patients/${patient._id}`}>{patient.name}</Link>, {age(patient.dob)}{patient.sex} · seen {fmtDate(enc.visitDate)} by {doctor?.name ?? 'unknown'}
            {patient.allergies?.length > 0 && <span className="allergy-line"> · allergic to {patient.allergies.join(', ')}</span>}
          </p>
        </div>
        <StatusTag status={enc.status} />
      </div>

      {enc.status === 'pending' || !x ? <Loading what="Reading the note" /> : (
        <div className="review">
          <div className="review-note">
            <HighlightedNote text={enc.rawNote} entities={entities} active={active} onPick={pick} onSelectText={readOnly ? undefined : setSelection} />
            {selection && !readOnly && (
              <div className="selection-bar" role="group" aria-label="Add selected text">
                <span>Add “{selection.text}” as</span>
                <button type="button" className="secondary" onClick={() => addFromText('symptom', selection)}>a symptom</button>
                <button type="button" className="secondary" onClick={() => addFromText('diagnosis', selection, '')}>a diagnosis</button>
                <button type="button" className="secondary" onClick={() => addFromText('medication', selection, '')}>a medicine</button>
              </div>
            )}
            <Legend types={['symptom', 'negated', 'diagnosis', 'medication', 'lab', 'vital', 'allergy', 'followup', 'unmapped']} />
            {!readOnly && <p className="muted small" style={{ marginTop: 12 }}>Click an underline to jump to that item. To add something the system missed, select its words in the note: the system will also learn that wording.</p>}
            {enc.status === 'verified' && enc.review?.seconds != null && (
              <p className="muted small" style={{ marginTop: 8 }}>Review took {enc.review.seconds} s; {enc.review.autoAccepted} item(s) were auto-accepted{enc.review.autoPrecision != null ? ` and ${Math.round(enc.review.autoPrecision * 100)}% of them kept` : ''}, {enc.review.flagged} flagged for checking.</p>
            )}
            {enc.status === 'verified' && <button type="button" className="secondary" style={{ marginTop: 12 }} onClick={downloadFhir}>Download FHIR R4 bundle</button>}
            {enc.status === 'verified' && enc.corrections && (
              <p className="muted small" style={{ marginTop: 12 }}>
                Verified {fmtDate(enc.verifiedAt)}. {enc.corrections.edited ? `The doctor changed ${enc.corrections.totals.fp + enc.corrections.totals.fn} item(s) from what the extractor proposed.` : 'Accepted as extracted, no changes.'}
              </p>
            )}
          </div>

          <div className="facts">
            {x?.meta?.warnings?.length > 0 && !readOnly && (
              <ul className="warnings" aria-label="Things to check">{x.meta.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}

            {!readOnly && (
              <div className="triage-bar">
                <span><strong>{toCheck}</strong> of {totalItems} item(s) need checking{x.meta?.models?.llm?.model ? ` · LLM: ${x.meta.models.llm.model}` : ''}{x.meta?.models?.ml ? ' · ML tagger on' : ''}</span>
                <label className="check"><input type="checkbox" checked={onlyCheck} onChange={(e) => setOnlyCheck(e.target.checked)} />show only items to check</label>
              </div>
            )}

            {!readOnly && x.unmapped?.length > 0 && (
              <section className="fact-group">
                <h3>Not in the vocabulary<span className="count">{x.unmapped.length}</span></h3>
                <p className="muted small">The ML tagger or LLM thinks these are clinical terms, but the system does not know what they mean. Map one and it will be recognised from now on.</p>
                <div className="unmapped-list">
                  {x.unmapped.map((u, i) => (
                    <div key={`${u.span[0]}-${u.surface}`} className="unmapped-row" onMouseEnter={() => setActive(`unmapped:${i}`)}>
                      <span><span className="surface">{u.surface}</span><br /><span className="small muted">{u.type} · {(u.sources ?? []).map((s) => (s === 'ml' ? 'ML tagger' : s === 'llm' ? 'LLM' : s)).join(' + ')}</span></span>
                      <input list={u.type === 'medication' ? 'drug-list' : u.type === 'diagnosis' ? 'dx-list' : undefined} placeholder={u.type === 'medication' ? 'Generic name' : u.type === 'diagnosis' ? 'Diagnosis' : 'Symptom term'} value={mapTo[u.span[0]] ?? (u.type === 'symptom' ? u.surface.toLowerCase() : '')} onChange={(e) => setMapTo({ ...mapTo, [u.span[0]]: e.target.value })} aria-label={`Meaning of ${u.surface}`} />
                      <button type="button" className="secondary" onClick={() => mapUnmapped(i)} disabled={u.type !== 'symptom' && !mapTo[u.span[0]]}>Add</button>
                      <button type="button" className="quiet" onClick={() => dismissUnmapped(i)}>Not clinical</button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <Group title="Symptoms" single="a symptom" items={x.symptoms} readOnly={readOnly} onAdd={() => add('symptoms', { term: '', negated: false, durationDays: null })}
              head={<div className="col-head grid-sym"><span>Symptom</span><span>Absent</span><span>Days</span><span /></div>}>
              {x.symptoms.map((s, i) => (
                <div key={i} {...factProps(`symptoms:${i}`, s.negated ? 'negated' : 'symptom', s.addedByReviewer, s)}>
                  <div className="grid-sym" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                    <input value={s.term} disabled={readOnly} onChange={(e) => update('symptoms', i, { term: e.target.value })} aria-label="Symptom" />
                    <label className="check"><input type="checkbox" checked={!!s.negated} disabled={readOnly} onChange={(e) => update('symptoms', i, { negated: e.target.checked })} />absent</label>
                    <input type="number" min="0" value={s.durationDays ?? ''} disabled={readOnly || s.negated} onChange={(e) => update('symptoms', i, { durationDays: e.target.value })} aria-label="Duration in days" />
                    <Remove field="symptoms" i={i} />
                  </div>
                  {!readOnly && <ItemWhy item={s} />}
                </div>
              ))}
            </Group>

            <Group title="Diagnoses" single="a diagnosis" items={x.diagnoses} readOnly={readOnly} onAdd={() => add('diagnoses', { term: '', code: '', certainty: 'confirmed', context: 'current' })}
              head={<div className="col-head grid-dx"><span>Diagnosis</span><span>ICD-10</span><span>Certainty</span><span>Context</span><span /></div>}>
              {x.diagnoses.map((d, i) => (
                <div key={i} {...factProps(`diagnoses:${i}`, d.certainty === 'ruled_out' ? 'negated' : 'diagnosis', d.addedByReviewer, d)}>
                  <div className="grid-dx" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                    <input list="dx-list" value={d.term} disabled={readOnly} aria-label="Diagnosis" onChange={(e) => {
                      const hit = lex.diagnoses.find((l) => l.term === e.target.value);
                      update('diagnoses', i, { term: e.target.value, ...(hit ? { code: hit.code } : {}) });
                    }} />
                    <input value={d.code} disabled={readOnly} onChange={(e) => update('diagnoses', i, { code: e.target.value.toUpperCase() })} aria-label="ICD-10 code" />
                    <select value={d.certainty} disabled={readOnly} onChange={(e) => update('diagnoses', i, { certainty: e.target.value })} aria-label="Certainty">{CERTAINTY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <select value={d.context ?? 'current'} disabled={readOnly} onChange={(e) => update('diagnoses', i, { context: e.target.value })} aria-label="Context">{CONTEXT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <Remove field="diagnoses" i={i} />
                  </div>
                  {!readOnly && <ItemWhy item={d} />}
                </div>
              ))}
            </Group>

            <Group title="Medications" single="a medicine" items={x.medications} readOnly={readOnly} onAdd={() => add('medications', { generic: '', dose: null, unit: 'mg', frequency: 'once daily', action: 'prescribe' })}
              head={<div className="col-head grid-med"><span>Medicine</span><span>Dose</span><span>Unit</span><span>How often</span><span>Change</span><span /></div>}>
              {x.medications.map((m, i) => (
                <div key={i} {...factProps(`medications:${i}`, 'medication', m.addedByReviewer, m)}>
                  <div className="grid-med" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                    <input list="drug-list" value={m.generic} disabled={readOnly} onChange={(e) => update('medications', i, { generic: e.target.value })} aria-label="Medicine" title={m.surface ? `Written as "${m.surface}"` : undefined} />
                    <input type="number" min="0" step="any" value={m.dose ?? ''} disabled={readOnly} onChange={(e) => update('medications', i, { dose: e.target.value })} aria-label="Dose" />
                    <input value={m.unit ?? ''} disabled={readOnly} onChange={(e) => update('medications', i, { unit: e.target.value })} aria-label="Unit" />
                    <select value={m.frequency ?? ''} disabled={readOnly} onChange={(e) => update('medications', i, { frequency: e.target.value || null })} aria-label="Frequency">
                      <option value="">Not stated</option>{FREQS.map((f) => <option key={f}>{f}</option>)}
                    </select>
                    <select value={m.action} disabled={readOnly} onChange={(e) => update('medications', i, { action: e.target.value })} aria-label="Change">{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <Remove field="medications" i={i} />
                  </div>
                  {m.negated && <span className="small muted">Read as not taken or to avoid</span>}
                  {m.learn && m.surface && <span className="small muted">Will learn “{m.surface}” = {m.generic || '…'}</span>}
                  {!readOnly && <ItemWhy item={m} />}
                </div>
              ))}
            </Group>

            <div className="facts" style={{ gap: 22 }}>
              <Group title="Lab results" single="a result" items={x.labs} readOnly={readOnly} onAdd={() => add('labs', { test: '', value: '', unit: '' })}>
                {x.labs.map((l, i) => (
                  <div key={i} {...factProps(`labs:${i}`, 'lab', l.addedByReviewer)}>
                    <div className="grid-lab" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                      <input value={l.test} disabled={readOnly} onChange={(e) => update('labs', i, { test: e.target.value })} aria-label="Test" />
                      <input value={l.value ?? ''} disabled={readOnly} onChange={(e) => update('labs', i, { value: e.target.value })} aria-label="Value" />
                      <input value={l.unit ?? ''} disabled={readOnly} onChange={(e) => update('labs', i, { unit: e.target.value })} aria-label="Unit" />
                      <Remove field="labs" i={i} />
                    </div>
                  </div>
                ))}
              </Group>
              <Group title="Vital signs" single="a vital sign" items={x.vitals} readOnly={readOnly} onAdd={() => add('vitals', { name: '', value: '', unit: '' })}>
                {x.vitals.map((v, i) => (
                  <div key={i} {...factProps(`vitals:${i}`, 'vital', v.addedByReviewer)}>
                    <div className="grid-vital" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                      <input value={v.name} disabled={readOnly} onChange={(e) => update('vitals', i, { name: e.target.value })} aria-label="Vital sign" />
                      <input value={v.value ?? ''} disabled={readOnly} onChange={(e) => update('vitals', i, { value: e.target.value })} aria-label="Value" />
                      <input value={v.unit ?? ''} disabled={readOnly} onChange={(e) => update('vitals', i, { unit: e.target.value })} aria-label="Unit" />
                      <Remove field="vitals" i={i} />
                    </div>
                  </div>
                ))}
              </Group>
            </div>

            <Group title="Allergies" single="an allergy" items={x.allergies ?? []} readOnly={readOnly} onAdd={() => add('allergies', { substance: '' })}>
              {(x.allergies ?? []).map((a, i) => (
                <div key={i} {...factProps(`allergies:${i}`, 'allergy', a.addedByReviewer, a)}>
                  <div className="grid-fu" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                    <input value={a.substance} disabled={readOnly} onChange={(e) => update('allergies', i, { substance: e.target.value })} aria-label="Allergy" />
                    <span />
                    <Remove field="allergies" i={i} />
                  </div>
                </div>
              ))}
            </Group>

            <section className="fact-group">
              <h3>Follow-up</h3>
              <div {...factProps('followUp', 'followup', false)}>
                <div className="grid-fu" style={{ display: 'grid', gap: 6, alignItems: 'center' }}>
                  <input type="date" value={x.followUp?.dueDate ?? ''} disabled={readOnly || x.followUp?.asNeeded} onChange={(e) => update('followUp', 0, { dueDate: e.target.value || null, asNeeded: false })} aria-label="Follow-up date" />
                  <input value={x.followUp?.purpose ?? ''} placeholder="Purpose, e.g. with HbA1c" disabled={readOnly} onChange={(e) => update('followUp', 0, { purpose: e.target.value })} aria-label="Purpose" />
                  <label className="check"><input type="checkbox" checked={!!x.followUp?.asNeeded} disabled={readOnly} onChange={(e) => update('followUp', 0, { asNeeded: e.target.checked, dueDate: e.target.checked ? null : x.followUp?.dueDate ?? null })} />only if needed</label>
                </div>
              </div>
              {!x.followUp?.dueDate && !x.followUp?.asNeeded && <p className="muted small">No follow-up will be scheduled.</p>}
            </section>

            {done && <p className="ok" role="status">Verified. {done.followup ? `Follow-up scheduled for ${fmtDate(done.followup.dueDate)}. ` : ''}{done.closedFollowups ? `${done.closedFollowups} earlier follow-up marked as kept. ` : ''}{done.learned?.length ? `Learned ${done.learned.map((l) => `“${l.alias}”`).join(', ')}. ` : ''}{done.review?.seconds != null ? `Review took ${done.review.seconds} s.` : ''}</p>}
            <ErrorLine error={error} />
            {!readOnly && (
              <div className="verify-bar">
                <button type="button" className="secondary" onClick={reextract} disabled={busy}>Read the note again</button>
                <div className="row">
                  <button type="button" className="quiet" onClick={() => navigate('/review')}>Back to the queue</button>
                  <button type="button" onClick={verify} disabled={busy}>{busy ? 'Saving…' : 'Confirm and verify'}</button>
                </div>
              </div>
            )}
            {readOnly && done && <div className="row"><Link className="button" to="/review">Next note</Link></div>}
          </div>
        </div>
      )}
    </>
  );
}
