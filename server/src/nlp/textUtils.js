// Text helpers shared by the extractor, the embedder and the assistant.

const NO_SPLIT_BEFORE_DOT = new Set(['tab', 'tabs', 'cap', 'caps', 'syp', 'inj', 'susp', 'oint', 'dr', 'mr', 'mrs', 'ms', 't', 'vs', 'approx', 's', 'sr', 'st', 'no', 'e.g', 'i.e', 'pt']);

/**
 * Split a note into sentences, keeping character offsets.
 * Splits on newlines, semicolons and on ". " unless the dot ends a known
 * abbreviation such as "Tab." or "Dr.". Decimal numbers never split.
 */
export function splitSentences(text) {
  const out = [];
  let start = 0;
  const push = (end) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const s = start + lead;
    const e = start + raw.trimEnd().length;
    if (e > s) out.push({ start: s, end: e, text: text.slice(s, e) });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === ';') { push(i); start = i + 1; continue; }
    if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1] ?? ' ')) {
      if (ch === '?' ) {
        // "?UTI" style uncertainty marker sits before a word, so only split on "? " at clause end
        const prev = text.slice(Math.max(0, i - 1), i);
        if (!/[a-z0-9)]/i.test(prev)) continue;
      }
      const before = text.slice(start, i).match(/([A-Za-z.]+)$/);
      if (ch === '.' && before && NO_SPLIT_BEFORE_DOT.has(before[1].toLowerCase())) continue;
      push(i + 1); start = i + 1;
    }
  }
  push(text.length);
  return out;
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Compile an alternation regex of aliases, longest first, bounded by non-alphanumerics. */
export function compileAliasRegex(aliases) {
  const sorted = [...new Set(aliases.map((a) => a.toLowerCase()))].sort((a, b) => b.length - a.length);
  const body = sorted.map((a) => escapeRegex(a).replace(/\\? /g, '\\s+')).join('|');
  return new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, 'gi');
}

export function normaliseSpace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };

export function parseNumberWord(s) {
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return NUMBER_WORDS[s.toLowerCase()] ?? null;
}

/** Convert an amount + unit ("3", "wks") into days. */
export function toDays(amount, unit) {
  const n = parseNumberWord(amount);
  if (n == null) return null;
  const u = unit.toLowerCase();
  if (/^(d|day|days|dys)$/.test(u)) return n;
  if (/^(w|wk|wks|week|weeks)$/.test(u)) return n * 7;
  if (/^(m|mo|mth|mths|mon|month|months)$/.test(u)) return n * 30;
  if (/^(y|yr|yrs|year|years)$/.test(u)) return n * 365;
  return null;
}

/** "3/7" = 3 days, "2/52" = 2 weeks, "1/12" = 1 month (clinical shorthand). */
export function fractionToDays(num, den) {
  const n = Number(num);
  if (den === '7') return n;
  if (den === '52') return n * 7;
  if (den === '12') return n * 30;
  return null;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
