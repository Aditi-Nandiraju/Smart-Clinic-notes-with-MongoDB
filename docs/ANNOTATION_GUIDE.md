# Annotation guide for a real-world blind set

The project's numbers come from synthetic and hand-written notes. The next step that would make them credible is a small set of **real, de-identified OPD notes** annotated independently by two people, with their agreement measured before the system is scored on them. This guide and `server/scripts/agreement.js` are the tooling for that.

## 1. Before you start

- Only use notes that an ethics committee or the clinic has approved for this use. Remove names, phone numbers, addresses, ID numbers and exact dates of birth before anyone annotates, and replace them with placeholders (`[NAME]`, `[PHONE]`). Shift visit dates by a fixed random offset per patient.
- Aim for 100–200 notes from at least two doctors and a mix of acute and chronic visits.
- Two annotators (for example a final-year MBBS student and a pharmacist) work **independently**, without seeing each other's work or the system's output.

## 2. What to mark

Mark the shortest span of text that names the thing. Use character offsets (`start` inclusive, `end` exclusive).

| Type | Mark | Concept | Attribute |
|---|---|---|---|
| `symptom` | The complaint as written: "burning feet", "SOB", "loose stools" | Plain term (`breathlessness`, `diarrhoea`) | `negated`: true if denied ("No fever", "denies chest pain") |
| `diagnosis` | The diagnosis words: "T2DM", "AOM", "?dengue" | ICD-10 code (`E11`, `H66.9`) | `certainty`: `confirmed`, `provisional` (?, suspected, r/o), or `ruled_out` |
| `medication` | Only the drug or brand name: "Glycomet" in "Tab Glycomet 500 BD" | Generic name (`metformin`) | `action`: `start`, `prescribe`, `continue`, `increase`, `decrease`, `stop`, `history`, `mention` |

Rules of thumb:

- A symptom in the family history or a "watch for" instruction ("return if fever") is **not** a current symptom. Do not mark it.
- Mark each mention once per note. If "fever" appears twice, mark the first time it is stated as a complaint.
- If you are unsure whether something is a symptom or a diagnosis (e.g. "gastritis"), use what the doctor seems to mean: in the Dx/Imp line it is a diagnosis.
- If you cannot map a term to a concept, still mark it and put your best wording in `concept`, with `"unsure": true`. These are exactly the terms the system's vocabulary should learn.

## 3. File format

One JSON file per annotator. See `docs/annotation-example/` for two small example files built from the blind test notes.

```json
[
  { "id": "n1", "visitDate": "2026-10-01", "text": "C/o fever x 3d. No cough. Tab Dolo 650 TDS.",
    "items": [
      { "type": "symptom", "start": 4, "end": 9, "concept": "fever", "negated": false },
      { "type": "symptom", "start": 19, "end": 24, "concept": "cough", "negated": true },
      { "type": "medication", "start": 30, "end": 34, "concept": "paracetamol", "action": "prescribe" }
    ] }
]
```

## 4. Measure agreement, adjudicate, then score the system

```bash
cd server
# annotator vs annotator
node scripts/agreement.js annotator-a.json annotator-b.json
# after adjudication: the agreed file vs the system
node scripts/agreement.js adjudicated.json --system
```

The script reports span F1 (exact and overlapping) and concept agreement per type, Cohen's kappa for negation, certainty and action, and lists the disagreements to adjudicate. Span agreement is reported as F1 rather than kappa because there is no fixed set of "non-entity" spans to compute chance agreement over; this is the usual practice in clinical NER corpora (e.g. i2b2/n2c2).

Report the annotator–annotator agreement alongside the system's scores. If two people agree on 90% of symptom spans, a system score of 88% is close to the ceiling; without that number the system score cannot be interpreted.

## 5. Feeding results back

Terms annotators marked `unsure` or that the system missed can be added on the **Vocabulary** page (or mapped from the Review screen), and verified real notes are used by `POST /api/admin/retrain` to retrain the ML tagger. Keep the blind set itself out of training; otherwise it is no longer blind.
