// A stand-in for Ollama, for automated tests and demos on machines without it.
// It implements the same HTTP API (/api/tags, /api/chat with `format`,
// /api/embed) but answers with simple heuristics instead of a real model.
// It deliberately adds one mention that is NOT in the note, so the grounding
// check can be tested. Do not use it to measure LLM quality.
//
//   node scripts/mockOllama.js [port]      (default 11434)
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.MOCK_OLLAMA_PORT || 11434);
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

function extractMentions(note) {
  const mentions = [];
  const push = (type, text) => { if (text && !mentions.some((m) => m.text.toLowerCase() === text.toLowerCase())) mentions.push({ type, text }); };
  for (const m of note.matchAll(/\b(?:Tab|Cap|Syp|Inj|T)\.?\s+([A-Z][A-Za-z-]+)/g)) push('medication', m[1]);
  for (const m of note.matchAll(/\b(?:c\/o|complains of|presents with)\s+([a-z][a-z ]+?)(?:\s+(?:and|x|for|since)\b|[,.])/gi)) push('symptom', m[1].trim());
  for (const m of note.matchAll(/\b(?:Dx|Imp|Diagnosis)\s*[:-]\s*\??([A-Za-z][A-Za-z0-9 ]+?)(?=[.,;\n]|$)/g)) push('diagnosis', m[1].trim());
  for (const m of note.matchAll(/\bNo\s+([a-z]+)/gi)) push('symptom', m[1]);
  push('symptom', 'chest pain radiating to jaw'); // a deliberate hallucination: not in the note
  return mentions;
}

function parseQuestion(q) {
  const s = q.toLowerCase();
  const intent = /miss|overdue|did not come|didn't come/.test(s) ? 'overdue_followups'
    : /due|coming|expected/.test(s) ? 'upcoming_followups'
      : /most|top|common/.test(s) && /drug|medic|prescri/.test(s) ? 'top_medications'
        : /most|top|common/.test(s) ? 'top_diagnoses'
          : /hba1c|sugar|tsh|haemoglobin|creatinine|ldl/.test(s) ? 'lab_threshold'
            : /taking|on |prescribed|medicine|tablet/.test(s) ? 'patients_on_drug'
              : /blood group|ward|bill|insurance|weather|salary|bed/.test(s) ? 'unanswerable'
                : 'note_search';
  const time = s.match(/\b(this|last|next) (week|month|quarter|year)\b|\btoday\b|\byesterday\b/);
  const drug = s.match(/\b(metformin|telmisartan|amlodipine|glycomet|telma|atorvastatin|insulin|levothyroxine|sugar tablet)\b/);
  return { intent, drugs: drug ? [drug[1]] : [], diagnoses: /diabet/.test(s) ? ['diabetes'] : /pressure|hypertens/.test(s) ? ['hypertension'] : [], symptoms: [], lab_test: null, comparator: null, value: null, time_phrase: time ? time[0] : null, patient_name: null, limit: null, wants_count: /how many|count/.test(s) };
}

function respond(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/tags') return respond(res, { models: [{ name: MODEL }, { name: 'nomic-embed-text:latest' }] });
    if (req.url === '/api/embed') {
      const { input } = JSON.parse(body || '{}');
      const list = Array.isArray(input) ? input : [input];
      return respond(res, { model: 'nomic-embed-text', embeddings: list.map((t) => Array.from({ length: 64 }, (_, i) => Math.sin((t.length + 1) * (i + 1)))) });
    }
    if (req.url === '/api/chat') {
      const { messages } = JSON.parse(body || '{}');
      const system = messages?.[0]?.content ?? '';
      const user = messages?.[messages.length - 1]?.content ?? '';
      let content;
      if (/List every mention/.test(system)) {
        const note = (user.match(/Note:\n"""([\s\S]*)"""/) ?? [])[1] ?? '';
        content = { mentions: extractMentions(note) };
      } else if (/Convert the question/.test(system)) {
        const q = (user.match(/Question:\s*([\s\S]*)$/) ?? [])[1] ?? user;
        content = parseQuestion(q.trim());
      } else if (/numbered notes/.test(system)) {
        const n = (user.match(/^\[(\d+)\]/gm) ?? []).length;
        content = { answer: n ? `The closest matching notes describe this in ${Math.min(n, 2)} patient(s) [1]${n > 1 ? '[2]' : ''}.` : 'None of the notes describe this.' };
      } else {
        content = {};
      }
      return respond(res, { model: MODEL, message: { role: 'assistant', content: JSON.stringify(content) }, done: true, total_duration: 2.5e8 });
    }
    res.writeHead(404); res.end('not found');
  });
}).listen(PORT, () => console.log(`[mock-ollama] listening on http://127.0.0.1:${PORT} (heuristic stand-in, not a real model)`));
