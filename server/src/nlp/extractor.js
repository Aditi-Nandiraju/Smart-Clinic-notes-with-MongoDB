// Local clinical information extraction.
//
// A hybrid rule-based pipeline (no external API, no network):
//   1. sentence segmentation with character offsets
//   2. dictionary NER for medications, diagnoses and symptoms (longest match,
//      context rules for ambiguous abbreviations, Jaro-Winkler typo tolerance)
//   3. NegEx-style negation and uncertainty detection scoped to clauses
//   4. attribute parsing: dose, unit, frequency, duration, action, form
//   5. regex extraction for vitals, labs (with reference-range flags) and follow-up
// Every extracted item carries the [start, end) span it came from, so the
// review screen can highlight it and the validator can verify it.

import natural from 'natural';
import { DRUGS, AMBIGUOUS_DRUG_ALIASES, DOSAGE_FORMS, FREQUENCIES, MED_ACTIONS } from './lexicon/drugs.js';
import { DIAGNOSES, SYMPTOMS, CONTEXT_ONLY_DX_ALIASES } from './lexicon/conditions.js';
import { LABS, QUALITATIVE_TESTS, VITALS, VITAL_RANGES } from './lexicon/measurements.js';
import {
  splitSentences, compileAliasRegex, toDays, fractionToDays, addDays, isoDate, parseNumberWord,
} from './textUtils.js';

export const EXTRACTOR_VERSION = 'cnis-ensemble-2.0';

// drugs where a bare 1 or 2 is a real dose in mg, not a tablet count
const LOW_DOSE_DRUGS = new Set(['glimepiride', 'clonazepam', 'alprazolam', 'prednisolone', 'ondansetron']);

// ---------------------------------------------------------------------------
// Lexicon indexes (rebuilt when the clinic's learned vocabulary changes)
// ---------------------------------------------------------------------------
let drugByAlias; let dxByAlias; let sxByAlias;
let DRUG_RE; let DX_RE; let SX_RE;
let FUZZY_DRUG_TERMS; let FUZZY_SX_TERMS; let FUZZY_DX_TERMS;
let customCount = 0;

const labByAlias = new Map();
for (const l of LABS) for (const a of l.aliases) labByAlias.set(a.toLowerCase(), l);
const qualByAlias = new Map();
for (const q of QUALITATIVE_TESTS) for (const a of q.aliases) qualByAlias.set(a.toLowerCase(), q);
const LAB_RE = compileAliasRegex([...labByAlias.keys()]);
const QUAL_RE = compileAliasRegex([...qualByAlias.keys()]);

/**
 * Add the clinic's learned vocabulary to the base lexicons.
 * entries: [{ type: 'drug'|'symptom'|'diagnosis', alias, concept }]
 *   drug concept: { generic, cls?, unit? }  (an existing generic, or a new drug)
 *   symptom concept: { term }               diagnosis concept: { term, code }
 */
// `exclude` (a Set of lowercase drug aliases) removes built-in aliases; it is
// only used by the evaluation to simulate brands the lexicon has never seen.
export function setCustomLexicon(entries = [], { exclude = null } = {}) {
  drugByAlias = new Map(); dxByAlias = new Map(); sxByAlias = new Map();
  for (const d of DRUGS) for (const a of d.aliases) if (!exclude?.has(a.toLowerCase())) drugByAlias.set(a.toLowerCase(), d);
  for (const d of DIAGNOSES) for (const a of d.aliases) dxByAlias.set(a.toLowerCase(), d);
  for (const x of SYMPTOMS) for (const a of x.aliases) sxByAlias.set(a.toLowerCase(), x);
  const drugByGeneric = new Map(DRUGS.map((d) => [d.generic, d]));
  const dxByCode = new Map(DIAGNOSES.map((d) => [d.code, d]));
  const sxByTerm = new Map(SYMPTOMS.map((x) => [x.term, x]));
  customCount = 0;
  for (const e of entries) {
    const alias = String(e.alias ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (alias.length < 2) continue;
    if (e.type === 'drug' && e.concept?.generic) {
      const g = e.concept.generic.toLowerCase();
      const entry = drugByGeneric.get(g) ?? { generic: g, cls: e.concept.cls ?? 'other', unit: e.concept.unit ?? 'mg', aliases: [], learned: true };
      drugByGeneric.set(g, entry);
      drugByAlias.set(alias, entry); customCount++;
    } else if (e.type === 'diagnosis' && e.concept?.code) {
      const entry = dxByCode.get(e.concept.code) ?? { term: e.concept.term, code: e.concept.code, chronic: false, aliases: [], learned: true };
      dxByCode.set(e.concept.code, entry);
      dxByAlias.set(alias, entry); customCount++;
    } else if (e.type === 'symptom' && e.concept?.term) {
      const t = e.concept.term.toLowerCase();
      const entry = sxByTerm.get(t) ?? { term: t, aliases: [], learned: true };
      sxByTerm.set(t, entry);
      sxByAlias.set(alias, entry); customCount++;
    }
  }
  DRUG_RE = compileAliasRegex([...drugByAlias.keys()]);
  DX_RE = compileAliasRegex([...dxByAlias.keys()]);
  SX_RE = compileAliasRegex([...sxByAlias.keys()]);
  FUZZY_DRUG_TERMS = [...drugByAlias.keys()].filter((a) => /^[a-z][a-z-]{5,}$/.test(a));
  FUZZY_SX_TERMS = [...sxByAlias.keys()].filter((a) => /^[a-z]{6,}$/.test(a));
  FUZZY_DX_TERMS = [...dxByAlias.keys()].filter((a) => /^[a-z]{7,}$/.test(a));
  return customCount;
}
setCustomLexicon([]);

export function lexiconStats() {
  return { drugs: new Set([...drugByAlias.values()].map((d) => d.generic)).size, diagnoses: new Set([...dxByAlias.values()].map((d) => d.code)).size, symptoms: new Set([...sxByAlias.values()].map((x) => x.term)).size, learnedAliases: customCount };
}

/** Is this surface form already known to the lexicon? */
export function knownAlias(type, surface) {
  const k = String(surface).toLowerCase().replace(/\s+/g, ' ').trim();
  if (type === 'medication' || type === 'drug') return drugByAlias.has(k);
  if (type === 'diagnosis') return dxByAlias.has(k);
  return sxByAlias.has(k) || dxByAlias.has(k);
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');

/**
 * Map a mention found by the ML tagger or the LLM to a lexicon concept:
 * exact alias first, then Jaro-Winkler fuzzy match. Returns null when unknown.
 */
export function normaliseMention(type, surface) {
  const k = norm(String(surface)).replace(/^(?:tab|cap|syp|inj|t)\.?\s+/i, '').trim();
  const maps = type === 'medication' ? [['medication', drugByAlias]] : type === 'diagnosis' ? [['diagnosis', dxByAlias], ['symptom', sxByAlias]] : [['symptom', sxByAlias], ['diagnosis', dxByAlias]];
  for (const [t, map] of maps) if (map.has(k)) return { type: t, entry: map.get(k), score: 1 };
  let best = null;
  for (const [t, map] of maps) {
    for (const alias of map.keys()) {
      if (Math.abs(alias.length - k.length) > 3 || alias[0] !== k[0]) continue;
      const sc = natural.JaroWinklerDistance(k, alias, { ignoreCase: true });
      if (sc >= 0.92 && (!best || sc > best.score)) best = { type: t, entry: map.get(alias), score: sc };
    }
  }
  return best;
}

const COMMON_WORDS = new Set(['started', 'continue', 'patient', 'tablets', 'advised', 'review', 'morning', 'evening', 'reports', 'history', 'reduced', 'increased', 'normal', 'better', 'worsening', 'improved', 'control', 'controlled', 'medicine', 'medicines', 'regular', 'hydration', 'tolerating', 'compliance', 'complains', 'presents', 'suggest', 'symptoms', 'symptomatic', 'evaluation', 'examined', 'follow', 'stopped', 'tablet', 'capsule', 'syrup', 'injection', 'months', 'weeks', 'review', 'lifestyle', 'exercise', 'walking', 'counselled', 'counseled', 'investigations', 'pending', 'reports', 'fasting', 'random']);

// ---------------------------------------------------------------------------
// Context cues
// ---------------------------------------------------------------------------
const DX_CUE_RE = /\b(?:dx|diagnosis|diagnosed|imp(?:ression)?|a\/p|assessment|provisional|k\/c\/o|known case|kco|h\/o|history of|pmh|r\/o|rule out|likely|probable|suspected|possible|c\/w|consistent with|s\/o|suggestive of|case of)\b|\?\s*[a-z]/i;
const COMPLAINT_CUE_RE = /\b(?:c\/o|complains? of|complaining of|presents? with|presented with|reports?|having|h\/o|history of)\b/i;

const NEG_PRE_RE = /\b(?:no|not|nil|denies|denied|deny|without|negative for|free of|absence of|never had|neither|nor|ruled out)\b|\bw\/o\b/gi;
const NEG_POST_RE = /^[\s,:-]*(?:\w+\s+){0,2}?(?:absent|-ve|negative|not present|ruled out|resolved|subsided|settled|nil)\b/i;
const NEG_TERMINATORS_RE = /\b(?:but|however|though|although|except|apart from|aside from|c\/o|complains?|presents?|reports?|has|now|which|with|having|developed|since)\b|[:]/i;
const UNCERTAIN_PRE_RE = /(?:\?\s*$|\b(?:r\/o|rule out|to rule out|likely|probable|probably|possible|possibly|suspected|suspect|query|provisional|s\/o|suggestive of|could be|may be|vs\.?|versus|ddx|differential)\b[^.]{0,20}$)/i;
const UNCERTAIN_POST_RE = /^\s*(?:\?|vs\.?\b|versus\b|to be ruled out|suspected|likely|\(provisional\))/i;
const KNOWN_RE = /\b(?:k\/c\/o|kco|known case of|known case|known|k\/c|on treatment for|on rx for)\b[^.]*$/i;
const HISTORY_RE = /\b(?:h\/o|history of|past history|pmh|s\/p|status post|previous(?:ly)?|old)\b[^.]*$/i;
const FAMILY_RE = /\b(?:family history|f\/h|fh|fhx|mother|father|brother|sister|parents?|sibling)\b[^.]*$/i;
const ALLERGY_RE = /\b(?:allerg(?:y|ic|ies)|intoleran(?:t|ce)|sensitiv(?:e|ity)|adverse reaction)\s*(?:to|:|-)?\s*$/i;
const NKDA_RE = /\b(?:nkda|no known drug allerg(?:y|ies)|no known allerg(?:y|ies)|nka)\b/i;
const RX_SECTION_RE = /^(?:rx|adv(?:ice)?|plan|treatment|tx|p\/)\b|\b(?:rx|adv)\s*[:\-]/i;
const ON_MED_RE = /\b(?:on|taking|already on|currently on|was on|using)\s+(?:\w+\s+){0,2}$/i;

const DURATION_RE = /(?:\b(?:x|for|since|×|past|last)\s*(?:the\s+)?(?:past\s+|last\s+)?(\d+|one|two|three|four|five|six|seven|ten|a)\s*(days?|d|dys|wks?|weeks?|w|months?|mths?|mo|m|yrs?|years?|y)\b|\b(\d+)\s*\/\s*(7|52|12)\b|×\s*(\d+)\s*(d|w|m)\b)/gi;

function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

function findAll(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0], m });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function sentenceOf(sentences, pos) {
  return sentences.find((s) => pos >= s.start && pos < s.end) ?? sentences[sentences.length - 1];
}

/** The clause (inside its sentence) that contains `pos`, bounded by negation terminators. */
function clauseBefore(sentText, relPos) {
  const head = sentText.slice(0, relPos);
  // cut at the last terminator so negation from an earlier clause does not leak
  let cut = 0;
  const termGlobal = new RegExp(NEG_TERMINATORS_RE.source, 'gi');
  let m;
  while ((m = termGlobal.exec(head))) cut = m.index + m[0].length;
  return head.slice(cut);
}

function isNegated(text, sent, start, end) {
  const relStart = start - sent.start;
  const before = clauseBefore(sent.text, relStart);
  NEG_PRE_RE.lastIndex = 0;
  if (NEG_PRE_RE.test(before)) return true;
  const after = sent.text.slice(end - sent.start, end - sent.start + 30);
  return NEG_POST_RE.test(after);
}

function certaintyFor(sent, start, end) {
  const before = sent.text.slice(Math.max(0, start - sent.start - 30), start - sent.start);
  const after = sent.text.slice(end - sent.start, end - sent.start + 25);
  if (UNCERTAIN_PRE_RE.test(before) || UNCERTAIN_POST_RE.test(after)) return 'provisional';
  return 'confirmed';
}

function contextFor(sent, start) {
  const before = sent.text.slice(0, start - sent.start);
  if (FAMILY_RE.test(before)) return 'family';
  if (KNOWN_RE.test(before)) return 'known';
  if (HISTORY_RE.test(before)) return 'history';
  return 'current';
}

// ---------------------------------------------------------------------------
// Entity candidates
// ---------------------------------------------------------------------------
function drugCandidates(text, sentences) {
  const out = [];
  for (const c of findAll(DRUG_RE, text)) {
    const key = norm(c.surface);
    const drug = drugByAlias.get(key);
    if (!drug) continue;
    const before = text.slice(Math.max(0, c.start - 8), c.start);
    const after = text.slice(c.end, c.end + 14);
    const hasForm = /(?:^|\s)(?:tab|tabs|cap|caps|syp|inj|t|susp|oint|inh)\.?\s*$/i.test(before);
    const hasStrength = /^\s*(?:sr|xr|xl|er|cr|mr|forte|ds|plus|lc|to)?\s*\d/i.test(after);
    const hasAction = /\b(?:start|add|increase|reduce|decrease|stop|cont|continue|on)\s*$/i.test(text.slice(Math.max(0, c.start - 12), c.start));
    const hasFormAfter = /^\s*(?:cream|ointment|gel|lotion|inhaler|syrup|drops|tab|tablets?)\b/i.test(after);
    if (AMBIGUOUS_DRUG_ALIASES.has(key) && !hasForm && !hasStrength && !hasAction && !hasFormAfter) continue;
    out.push({ type: 'medication', ...c, entry: drug, confidence: 0.95, hasForm, sources: ['rules'] });
  }
  return out;
}

function conditionCandidates(text, sentences) {
  const out = [];
  for (const c of findAll(DX_RE, text)) {
    const key = norm(c.surface);
    const dx = dxByAlias.get(key);
    if (!dx) continue;
    const sent = sentenceOf(sentences, c.start);
    const hasCue = DX_CUE_RE.test(sent.text);
    // short abbreviations ("DM", "OA", "AGE") only count in capitals with a diagnostic cue
    if (CONTEXT_ONLY_DX_ALIASES.has(key) && (c.surface !== c.surface.toUpperCase() || !hasCue)) continue;
    let type = 'diagnosis';
    if (dx.alsoSymptom && !hasCue && COMPLAINT_CUE_RE.test(sent.text)) type = 'symptom';
    out.push({ type, ...c, entry: dx, confidence: CONTEXT_ONLY_DX_ALIASES.has(key) ? 0.8 : 0.92, sources: ['rules'] });
  }
  for (const c of findAll(SX_RE, text)) {
    const sx = sxByAlias.get(norm(c.surface));
    if (!sx) continue;
    out.push({ type: 'symptom', ...c, entry: sx, confidence: norm(c.surface) === 'cold' ? 0.7 : 0.9, sources: ['rules'] });
  }
  return out;
}

function fuzzyCandidates(text, taken) {
  // RX_SECTION_RE is defined above; fuzzy drug names are accepted in prescription context
  const out = [];
  const wordRe = /[A-Za-z][A-Za-z-]{5,}/g;
  let m;
  while ((m = wordRe.exec(text))) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (taken.some((t) => overlaps(t, span))) continue;
    const w = m[0].toLowerCase();
    if (COMMON_WORDS.has(w) || drugByAlias.has(w) || sxByAlias.has(w) || dxByAlias.has(w)) continue;
    let best = null;
    const consider = (list, type, map, min) => {
      for (const term of list) {
        if (term[0] !== w[0] || Math.abs(term.length - w.length) > 2) continue;
        const score = natural.JaroWinklerDistance(w, term, { ignoreCase: true });
        if (score >= min && (!best || score > best.score)) best = { term, score, type, entry: map.get(term) };
      }
    };
    consider(FUZZY_DRUG_TERMS, 'medication', drugByAlias, 0.94);
    consider(FUZZY_SX_TERMS, 'symptom', sxByAlias, 0.93);
    consider(FUZZY_DX_TERMS, 'diagnosis', dxByAlias, 0.95);
    if (!best) continue;
    if (best.type === 'medication') {
      const after = text.slice(span.end, span.end + 12);
      const before = text.slice(Math.max(0, span.start - 8), span.start);
      const sentStart = text.lastIndexOf('\n', span.start) + 1;
      const sentText = text.slice(Math.max(sentStart, text.lastIndexOf('. ', span.start) + 1), span.end + 20);
      const ok = /^\s*\d/.test(after) || /(?:tab|cap|syp|inj|t)\.?\s*$/i.test(before)
        || /^\s*(?:inhaler|cream|ointment|gel|syrup|drops|sachets?|od|bd|tds|hs|sos)\b/i.test(after) || RX_SECTION_RE.test(sentText);
      if (!ok) continue;
    }
    out.push({ type: best.type, ...span, surface: m[0], entry: best.entry, confidence: Number((0.6 + (best.score - 0.9) * 2).toFixed(2)), fuzzy: true, fuzzyTo: best.term, sources: ['rules'] });
  }
  return out;
}

/** Greedy overlap resolution: longer spans first, then medications > diagnoses > symptoms. */
function resolve(cands) {
  const prio = { medication: 3, diagnosis: 2, symptom: 1 };
  const sorted = [...cands].sort((a, b) => (b.end - b.start) - (a.end - a.start) || prio[b.type] - prio[a.type] || a.start - b.start);
  const kept = [];
  for (const c of sorted) if (!kept.some((k) => overlaps(k, c))) kept.push(c);
  return kept.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Medication attributes
// ---------------------------------------------------------------------------
function parseMedication(text, sent, cand, nextStart) {
  const drug = cand.entry;
  const winEnd = Math.min(sent.end, nextStart ?? sent.end, cand.end + 90);
  const win = text.slice(cand.end, winEnd);
  const flags = [];
  let lastEnd = cand.end;
  let spanStart = cand.start;

  // dosage form just before the drug name
  let form = null;
  const formM = text.slice(Math.max(sent.start, cand.start - 8), cand.start).match(/([A-Za-z]+\.?)\s*$/);
  if (formM && DOSAGE_FORMS[formM[1].toLowerCase()]) {
    form = DOSAGE_FORMS[formM[1].toLowerCase()];
    spanStart = cand.start - formM[0].length;
  }

  const formAfter = win.match(/^\s*(inhaler|rotacap|syrup|drops|cream|ointment|gel|lotion|sachets?|injection|nebuli[sz]ation)\b/i);
  if (!form && formAfter) form = DOSAGE_FORMS[formAfter[1].toLowerCase()] ?? formAfter[1].toLowerCase();

  // strength: "500 mg", "SR 500", "40", "0.5mg", "10 units"
  let dose = null; let unit = null; let release = null;
  const formLen = formAfter ? formAfter[0].length : 0;
  const sm = win.slice(formLen).match(/^\s*[-:]?\s*(?:(sr|xr|xl|er|cr|mr|forte|ds|plus|lc|cv|[A-Z]{1,3})\s*)?(\d+(?:\.\d+)?)(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(mg|mcg|µg|ug|gm?|ml|iu|units?|u|%)?(?![\w/-])/i);
  if (sm) {
    release = sm[1] && !/^(to)$/i.test(sm[1]) ? sm[1].toUpperCase() : null;
    dose = Number(sm[2]);
    const restAfterDose = win.slice(formLen + sm[0].length);
    if (!sm[3] && dose <= 2 && !LOW_DOSE_DRUGS.has(drug.generic) && FREQUENCIES.some((f) => new RegExp(`^\\s*(?:${f.re.source.replace(/^\\b|\\b$/g, '')})`, 'i').test(restAfterDose))) {
      // "Tab Livogen 1 OD": one tablet, not 1 mg
      flags.push(`count:${dose}`);
      dose = null;
    }
    if (dose == null) {
      unit = null;
    } else if (sm[3]) {
      unit = sm[3].toLowerCase().replace(/^gm$/, 'g').replace(/^(ug|µg)$/, 'mcg').replace(/^u$|^units?$/, 'units').replace('iu', 'IU');
    } else {
      unit = drug.unit;
      flags.push('unit_inferred');
    }
    lastEnd = cand.end + formLen + sm[0].length;
  } else {
    flags.push('no_dose');
  }

  // frequency: the earliest frequency expression after the drug
  let frequency = null;
  let bestPos = Infinity;
  for (const f of FREQUENCIES) {
    const fm = win.match(f.re);
    if (fm && fm.index < bestPos) { bestPos = fm.index; frequency = f.value; lastEnd = Math.max(lastEnd, cand.end + fm.index + fm[0].length); }
  }

  // duration of course
  let durationDays = null;
  const dm = win.match(/(?:\b(?:x|for|×)\s*(\d+|one|two|three|five|seven|ten)\s*(days?|d|wks?|weeks?|w|months?|mths?|mo|m)\b|\b(\d+)\s*\/\s*(7|52|12)\b)/i);
  if (dm) {
    durationDays = dm[1] ? toDays(dm[1], dm[2]) : fractionToDays(dm[3], dm[4]);
    lastEnd = Math.max(lastEnd, cand.end + dm.index + dm[0].length);
  }

  // action: look back to the start of the clause, then forward ("glimepiride stopped")
  const backStart = Math.max(sent.start, cand.prevEnd ?? sent.start);
  const back = text.slice(backStart, spanStart);
  let action = null;
  // "rash after starting Augmentin": a past event, not today's plan
  if (/\b(?:after|since|on|while)\s+(?:starting|taking|initiating|increasing|using|the dose of)\s+(?:(?:tab|cap|syp|inj)\.?\s+)?$/i.test(text.slice(sent.start, spanStart)) || /\bdue to\s*$|\(\s*$/i.test(text.slice(sent.start, spanStart))) {
    action = 'mention'; flags.push('history_mention');
  }
  if (!action) for (const a of MED_ACTIONS) if (a.re.test(back)) { action = a.value; break; }
  if (!action) {
    const fwd = win.slice(0, 30);
    for (const a of MED_ACTIONS) {
      if (a.value === 'start' || a.value === 'continue') continue;
      const am = fwd.match(a.re);
      if (am) { action = a.value; lastEnd = Math.max(lastEnd, cand.end + am.index + am[0].length); break; }
    }
    // "increased to 1000 mg" -> the new strength
    const inc = win.match(/^\s*(?:increased|increase|reduced|decreased|uptitrated|titrated)\s+to\s+(\d+(?:\.\d+)?)\s*(mg|mcg|units?)?/i);
    if (inc) { dose = Number(inc[1]); unit = inc[2] ? inc[2].toLowerCase() : drug.unit; lastEnd = cand.end + inc[0].length; flags.splice(flags.indexOf('no_dose'), flags.includes('no_dose') ? 1 : 0); }
  }
  if (!action) {
    const tail = text.slice(lastEnd, lastEnd + 24).match(/^\s*(?:is\s+|was\s+|to be\s+|has been\s+)?(continued|stopped|discontinued|held|withdrawn|increased|reduced|decreased|tapered|started|added)\b/i);
    if (tail) {
      const w = tail[1].toLowerCase();
      action = w === 'continued' ? 'continue' : /stopped|discontinued|held|withdrawn/.test(w) ? 'stop' : w === 'increased' ? 'increase' : /reduced|decreased|tapered/.test(w) ? 'decrease' : 'start';
      lastEnd += tail[0].length;
    }
  }
  if (!action && cand.prevAction && cand.prevAction !== 'mention' && /^[\s,]*(?:and|&|\+|,)?\s*(?:(?:tab|cap|syp|inj|t)\.?\s*)?$/i.test(text.slice(cand.prevEnd, spanStart))) {
    // "on Tab Telma 40 OD and Glycomet 500 BD": a listed drug shares the previous drug's action
    action = cand.prevAction;
  }
  if (!action) {
    if (ON_MED_RE.test(text.slice(sent.start, spanStart))) action = 'continue';
    else if (RX_SECTION_RE.test(sent.text) || form || dose != null || frequency) action = 'prescribe';
    else action = 'mention';
  }

  const relBefore = text.slice(Math.max(sent.start, spanStart - 25), spanStart);
  const negated = /\b(?:not|no|never|avoid|isn'?t|wasn'?t|non[- ]?compliant with|not taking|missed)\s+(?:\w+\s+){0,2}$/i.test(relBefore) && action !== 'stop';
  if (negated) flags.push('negated_or_nonadherent');
  if (cand.fuzzy) flags.push(`fuzzy_match:${cand.fuzzyTo}`);

  return {
    generic: drug.generic,
    drugClass: drug.cls,
    surface: cand.surface,
    form,
    release,
    dose,
    unit,
    frequency,
    durationDays,
    action,
    negated,
    confidence: Number((cand.confidence - (flags.includes('no_dose') ? 0.1 : 0)).toFixed(2)),
    flags,
    sources: cand.sources ?? ['rules'],
    span: [spanStart, lastEnd],
    nameSpan: [cand.start, cand.end],
  };
}

// ---------------------------------------------------------------------------
// Durations for symptoms
// ---------------------------------------------------------------------------
function durationsIn(text, sent) {
  const out = [];
  const re = new RegExp(DURATION_RE.source, 'gi');
  let m;
  while ((m = re.exec(sent.text))) {
    let days = null; let label = m[0].trim();
    if (m[1]) days = toDays(m[1], m[2]);
    else if (m[3]) days = fractionToDays(m[3], m[4]);
    else if (m[5]) days = toDays(m[5], m[6]);
    if (days != null) out.push({ start: sent.start + m.index, end: sent.start + m.index + m[0].length, days, label });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vitals and labs
// ---------------------------------------------------------------------------
function extractVitals(text) {
  const out = [];
  for (const v of VITALS) {
    for (const { start, end, m } of findAll(v.re, text)) {
      if (out.some((o) => overlaps({ start: o.span[0], end: o.span[1] }, { start, end }))) continue;
      if (v.two) {
        const sys = Number(m[1]); const dia = Number(m[2]);
        if (sys < 60 || sys > 260 || dia < 30 || dia > 160) continue;
        out.push({ name: v.name, systolic: sys, diastolic: dia, value: `${sys}/${dia}`, unit: v.unit, span: [start, end] });
        continue;
      }
      const value = Number(m[1]);
      let unit = v.unit;
      if (v.name === 'temperature') {
        unit = m[2] ? `°${m[2].toUpperCase()}` : (value > 45 ? '°F' : '°C');
        if ((unit === '°F' && (value < 90 || value > 110)) || (unit === '°C' && (value < 32 || value > 43))) continue;
      } else {
        const r = VITAL_RANGES[v.name];
        if (r && (value < r[0] || value > r[1])) continue;
      }
      out.push({ name: v.name, value, unit, span: [start, end] });
    }
  }
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

function extractLabs(text) {
  const out = [];
  for (const c of findAll(LAB_RE, text)) {
    const lab = labByAlias.get(norm(c.surface));
    const after = text.slice(c.end, c.end + 28);
    const m = after.match(/^\s*(?:level|value|of|is|was|:|=|-|–)*\s*(\d+(?:\.\d+)?)\s*(%|mg\/dl|g\/dl|g\/l|miu\/l|uiu\/ml|µiu\/ml|ng\/ml|pg\/ml|mg\/l|cells\/µl|\/cumm|\/µl)?/i);
    if (!m) continue;
    const value = Number(m[1]);
    // "HbA1c" values >20 or "Hb" >25 are almost certainly another number
    if (lab.test === 'HbA1c' && value > 20) continue;
    if (lab.test === 'haemoglobin' && (value < 3 || value > 25)) continue;
    let flag = null;
    if (lab.high != null && value > lab.high) flag = 'high';
    else if (lab.low != null && value < lab.low) flag = 'low';
    else flag = 'normal';
    out.push({ test: lab.test, value, unit: m[2] || lab.unit, flag, span: [c.start, c.end + m[0].length] });
  }
  for (const c of findAll(QUAL_RE, text)) {
    const q = qualByAlias.get(norm(c.surface));
    const after = text.slice(c.end, c.end + 25);
    const m = after.match(/^\s*(?:test|antigen|ag|igm|card|:|-|is|was)*\s*(positive|negative|\+ve|-ve|reactive|non-reactive|non reactive|detected|not detected)/i);
    if (!m) continue;
    const r = m[1].toLowerCase();
    const result = /neg|-ve|non|not/.test(r) ? 'negative' : 'positive';
    out.push({ test: q.test, value: result, unit: null, flag: result === 'positive' ? 'abnormal' : 'normal', span: [c.start, c.end + m[0].length] });
  }
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------
const FU_TRIGGER = '(?:review|r\\/v|rv|f\\/u|fu|follow[- ]?up|come back|revisit|recheck|re-check|see again|reassess|return|next visit)';

function extractFollowUp(text, visitDate) {
  const found = [];
  const relRe = new RegExp(`\\b${FU_TRIGGER}\\b[^.;\\n]{0,25}?\\b(?:in|after|within)?\\s*(\\d+|one|two|three|four|six|a)\\s*(days?|d|wks?|weeks?|w|months?|mths?|mo|m)\\b`, 'gi');
  const fracRe = new RegExp(`\\b${FU_TRIGGER}\\b\\s*(?:in|after)?\\s*(\\d+)\\s*\\/\\s*(7|52|12)\\b`, 'gi');
  const dateRe = new RegExp(`\\b${FU_TRIGGER}\\b[^.;\\n]{0,20}?\\b(?:on|by)\\s*(\\d{1,2})[\\/\\-.](\\d{1,2})(?:[\\/\\-.](\\d{2,4}))?`, 'gi');
  const sosRe = new RegExp(`\\b${FU_TRIGGER}\\b\\s*(?:only\\s*)?(?:sos|prn|if needed|as needed|if symptoms persist|if not better|if worse|if no improvement)`, 'gi');

  for (const { start, end, m } of findAll(relRe, text)) found.push({ start, end, inDays: toDays(m[1], m[2]) });
  for (const { start, end, m } of findAll(fracRe, text)) found.push({ start, end, inDays: fractionToDays(m[1], m[2]) });
  for (const { start, end, m } of findAll(dateRe, text)) {
    const vd = new Date(visitDate);
    let y = m[3] ? Number(m[3]) : vd.getUTCFullYear();
    if (y < 100) y += 2000;
    const due = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (Number.isNaN(due.getTime())) continue;
    if (!m[3] && due < vd) due.setUTCFullYear(due.getUTCFullYear() + 1);
    const vdDay = Date.UTC(vd.getUTCFullYear(), vd.getUTCMonth(), vd.getUTCDate());
    found.push({ start, end, inDays: Math.round((due - vdDay) / 864e5), dueISO: isoDate(due), explicitDate: true });
  }
  for (const { start, end } of findAll(sosRe, text)) found.push({ start, end, inDays: null, asNeeded: true });
  if (!found.length) return null;

  // the plan usually comes last; prefer a dated follow-up over an "SOS" one
  found.sort((a, b) => a.start - b.start);
  const dated = found.filter((f) => f.inDays != null && f.inDays > 0 && f.inDays <= 400);
  const pick = dated.length ? dated[dated.length - 1] : found[found.length - 1];

  // purpose: rest of the sentence, e.g. "with HbA1c", "for BP check"
  const rest = text.slice(pick.end).split(/[.;\n]/)[0];
  const pm = rest.match(/^\s*,?\s*((?:with|for|to|after|and)\b.{2,80})/i);
  const purpose = pm ? pm[1].trim() : null;
  const end = pm ? pick.end + rest.indexOf(pm[1]) + pm[1].length : pick.end;

  return {
    inDays: pick.inDays ?? null,
    dueDate: pick.dueISO ?? (pick.inDays ? isoDate(addDays(visitDate, pick.inDays)) : null),
    asNeeded: !!pick.asNeeded,
    purpose,
    span: [pick.start, end],
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
// Base confidence of a mention proposed only by one of the learned models.
const SOURCE_BASE = { ml: 0.72, llm: 0.62 };
// Words a learned model sometimes tags that are never a new concept.
const NOT_A_CONCEPT = new Set(['tab', 'tabs', 'tablet', 'cap', 'caps', 'capsule', 'syp', 'syrup', 'inj', 'injection', 'drops', 'cream', 'ointment', 'gel', 'inhaler', 'same', 'earlier', 'later', 'frequency', 'dose', 'doses', 'medicine', 'medicines', 'medication', 'drug', 'drugs', 'steroid', 'steroids', 'antibiotic', 'antibiotics', 'pain', 'poor control', 'control', 'review', 'advice', 'adv', 'continue', 'stop', 'start', 'thighs', 'legs', 'feet', 'hands', 'both', 'left', 'right', 'plan', 'treatment', 'tests', 'report', 'reports']);

/**
 * Combine mentions from the ML tagger and the LLM with the rule candidates.
 * Agreement raises confidence; mentions no lexicon concept matches are
 * returned separately for the doctor to map (and the system to learn).
 */
function mergeExtraCandidates(rulesCands, extra, measureSpans) {
  const cands = rulesCands.map((c) => ({ ...c, sources: [...(c.sources ?? ['rules'])] }));
  const unmapped = [];
  for (const x of extra) {
    if (measureSpans.some((m) => overlaps(m, x))) continue;
    const hit = cands.find((c) => overlaps(c, x));
    if (hit) {
      if (!hit.sources.includes(x.source)) hit.sources.push(x.source);
      continue;
    }
    const n = normaliseMention(x.type, x.surface);
    if (n) {
      cands.push({ type: n.type === 'diagnosis' && x.type === 'symptom' ? 'symptom' : n.type, start: x.start, end: x.end, surface: x.surface, entry: n.entry, confidence: Number((SOURCE_BASE[x.source] * (x.score ?? 1) * (n.score < 1 ? 0.95 : 1)).toFixed(2)), sources: [x.source], fuzzy: n.score < 1, fuzzyTo: n.score < 1 ? x.surface : undefined });
    } else {
      const key = x.surface.toLowerCase().replace(/\s+/g, ' ').trim();
      if (NOT_A_CONCEPT.has(key) || key.length < 4 || !/[a-z]{3}/.test(key)) continue;
      const prev = unmapped.find((u) => u.start === x.start && u.end === x.end);
      if (prev) { if (!prev.sources.includes(x.source)) prev.sources.push(x.source); }
      else unmapped.push({ type: x.type, surface: x.surface, start: x.start, end: x.end, span: [x.start, x.end], sources: [x.source], score: x.score ?? null });
    }
  }
  return { cands, unmapped };
}

/** Agreement-based confidence: each extra source that agrees adds certainty. */
function ensembleConfidence(base, sources) {
  const agree = sources.length - 1;
  return Math.min(0.99, Number((base + 0.04 * agree + (agree >= 2 ? 0.02 : 0)).toFixed(2)));
}

export const REVIEW_THRESHOLD = 0.85;

/** Decide which items a doctor should look at; the rest can be accepted as read. */
function triage(result) {
  const mark = (item, reasons) => {
    if (item.confidence < REVIEW_THRESHOLD) reasons.push('low confidence');
    item.check = reasons.length > 0;
    item.checkReasons = reasons;
  };
  for (const s of result.symptoms) mark(s, s.fuzzy ? ['possible typo'] : []);
  for (const d of result.diagnoses) {
    const r = [];
    if (d.fuzzy) r.push('possible typo');
    if (d.certainty === 'provisional') r.push('provisional diagnosis');
    mark(d, r);
  }
  for (const m of result.medications) {
    const r = [];
    if (m.flags.some((f) => f.startsWith('fuzzy_match'))) r.push('possible typo');
    if (m.flags.includes('no_dose') && ['start', 'prescribe', 'increase', 'decrease'].includes(m.action)) r.push('no dose');
    if (m.action === 'prescribe' && !m.frequency && m.form !== 'cream') r.push('no frequency');
    if (m.negated) r.push('read as not taken');
    if (m.action === 'mention') r.push('unclear whether taken, started or stopped');
    if (m.sources.length === 1 && m.sources[0] !== 'rules') r.push(`found only by ${m.sources[0] === 'ml' ? 'the ML tagger' : 'the LLM'}`);
    mark(m, r);
  }
  for (const s of [...result.symptoms, ...result.diagnoses]) {
    if (s.sources?.length === 1 && s.sources[0] !== 'rules') { s.checkReasons.push(`found only by ${s.sources[0] === 'ml' ? 'the ML tagger' : 'the LLM'}`); s.check = true; }
  }
  for (const v of [...result.vitals, ...result.labs]) { v.confidence = 0.95; v.check = false; v.checkReasons = []; }
  for (const a of result.allergies) { a.confidence = 0.9; a.check = true; a.checkReasons = ['allergy: always confirm']; }
  if (result.followUp) {
    result.followUp.confidence = result.followUp.dueDate || result.followUp.asNeeded ? 0.9 : 0.6;
    result.followUp.check = !result.followUp.dueDate && !result.followUp.asNeeded;
  }
}

export function extractNote(text, { visitDate = new Date(), extraCandidates = [], models = {} } = {}) {
  const note = String(text ?? '');
  const sentences = splitSentences(note);
  const warnings = [];

  const vitals = extractVitals(note);
  const labs = extractLabs(note);
  const measureSpans = [...vitals, ...labs].map((x) => ({ start: x.span[0], end: x.span[1] }));

  // labs like "TSH" or "Hb" must not be read as entities; drop overlapping entity candidates
  let cands = [...drugCandidates(note, sentences), ...conditionCandidates(note, sentences)]
    .filter((c) => !measureSpans.some((s) => overlaps(s, c) && (s.start <= c.start && s.end >= c.end)));
  cands = resolve(cands);
  cands = resolve([...cands, ...fuzzyCandidates(note, [...cands, ...measureSpans])]);
  const merged = mergeExtraCandidates(cands, extraCandidates, measureSpans);
  cands = resolve(merged.cands);
  for (const c of cands) c.confidence = ensembleConfidence(c.confidence, c.sources);

  const symptoms = []; const diagnoses = []; const medications = []; const allergies = [];
  const meds = cands.filter((c) => c.type === 'medication');

  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const sent = sentenceOf(sentences, c.start);
    if (c.type === 'medication') {
      const before = note.slice(sent.start, c.start);
      if (ALLERGY_RE.test(before) || /\ballerg(?:y|ic)\b[^.]*$/i.test(before) && !/\b(?:rx|start|tab|cap)\b/i.test(before.split(/allerg/i).pop())) {
        allergies.push({ substance: c.entry.generic, surface: c.surface, span: [c.start, c.end] });
        continue;
      }
      const idx = meds.indexOf(c);
      const prev = meds[idx - 1];
      const next = meds[idx + 1];
      const sameSentence = prev && prev.end > sent.start;
      c.prevEnd = sameSentence ? (prev.parsedEnd ?? prev.end) : sent.start;
      c.prevAction = sameSentence ? prev.parsedAction : null;
      const med = parseMedication(note, sent, c, next?.start);
      c.parsedEnd = med.span[1]; c.parsedAction = med.action;
      medications.push(med);
      continue;
    }
    const negated = isNegated(note, sent, c.start, c.end);
    if (c.type === 'symptom') {
      const durs = durationsIn(note, sent).filter((d) => d.start >= c.end);
      // a duration applies to every symptom listed before it in the clause ("fever, cough x 3 days")
      const dur = durs.find((d) => !cands.some((o) => o !== c && o.type !== 'symptom' && o.start > c.end && o.start < d.start)) ?? null;
      symptoms.push({
        term: c.entry.term,
        surface: c.surface,
        negated,
        durationDays: negated ? null : dur?.days ?? null,
        duration: negated ? null : dur?.label ?? null,
        confidence: c.confidence,
        fuzzy: !!c.fuzzy,
        sources: c.sources ?? ['rules'],
        span: [c.start, c.end],
      });
    } else {
      let certainty = certaintyFor(sent, c.start, c.end);
      if (negated) certainty = 'ruled_out';
      diagnoses.push({
        term: c.entry.term,
        code: c.entry.code,
        surface: c.surface,
        chronic: !!c.entry.chronic,
        certainty,
        context: contextFor(sent, c.start),
        confidence: Number((c.confidence * (certainty === 'provisional' ? 0.9 : 1)).toFixed(2)),
        fuzzy: !!c.fuzzy,
        sources: c.sources ?? ['rules'],
        span: [c.start, c.end],
      });
    }
  }

  // a drug listed without dose next to prescribed drugs is part of the prescription ("ORS, Tab Ondem 4 mg SOS")
  for (const m of medications) {
    if (m.action !== 'mention' || m.negated) continue;
    const sent = sentenceOf(sentences, m.span[0]);
    if (medications.some((o) => o !== m && o.action === 'prescribe' && o.span[0] >= sent.start && o.span[0] < sent.end)) m.action = 'prescribe';
  }

  // free-text allergies not in the drug lexicon, e.g. "allergic to sulfa drugs"
  const allergyRe = /\ballerg(?:y|ic|ies)\s*(?:to|:|-)\s*([A-Za-z][A-Za-z\- ]{2,30}?)(?=[.,;\n]|$| and )/gi;
  for (const { start, m } of findAll(allergyRe, note)) {
    const substance = m[1].trim().toLowerCase();
    if (allergies.some((a) => a.span[0] >= start && a.span[0] <= start + m[0].length)) continue;
    allergies.push({ substance, surface: m[1].trim(), span: [start + m[0].indexOf(m[1]), start + m[0].indexOf(m[1]) + m[1].trim().length] });
  }
  const nkda = NKDA_RE.test(note);

  const followUp = extractFollowUp(note, visitDate);

  // dedupe repeated mentions: keep the first span, merge attributes
  const dedupe = (arr, key) => {
    const seen = new Map();
    for (const x of arr) {
      const k = key(x);
      if (!seen.has(k)) seen.set(k, x);
    }
    return [...seen.values()];
  };

  const result = {
    symptoms: dedupe(symptoms, (s) => `${s.term}|${s.negated}`),
    diagnoses: dedupe(diagnoses, (d) => `${d.code}|${d.certainty}|${d.context}`),
    medications: dedupe(medications, (m) => `${m.generic}|${m.action}|${m.dose}`),
    allergies,
    nkda,
    vitals,
    labs,
    followUp,
    unmapped: merged.unmapped.filter((u) => !cands.some((c) => overlaps(c, u))).map(({ start, end, ...u }) => u),
  };
  triage(result);

  // review hints for the doctor
  for (const m of result.medications) {
    if (m.flags.includes('no_dose') && ['start', 'prescribe', 'increase', 'decrease'].includes(m.action)) warnings.push(`No dose found for ${m.generic}`);
    if (m.flags.some((f) => f.startsWith('fuzzy_match'))) warnings.push(`"${m.surface}" read as ${m.generic} (possible typo)`);
    if (m.action === 'prescribe' && !m.frequency) warnings.push(`No frequency found for ${m.generic}`);
  }
  for (const s of [...result.symptoms, ...result.diagnoses]) if (s.fuzzy) warnings.push(`"${s.surface}" read as ${s.term} (possible typo)`);
  if (!result.followUp) warnings.push('No follow-up instruction found');
  if (!result.diagnoses.some((d) => ['current', 'known'].includes(d.context) && d.certainty !== 'ruled_out')) warnings.push('No diagnosis found');

  for (const u of result.unmapped) warnings.push(`"${u.surface}" looks like a ${u.type} but is not in the vocabulary`);
  const items = [...result.symptoms, ...result.diagnoses, ...result.medications, ...result.labs, ...result.vitals, ...result.allergies];
  return {
    ...result,
    meta: {
      extractorVersion: EXTRACTOR_VERSION,
      sentenceCount: sentences.length,
      warnings,
      models: { rules: EXTRACTOR_VERSION, ...models },
      toCheck: items.filter((i) => i.check).length + result.unmapped.length + (result.followUp?.check ? 1 : 0),
      items: items.length,
      extractedAt: new Date().toISOString(),
    },
  };
}

/** Exact dictionary matches only (no fuzzy), used as features by the ML tagger. */
export function lexiconSpans(text) {
  const note = String(text ?? '');
  const sentences = splitSentences(note);
  return resolve([...drugCandidates(note, sentences), ...conditionCandidates(note, sentences)]).map((c) => ({ type: c.type, start: c.start, end: c.end }));
}

/** Flat list of highlighted entities for the UI. */
export function entitySpans(extraction) {
  const out = [];
  for (const s of extraction.symptoms ?? []) out.push({ type: s.negated ? 'negated' : 'symptom', label: s.term, span: s.span });
  for (const d of extraction.diagnoses ?? []) out.push({ type: d.certainty === 'ruled_out' ? 'negated' : 'diagnosis', label: `${d.term} (${d.code})`, span: d.span });
  for (const m of extraction.medications ?? []) out.push({ type: 'medication', label: m.generic, span: m.span });
  for (const u of extraction.unmapped ?? []) out.push({ type: 'unmapped', label: `${u.type}, not in vocabulary`, span: u.span });
  for (const v of extraction.vitals ?? []) out.push({ type: 'vital', label: v.name, span: v.span });
  for (const l of extraction.labs ?? []) out.push({ type: 'lab', label: l.test, span: l.span });
  for (const a of extraction.allergies ?? []) out.push({ type: 'allergy', label: a.substance, span: a.span });
  if (extraction.followUp?.span) out.push({ type: 'followup', label: 'follow-up', span: extraction.followUp.span });
  return out.filter((e) => Array.isArray(e.span)).sort((a, b) => a.span[0] - b.span[0]);
}

export { parseNumberWord };
