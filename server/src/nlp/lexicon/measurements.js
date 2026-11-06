// Lab tests with aliases, units and adult reference ranges (used for flags only).
export const LABS = [
  { test: 'fasting blood sugar', unit: 'mg/dL', low: 70, high: 100, aliases: ['fasting blood sugar', 'fasting blood glucose', 'fasting sugar', 'fbs', 'fbg', 'fpg'] },
  { test: 'post-prandial blood sugar', unit: 'mg/dL', low: null, high: 140, aliases: ['post-prandial blood sugar', 'postprandial blood sugar', 'ppbs', 'ppbg', 'pp sugar', 'plbs'] },
  { test: 'random blood sugar', unit: 'mg/dL', low: 70, high: 140, aliases: ['random blood sugar', 'rbs', 'grbs', 'cbg'] },
  { test: 'HbA1c', unit: '%', low: null, high: 5.7, aliases: ['hba1c', 'a1c', 'glycated haemoglobin', 'glycated hemoglobin', 'glycosylated hb'] },
  { test: 'haemoglobin', unit: 'g/dL', low: 12, high: 17, aliases: ['haemoglobin', 'hemoglobin', 'hgb', 'hb'] },
  { test: 'TSH', unit: 'mIU/L', low: 0.4, high: 4.5, aliases: ['tsh', 's.tsh', 'serum tsh'] },
  { test: 'serum creatinine', unit: 'mg/dL', low: 0.6, high: 1.3, aliases: ['serum creatinine', 's.creatinine', 's. creatinine', 'sr creatinine', 'creatinine', 's.cr', 'creat'] },
  { test: 'LDL cholesterol', unit: 'mg/dL', low: null, high: 100, aliases: ['ldl cholesterol', 'ldl-c', 'ldl'] },
  { test: 'total cholesterol', unit: 'mg/dL', low: null, high: 200, aliases: ['total cholesterol', 'serum cholesterol', 't.chol', 'tc'] },
  { test: 'triglycerides', unit: 'mg/dL', low: null, high: 150, aliases: ['triglycerides', 'triglyceride', 'tgl', 'tg'] },
  { test: 'vitamin D', unit: 'ng/mL', low: 30, high: 100, aliases: ['25-oh vitamin d', '25-oh vit d', 'vitamin d3 level', 'vitamin d level', 'vit d level', 'vitamin d', 'vit d'] },
  { test: 'vitamin B12', unit: 'pg/mL', low: 200, high: 900, aliases: ['vitamin b12', 'vit b12', 'b12'] },
  { test: 'CRP', unit: 'mg/L', low: null, high: 5, aliases: ['c-reactive protein', 'crp'] },
  { test: 'total leucocyte count', unit: 'cells/µL', low: 4000, high: 11000, aliases: ['total leucocyte count', 'total leukocyte count', 'tlc', 'wbc count', 'wbc'] },
  { test: 'serum uric acid', unit: 'mg/dL', low: null, high: 7, aliases: ['serum uric acid', 'uric acid', 's.uric acid'] },
];

// Tests usually reported as positive/negative.
export const QUALITATIVE_TESTS = [
  { test: 'dengue NS1 antigen', aliases: ['dengue ns1', 'ns1 antigen', 'ns1'] },
  { test: 'dengue IgM', aliases: ['dengue igm'] },
  { test: 'Widal test', aliases: ['widal test', 'widal'] },
  { test: 'malaria antigen', aliases: ['malaria antigen', 'mp card', 'malarial parasite', 'mp'] },
  { test: 'urine culture', aliases: ['urine culture', 'urine c/s'] },
  { test: 'COVID-19 RT-PCR', aliases: ['covid rt-pcr', 'covid-19 rt-pcr', 'rt-pcr', 'covid rat', 'covid'] },
  { test: 'urine pregnancy test', aliases: ['urine pregnancy test', 'upt'] },
];

export const VITALS = [
  { name: 'blood pressure', unit: 'mmHg', re: /\b(?:bp|blood pressure)\s*(?:[:=-]|was|is|of)?\s*(\d{2,3})\s*\/\s*(\d{2,3})(?:\s*mm\s*hg)?/gi, two: true },
  { name: 'pulse', unit: 'bpm', re: /\b(?:pr|hr|pulse(?: rate)?|heart rate)\s*(?:[:=-]|of)?\s*(\d{2,3})(?:\s*(?:\/\s*min|bpm|per min|b\/m))?/gi },
  { name: 'temperature', unit: null, re: /\b(?:temp(?:erature)?)\s*(?:[:=-]|of)?\s*(\d{2,3}(?:\.\d{1,2})?)\s*°?\s*([fc])?\b/gi },
  { name: 'temperature', unit: null, re: /(?<![\w.])(\d{2,3}(?:\.\d{1,2})?)\s*°\s*([fc])\b/gi },
  { name: 'SpO2', unit: '%', re: /\b(?:spo2|sp02|o2 sat(?:uration)?|sats?)\s*(?:[:=-]|of)?\s*(\d{2,3})\s*%?/gi },
  { name: 'respiratory rate', unit: 'breaths/min', re: /\b(?:rr|resp(?:iratory)? rate)\s*(?:[:=-]|of)?\s*(\d{1,2})(?:\s*\/\s*min)?\b/gi },
  { name: 'weight', unit: 'kg', re: /\b(?:wt|weight|body weight)\s*(?:[:=-]|of)?\s*(\d{2,3}(?:\.\d)?)\s*(?:kg|kgs)?\b/gi },
  { name: 'BMI', unit: 'kg/m²', re: /\bbmi\s*(?:[:=-]|of)?\s*(\d{2}(?:\.\d{1,2})?)/gi },
];

export const VITAL_RANGES = {
  'pulse': [40, 220],
  'SpO2': [50, 100],
  'respiratory rate': [6, 60],
  'weight': [2, 300],
  'BMI': [10, 70],
};
