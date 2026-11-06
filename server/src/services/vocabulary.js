// Learning vocabulary from doctors' corrections.
//
// When a doctor marks text in a note and maps it to a concept (for example
// "Glyree" -> metformin), the alias is stored and the extractor's lexicon is
// rebuilt, so the next note that says "Glyree" is read correctly.
import { DRUGS } from '../nlp/lexicon/drugs.js';
import { Vocabulary } from '../models/index.js';
import { setCustomLexicon, knownAlias } from '../nlp/extractor.js';

export async function loadVocabulary() {
  const rows = await Vocabulary.find({ status: 'active' }).lean();
  return setCustomLexicon(rows);
}

/** Items the doctor marked in the text (learn: true) become new aliases. */
export async function learnFromVerification(enc, verified, user) {
  const learned = [];
  const note = enc.rawNote;
  const take = (type, item, concept) => {
    const sp = item.nameSpan ?? item.span;
    if (!item.learn || !Array.isArray(sp)) return;
    const alias = note.slice(sp[0], sp[1]).toLowerCase().replace(/^(?:tab|cap|syp|inj|t)\.?\s+/, '').replace(/\s+/g, ' ').trim();
    if (alias.length < 2 || alias.length > 60 || /^\d+$/.test(alias)) return;
    if (knownAlias(type === 'drug' ? 'medication' : type, alias)) return;
    learned.push({ type, alias, concept });
  };
  for (const m of verified.medications ?? []) take('drug', m, { generic: m.generic, cls: m.drugClass ?? DRUGS.find((d) => d.generic === m.generic)?.cls ?? null, unit: m.unit ?? 'mg' });
  for (const s of verified.symptoms ?? []) take('symptom', s, { term: s.term });
  for (const d of verified.diagnoses ?? []) take('diagnosis', d, { term: d.term, code: d.code });
  for (const l of learned) {
    await Vocabulary.updateOne(
      { type: l.type, alias: l.alias },
      { $setOnInsert: { concept: l.concept, status: 'active', source: 'correction', learnedFrom: enc._id, createdBy: user?._id }, $inc: { uses: 1 } },
      { upsert: true },
    );
  }
  if (learned.length) await loadVocabulary();
  return learned;
}
