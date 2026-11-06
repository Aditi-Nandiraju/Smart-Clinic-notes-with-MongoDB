import React from 'react';
import { Link } from 'react-router-dom';
import { fmtDate } from '../api.js';

export const ENTITY_NAMES = {
  symptom: 'Symptom', negated: 'Absent or ruled out', diagnosis: 'Diagnosis', medication: 'Medication',
  lab: 'Lab result', vital: 'Vital sign', allergy: 'Allergy', followup: 'Follow-up', unmapped: 'Not in vocabulary',
};

const SOURCE_NAMES = { rules: 'rules', ml: 'ML tagger', llm: 'LLM' };

/** Which models found an item, its confidence, and why it needs checking. */
export function ItemWhy({ item }) {
  if (!item || item.addedByReviewer) return null;
  return (
    <div className="why">
      {(item.sources ?? []).map((s) => <span key={s} className={`src src-${s}`}>{SOURCE_NAMES[s] ?? s}</span>)}
      {item.confidence != null && <span className="conf">{Math.round(item.confidence * 100)}%</span>}
      {item.check && <span className="check-flag">Check: {(item.checkReasons ?? []).join('; ') || 'review'}</span>}
    </div>
  );
}

/**
 * A clinical note with every extracted item underlined in its type's colour.
 * `active` is the key of the item the reader is pointing at in the side panel.
 */
export function HighlightedNote({ text, entities = [], active = null, onPick, onSelectText }) {
  const ref = React.useRef(null);
  // character offsets of a text selection inside the note, for "add selected text"
  const onMouseUp = () => {
    if (!onSelectText || !ref.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !ref.current.contains(sel.anchorNode)) { onSelectText(null); return; }
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(ref.current);
    pre.setEnd(r.startContainer, r.startOffset);
    let start = pre.toString().length; let end = start + r.toString().length;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s|[.,;:]/.test(text[end - 1])) end--;
    onSelectText(end > start ? { start, end, text: text.slice(start, end) } : null);
  };
  const sorted = [...entities].filter((e) => Array.isArray(e.span)).sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  const parts = [];
  let pos = 0;
  sorted.forEach((e, i) => {
    const [s, end] = e.span;
    if (s < pos) return; // overlapping span: keep the earlier one
    if (s > pos) parts.push(<React.Fragment key={`t${i}`}>{text.slice(pos, s)}</React.Fragment>);
    const key = e.key ?? `${e.type}:${s}`;
    parts.push(
      <mark
        key={`m${i}`}
        className={`ent ent-${e.type}${active === key ? ' is-active' : ''}`}
        title={`${ENTITY_NAMES[e.type] ?? e.type}: ${e.label}`}
        onClick={onPick ? () => onPick(key) : undefined}
      >
        {text.slice(s, end)}
      </mark>,
    );
    pos = end;
  });
  if (pos < text.length) parts.push(<React.Fragment key="tail">{text.slice(pos)}</React.Fragment>);
  return <div className="note-text" ref={ref} onMouseUp={onMouseUp} onKeyUp={onMouseUp}>{parts}</div>;
}

export function Legend({ types = ['symptom', 'negated', 'diagnosis', 'medication', 'lab', 'vital', 'allergy', 'followup'] }) {
  return (
    <ul className="legend" aria-label="Highlight colours">
      {types.map((t) => <li key={t}><span className={`ent ent-${t}`}>{ENTITY_NAMES[t]}</span></li>)}
    </ul>
  );
}

/** Horizontal bars: label, bar, value. Good for ranked lists. */
export function RankBars({ rows, label, value, max: maxIn, format = (v) => v }) {
  const max = maxIn ?? Math.max(1, ...rows.map((r) => r[value] ?? 0));
  return (
    <div className="rank">
      {rows.map((r, i) => (
        <div className="rank-row" key={i}>
          <span className="rank-label">{r[label]}</span>
          <span className="rank-track"><span className="rank-bar" style={{ width: `${((r[value] ?? 0) / max) * 100}%` }} /></span>
          <span className="rank-value">{format(r[value])}</span>
        </div>
      ))}
    </div>
  );
}

/** Vertical bars over time. `series` = [{ key, label, className }] stacked. */
export function TimeBars({ rows, x, series, height = 160, formatX }) {
  const totals = rows.map((r) => series.reduce((s, ser) => s + (r[ser.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const w = 100 / Math.max(rows.length, 1);
  return (
    <figure className="timebars">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label="Bar chart">
        {rows.map((r, i) => {
          let y = height;
          return series.map((ser) => {
            const h = ((r[ser.key] ?? 0) / max) * (height - 4);
            y -= h;
            return <rect key={`${i}${ser.key}`} className={ser.className} x={i * w + w * 0.18} width={w * 0.64} y={y} height={h} />;
          });
        })}
      </svg>
      <div className="timebars-x">
        {rows.map((r, i) => (
          <span key={i} style={{ width: `${w}%` }}>
            <b>{totals[i]}</b>
            {formatX ? formatX(r[x]) : r[x]}
          </span>
        ))}
      </div>
      {series.length > 1 && (
        <figcaption className="timebars-key">
          {series.map((s) => <span key={s.key}><i className={s.className} />{s.label}</span>)}
        </figcaption>
      )}
    </figure>
  );
}

function cell(v, key) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDate(v);
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 100) / 100;
  if (key === 'lastAction') return { start: 'started', continue: 'continued', increase: 'increased', decrease: 'reduced', prescribe: 'prescribed', stop: 'stopped' }[v] ?? v;
  return String(v);
}

/** Table for assistant results. Patient names link to the patient page. */
export function ResultTable({ columns, rows }) {
  if (!rows?.length) return null;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map(([k]) => (
                <td key={k} className={typeof r[k] === 'number' ? 'num' : undefined}>
                  {k === 'patient' && r.patientId ? <Link to={`/patients/${r.patientId}`}>{r.patient}</Link> : cell(r[k], k)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusTag({ status }) {
  const label = { needs_review: 'Needs review', pending: 'Reading note…', verified: 'Verified', due: 'Due', overdue: 'Overdue', completed: 'Completed', cancelled: 'Cancelled' }[status] ?? status;
  return <span className={`tag tag-${status}`}>{label}</span>;
}

export function ErrorLine({ error }) {
  if (!error) return null;
  return <p className="error" role="alert">{error}</p>;
}

export function Loading({ what = 'Loading' }) {
  return <p className="muted" aria-live="polite">{what}…</p>;
}
