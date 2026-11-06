// LLM-assisted mention finding with a hard grounding rule.
//
// The local LLM (via Ollama) only proposes WHERE symptoms, diagnoses and
// medicines are mentioned. Every proposal must quote text that appears
// verbatim in the note; anything that cannot be found in the note is
// discarded and counted as a hallucination. Attributes (negation, dose,
// frequency, dates) are still read by the deterministic rules, so the
// LLM cannot change a dose or invent a follow-up date.
import { chatJSON } from './ollama.js';

const SCHEMA = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['symptom', 'diagnosis', 'medication'] },
          text: { type: 'string', description: 'the exact words from the note, copied character for character' },
        },
        required: ['type', 'text'],
      },
    },
  },
  required: ['mentions'],
};

const SYSTEM = `You read outpatient consultation notes written by Indian doctors in clinical shorthand.
List every mention of a symptom, a diagnosis, and a medicine (generic or brand name).
Rules:
- Copy the exact words from the note for each mention. Do not paraphrase, expand abbreviations or correct spelling.
- Include symptoms even when they are negated ("No fever" -> "fever").
- For medicines, copy only the drug or brand name, not the dose or frequency ("Tab Glycomet 500 BD" -> "Glycomet").
- Do not include lab tests, vital signs or follow-up instructions.
- If there are none of a kind, leave them out. Never add anything that is not written in the note.`;

const FEW_SHOT = 'Example note: "C/o fever and dry cough x 3 days. No SOB. Dx: URTI. Rx: Tab Dolo 650 TDS."\nExample answer: {"mentions":[{"type":"symptom","text":"fever"},{"type":"symptom","text":"dry cough"},{"type":"symptom","text":"SOB"},{"type":"diagnosis","text":"URTI"},{"type":"medication","text":"Dolo"}]}';

/** Find each quoted mention in the note (case-insensitive), left to right. */
export function ground(note, mentions) {
  const lower = note.toLowerCase();
  const used = [];
  const grounded = []; const rejected = [];
  for (const m of mentions ?? []) {
    const q = String(m.text ?? '').trim();
    if (q.length < 2 || q.length > 60) { rejected.push(m); continue; }
    let from = 0; let idx = -1;
    while ((idx = lower.indexOf(q.toLowerCase(), from)) !== -1) {
      const end = idx + q.length;
      const boundaryOk = !/[a-z0-9]/i.test(note[idx - 1] ?? ' ') && !/[a-z0-9]/i.test(note[end] ?? ' ');
      if (boundaryOk && !used.some(([s, e]) => idx < e && s < end)) break;
      from = idx + 1;
    }
    if (idx === -1) { rejected.push(m); continue; }
    used.push([idx, idx + q.length]);
    grounded.push({ type: m.type, start: idx, end: idx + q.length, surface: note.slice(idx, idx + q.length), source: 'llm', score: 1 });
  }
  return { grounded, rejected };
}

export async function llmCandidates(note) {
  const t0 = Date.now();
  const { data, model } = await chatJSON({ system: SYSTEM, user: `${FEW_SHOT}\n\nNote:\n"""${note}"""`, schema: SCHEMA });
  const { grounded, rejected } = ground(note, data.mentions);
  return { candidates: grounded, rejected: rejected.map((r) => r.text), model, ms: Date.now() - t0 };
}
