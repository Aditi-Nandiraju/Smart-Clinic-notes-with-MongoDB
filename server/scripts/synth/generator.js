// Synthetic patient and note generator.
//
// Simulates a population of fictional outpatients (Indian setting) with chronic
// conditions, medication regimens that change over time, acute illnesses and
// follow-up behaviour (some patients miss reviews). Each consultation note is
// written in realistic clinical shorthand with varied abbreviations, brand
// names, dose formats and occasional typos, and the generator records the true
// structured facts behind every note. Those facts are the ground truth used to
// measure the extractor. No real patient data is involved.

import { DRUGS } from '../../src/nlp/lexicon/drugs.js';

// ---------------------------------------------------------------------------
// deterministic random numbers
// ---------------------------------------------------------------------------
export function rng(seed = 7) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle: (arr) => { const a2 = [...arr]; for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    sample: (arr, k) => r.shuffle(arr).slice(0, k),
    round: (x, d = 0) => Number(x.toFixed(d)),
    normal: (mu, sd) => { const u = 1 - next(); const v = next(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
  };
  return r;
}

const drugIndex = new Map(DRUGS.map((d) => [d.generic, d]));

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------
const FIRST_M = ['Ravi', 'Anil', 'Suresh', 'Rahul', 'Arjun', 'Deepak', 'Mohammed', 'Vikram', 'Sanjay', 'Rajesh', 'Karthik', 'Imran', 'Manoj', 'Prakash', 'Harish', 'Venkat', 'Naveen', 'Amit', 'Rohit', 'Sameer', 'Farhan', 'Gopal', 'Kiran', 'Nikhil', 'Pranav', 'Siddharth', 'Varun', 'Yusuf', 'Abhishek', 'Ganesh', 'Joseph', 'Mahesh', 'Ramesh', 'Srinivas', 'Tarun', 'Vinod', 'Ashok', 'Balaji', 'Dinesh', 'Hari'];
const FIRST_F = ['Priya', 'Sunita', 'Lakshmi', 'Kavya', 'Anjali', 'Meena', 'Divya', 'Fatima', 'Pooja', 'Neha', 'Revathi', 'Shalini', 'Swati', 'Aisha', 'Bhavana', 'Deepa', 'Geeta', 'Hema', 'Jyoti', 'Kamala', 'Lata', 'Madhuri', 'Nandini', 'Padma', 'Radha', 'Sarita', 'Usha', 'Vani', 'Zara', 'Asha', 'Chitra', 'Gayathri', 'Ishita', 'Mary', 'Nisha', 'Rekha', 'Shreya', 'Tanvi', 'Uma', 'Yamini'];
const LAST = ['Kumar', 'Sharma', 'Mehta', 'Reddy', 'Khan', 'Iyer', 'Nair', 'Verma', 'Rao', 'Joshi', 'Pillai', 'Gupta', 'Patel', 'Menon', 'Das', 'Singh', 'Naidu', 'Chopra', 'Bose', 'Kulkarni', 'Desai', 'Shetty', 'Banerjee', 'Fernandes', 'Hegde', 'Jain', 'Kapoor', 'Mishra', 'Pandey', 'Qureshi', 'Saxena', 'Thomas', 'Varghese', 'Yadav', 'Agarwal', 'Chatterjee', 'Gowda', 'Krishnan', 'Murthy', 'Sinha'];

// ---------------------------------------------------------------------------
// surface-form helpers: the same fact written many ways
// ---------------------------------------------------------------------------
const FREQ_STYLES = {
  'once daily': ['OD', 'OD', 'once daily', '1-0-0'],
  'twice daily': ['BD', 'BD', 'twice daily', '1-0-1', 'BID'],
  'three times daily': ['TDS', 'TDS', 'thrice daily', '1-1-1', 'TID'],
  'at bedtime': ['HS', 'HS', 'at bedtime', '0-0-1'],
  'as needed': ['SOS', 'SOS', 'PRN', 'as needed'],
};

function brandOrGeneric(r, generic) {
  const d = drugIndex.get(generic);
  // the first alias is the generic name; later ones are brands/abbreviations
  const brands = d.aliases.filter((a) => a !== generic && a.length > 3 && !['acetaminophen', 'albuterol'].includes(a));
  const surface = r.chance(0.55) || !brands.length ? generic : r.pick(brands);
  return r.chance(0.5) ? surface[0].toUpperCase() + surface.slice(1) : surface;
}

function typo(r, word) {
  if (word.length < 7) return word;
  const i = r.int(2, word.length - 3);
  const kind = r.int(0, 2);
  if (kind === 0) return word.slice(0, i) + word[i] + word.slice(i); // doubled letter
  if (kind === 1) return word.slice(0, i) + word.slice(i + 1); // dropped letter
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2); // swap
}

function doseText(r, dose, unit) {
  if (dose == null) return '';
  const u = unit === 'units' ? 'units' : unit;
  if (unit === 'mg' && r.chance(0.25)) return `${dose}`; // unit left implicit, as doctors often do
  return r.chance(0.3) && unit !== 'units' ? `${dose}${u}` : `${dose} ${u}`;
}

function durationText(r, days) {
  if (days % 7 === 0 && days >= 7 && r.chance(0.5)) {
    const w = days / 7;
    return r.pick([`x ${w} wks`, `for ${w} week${w > 1 ? 's' : ''}`, `x ${w}/52`]);
  }
  return r.pick([`x ${days} days`, `for ${days} days`, `x ${days}/7`, `x ${days}d`]);
}

function medLine(r, m) {
  const after = ['inhaler', 'cream', 'sachet'].includes(m.form);
  const name = m.typo ? typo(r, brandOrGeneric(r, m.generic)) : brandOrGeneric(r, m.generic);
  const parts = [after || !m.form ? name : `${m.form} ${name}`];
  if (after) parts.push(m.form);
  if (m.dose != null) parts.push(doseText(r, m.dose, m.unit));
  if (m.frequency) parts.push(r.pick(FREQ_STYLES[m.frequency] ?? [m.frequency]));
  if (m.durationDays) parts.push(durationText(r, m.durationDays));
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// clinical content
// ---------------------------------------------------------------------------
const CHRONIC = {
  E11: { term: 'type 2 diabetes mellitus', aliases: ['T2DM', 'type 2 diabetes', 'DM2', 'diabetes mellitus', 'T2DM'], prevalence: (age) => (age > 35 ? 0.28 : 0.05) },
  I10: { term: 'hypertension', aliases: ['HTN', 'hypertension', 'HTN', 'essential hypertension'], prevalence: (age) => (age > 40 ? 0.33 : 0.06) },
  'E03.9': { term: 'hypothyroidism', aliases: ['hypothyroidism', 'hypothyroid'], prevalence: (age, sex) => (sex === 'F' ? 0.12 : 0.03) },
  'E78.5': { term: 'dyslipidemia', aliases: ['dyslipidemia', 'dyslipidaemia', 'hyperlipidemia'], prevalence: (age) => (age > 35 ? 0.16 : 0.04) },
  'J45.9': { term: 'bronchial asthma', aliases: ['bronchial asthma', 'asthma'], prevalence: () => 0.06 },
  'M17.9': { term: 'osteoarthritis of knee', aliases: ['OA knee', 'osteoarthritis knee', 'knee OA'], prevalence: (age) => (age > 50 ? 0.14 : 0.01) },
};

const ACUTE = [
  { code: 'J06.9', dx: ['URTI', 'upper respiratory tract infection', 'common cold'], sx: [['fever', 0.6], ['cough', 0.8], ['runny nose', 0.7], ['sore throat', 0.5], ['sneezing', 0.3]], neg: ['breathlessness', 'chest pain'], meds: [{ generic: 'paracetamol', dose: 650, unit: 'mg', frequency: 'three times daily', durationDays: 3, form: 'Tab' }, { generic: 'levocetirizine', dose: 5, unit: 'mg', frequency: 'at bedtime', durationDays: 5, form: 'Tab' }], days: [2, 5], fu: 'sos', season: null, weight: 9 },
  { code: 'J02.9', dx: ['acute pharyngitis', 'pharyngitis'], sx: [['sore throat', 1], ['fever', 0.6], ['painful swallowing', 0], ['body ache', 0.3]], neg: ['cough'], meds: [{ generic: 'azithromycin', dose: 500, unit: 'mg', frequency: 'once daily', durationDays: 3, form: 'Tab' }, { generic: 'paracetamol', dose: 650, unit: 'mg', frequency: 'as needed', durationDays: null, form: 'Tab' }], days: [2, 4], fu: 5, weight: 5 },
  { code: 'B34.9', dx: ['viral fever', 'viral illness'], sx: [['fever', 1], ['body ache', 0.8], ['headache', 0.5], ['fatigue', 0.4]], neg: ['vomiting', 'rash'], meds: [{ generic: 'paracetamol', dose: 650, unit: 'mg', frequency: 'three times daily', durationDays: 3, form: 'Tab' }], days: [1, 4], fu: 3, labs: [['dengue NS1 antigen', 'negative', 0.4]], weight: 7 },
  { code: 'A90', dx: ['dengue', 'dengue fever'], provisional: 0.7, sx: [['fever', 1], ['body ache', 0.9], ['headache', 0.7], ['vomiting', 0.4], ['rash', 0.3]], neg: ['bleeding'], meds: [{ generic: 'paracetamol', dose: 650, unit: 'mg', frequency: 'three times daily', durationDays: 3, form: 'Tab' }, { generic: 'oral rehydration salts', dose: null, unit: null, frequency: null, durationDays: null, form: null }], days: [2, 5], fu: 2, season: [7, 8, 9, 10], labs: [['dengue NS1 antigen', 'positive', 0.5]], weight: 3 },
  { code: 'A09', dx: ['acute gastroenteritis', 'gastroenteritis', 'AGE'], sx: [['loose stools', 1], ['vomiting', 0.6], ['abdominal pain', 0.5], ['fever', 0.3]], neg: ['blood in stools'], meds: [{ generic: 'oral rehydration salts', dose: null, unit: null, frequency: null, durationDays: null, form: null }, { generic: 'ondansetron', dose: 4, unit: 'mg', frequency: 'as needed', durationDays: null, form: 'Tab' }, { generic: 'metronidazole', dose: 400, unit: 'mg', frequency: 'three times daily', durationDays: 5, form: 'Tab' }], days: [1, 3], fu: 'sos', weight: 5 },
  { code: 'N39.0', dx: ['UTI', 'urinary tract infection'], sex: 'F', sx: [['burning micturition', 1], ['urinary frequency', 0.6], ['fever', 0.3], ['abdominal pain', 0.3]], neg: ['vomiting', 'back pain'], meds: [{ generic: 'nitrofurantoin', dose: 100, unit: 'mg', frequency: 'twice daily', durationDays: 5, form: 'Tab' }], days: [1, 4], fu: 7, weight: 4 },
  { code: 'G43.9', dx: ['migraine'], sx: [['headache', 1], ['nausea', 0.6], ['dizziness', 0.2]], neg: ['fever', 'vomiting'], meds: [{ generic: 'naproxen' }], days: [1, 2], fu: 14, weight: 2, medsAlt: [{ generic: 'sumatriptan', dose: 50, unit: 'mg', frequency: 'as needed', durationDays: null, form: 'Tab' }, { generic: 'propranolol', dose: 20, unit: 'mg', frequency: 'twice daily', durationDays: null, form: 'Tab' }] },
  { code: 'M54.5', dx: ['low back pain', 'mechanical low back pain'], sx: [['back pain', 1]], neg: ['numbness', 'fever'], meds: [{ generic: 'aceclofenac', dose: 100, unit: 'mg', frequency: 'twice daily', durationDays: 5, form: 'Tab' }, { generic: 'pantoprazole', dose: 40, unit: 'mg', frequency: 'once daily', durationDays: 5, form: 'Tab' }], days: [3, 14], fu: 14, weight: 3 },
  { code: 'J30.4', dx: ['allergic rhinitis'], sx: [['sneezing', 1], ['runny nose', 0.9], ['nasal congestion', 0.5], ['itching', 0.3]], neg: ['fever'], meds: [{ generic: 'montelukast', dose: 10, unit: 'mg', frequency: 'at bedtime', durationDays: 14, form: 'Tab' }, { generic: 'fexofenadine', dose: 120, unit: 'mg', frequency: 'once daily', durationDays: 7, form: 'Tab' }], days: [7, 30], fu: 'sos', weight: 3 },
  { code: 'K21.9', dx: ['GERD', 'acid peptic disease'], sx: [['heartburn', 1], ['abdominal pain', 0.5], ['nausea', 0.3]], neg: ['vomiting', 'weight loss'], meds: [{ generic: 'pantoprazole', dose: 40, unit: 'mg', frequency: 'once daily', durationDays: 14, form: 'Tab' }, { generic: 'domperidone', dose: 10, unit: 'mg', frequency: 'twice daily', durationDays: 7, form: 'Tab' }], days: [7, 30], fu: 14, weight: 4 },
  { code: 'B35.4', dx: ['tinea corporis', 'fungal infection'], sx: [['itching', 1], ['rash', 1]], neg: ['fever'], meds: [{ generic: 'terbinafine', dose: 250, unit: 'mg', frequency: 'once daily', durationDays: 14, form: 'Tab' }, { generic: 'clotrimazole', dose: null, unit: null, frequency: 'twice daily', durationDays: 14, form: 'cream' }], days: [7, 30], fu: 14, weight: 3 },
  { code: 'H10.9', dx: ['conjunctivitis'], sx: [['red eye', 1], ['itching', 0.4]], neg: ['blurred vision', 'fever'], meds: [], days: [1, 3], fu: 5, weight: 2 },
  { code: 'J22', dx: ['LRTI', 'lower respiratory tract infection', 'chest infection'], sx: [['cough', 1], ['fever', 0.8], ['breathlessness', 0.4], ['chest pain', 0.2]], neg: [], meds: [{ generic: 'amoxicillin-clavulanate', dose: 625, unit: 'mg', frequency: 'twice daily', durationDays: 5, form: 'Tab' }, { generic: 'paracetamol', dose: 650, unit: 'mg', frequency: 'as needed', durationDays: null, form: 'Tab' }], days: [3, 7], fu: 5, labs: [['total leucocyte count', () => 9000 + Math.round(Math.random() * 6000), 0.4]], weight: 3 },
  { code: 'D50.9', dx: ['iron deficiency anaemia', 'anaemia', 'IDA'], sex: 'F', sx: [['fatigue', 1], ['dizziness', 0.5], ['breathlessness', 0.2], ['hair fall', 0.3]], neg: ['bleeding'], meds: [{ generic: 'ferrous sulfate', dose: 200, unit: 'mg', frequency: 'once daily', durationDays: 90, form: 'Tab' }, { generic: 'folic acid', dose: 5, unit: 'mg', frequency: 'once daily', durationDays: 90, form: 'Tab' }], days: [14, 60], fu: 30, labs: [['haemoglobin', 'low', 1]], weight: 3 },
  { code: 'G47.0', dx: ['insomnia'], sx: [['poor sleep', 1], ['anxiety', 0.5], ['fatigue', 0.4]], neg: ['low mood'], meds: [{ generic: 'clonazepam', dose: 0.25, unit: 'mg', frequency: 'at bedtime', durationDays: 14, form: 'Tab' }], days: [14, 60], fu: 14, weight: 1 },
  { code: 'E55.9', dx: ['vitamin D deficiency', 'vit D deficiency'], sx: [['body ache', 0.8], ['fatigue', 0.8], ['joint pain', 0.4]], neg: [], meds: [{ generic: 'cholecalciferol', dose: 60000, unit: 'IU', frequency: 'once weekly', durationDays: 56, form: 'sachet' }], days: [30, 90], fu: 56, labs: [['vitamin D', 'low', 1]], weight: 2 },
];

const SYMPTOM_SURFACES = {
  'fever': ['fever', 'fever', 'fever'], 'cough': ['cough', 'dry cough', 'cough'], 'runny nose': ['running nose', 'runny nose', 'rhinorrhoea'],
  'sore throat': ['sore throat', 'throat pain'], 'sneezing': ['sneezing'], 'body ache': ['body ache', 'myalgia', 'body aches'],
  'headache': ['headache', 'headache'], 'fatigue': ['fatigue', 'tiredness', 'weakness'], 'vomiting': ['vomiting', 'vomiting'],
  'rash': ['rash', 'skin rash'], 'loose stools': ['loose stools', 'loose motions', 'diarrhoea'], 'abdominal pain': ['abdominal pain', 'pain abdomen'],
  'burning micturition': ['burning micturition', 'dysuria'], 'urinary frequency': ['increased frequency of micturition', 'urinary frequency'],
  'nausea': ['nausea'], 'dizziness': ['giddiness', 'dizziness'], 'back pain': ['back pain', 'backache'],
  'nasal congestion': ['nasal congestion', 'blocked nose'], 'itching': ['itching', 'pruritus'], 'heartburn': ['heartburn', 'acidity', 'retrosternal burning'],
  'red eye': ['red eye', 'redness of eye'], 'breathlessness': ['breathlessness', 'SOB', 'shortness of breath'], 'chest pain': ['chest pain'],
  'poor sleep': ['poor sleep', 'difficulty sleeping'], 'anxiety': ['anxiety'], 'joint pain': ['joint pains', 'joint pain'], 'hair fall': ['hair fall'],
  'polyuria': ['polyuria', 'increased urination'], 'polydipsia': ['polydipsia', 'excessive thirst'], 'tingling': ['tingling', 'numbness'],
  'knee pain': ['knee pain', 'b/l knee pain'], 'wheezing': ['wheeze', 'wheezing'], 'pedal oedema': ['pedal oedema', 'swelling of feet'],
  'low mood': ['low mood'], 'weight loss': ['weight loss'], 'painful swallowing': ['painful swallowing'], 'numbness': ['numbness'],
  'bleeding': [null], 'blood in stools': [null], 'blurred vision': ['blurred vision'],
};
// map generator symptom names to lexicon terms (the extractor's vocabulary)
const SX_TERM = { 'loose stools': 'diarrhoea', 'burning micturition': 'dysuria', 'joint pains': 'joint pain', 'painful swallowing': 'sore throat', 'numbness': 'tingling', 'hair fall': 'hair loss', 'polydipsia': 'polydipsia' };
const sxTerm = (s) => SX_TERM[s] ?? s;

const LAB_GEN = {
  'fasting blood sugar': { aliases: ['FBS', 'FBS', 'fasting blood sugar'], unit: 'mg/dL' },
  'post-prandial blood sugar': { aliases: ['PPBS', 'PPBS', 'post-prandial blood sugar'], unit: 'mg/dL' },
  HbA1c: { aliases: ['HbA1c', 'HbA1c'], unit: '%' },
  TSH: { aliases: ['TSH', 'S.TSH'], unit: 'mIU/L' },
  'LDL cholesterol': { aliases: ['LDL', 'LDL'], unit: 'mg/dL' },
  haemoglobin: { aliases: ['Hb', 'Hb', 'haemoglobin'], unit: 'g/dL' },
  'serum creatinine': { aliases: ['S.creatinine', 'creatinine'], unit: 'mg/dL' },
  'vitamin D': { aliases: ['vit D level', 'vitamin D'], unit: 'ng/mL' },
  'total leucocyte count': { aliases: ['TLC'], unit: '' },
  'dengue NS1 antigen': { aliases: ['NS1', 'dengue NS1'], qualitative: true },
};

function labText(r, test, value) {
  const g = LAB_GEN[test];
  const alias = r.pick(g.aliases);
  if (g.qualitative) return `${alias} ${value === 'positive' ? r.pick(['positive', '+ve']) : r.pick(['negative', '-ve'])}`;
  const unit = g.unit && r.chance(0.5) ? ` ${g.unit}` : '';
  return `${alias} ${value}${unit}`;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const dmy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

function followUpText(r, days, purpose, visitDate) {
  if (days === 'sos') return { text: r.pick(['Review SOS.', 'Review if symptoms persist.', 'F/u SOS.', 'Review if not better.']), gt: { dueDate: null, asNeeded: true } };
  const due = addDays(visitDate, days);
  let phrase;
  if (r.chance(0.12)) phrase = `Review on ${dmy(due)}`;
  else if (days % 30 === 0 && days >= 30) phrase = r.pick([`Review after ${days / 30} month${days > 30 ? 's' : ''}`, `F/u in ${days / 30} month${days > 30 ? 's' : ''}`]);
  else if (days % 7 === 0) phrase = r.pick([`Review in ${days / 7} wks`, `Review after ${days / 7} week${days > 7 ? 's' : ''}`, `F/u after ${days / 7} weeks`, `R/v ${days / 7}/52`]);
  else phrase = r.pick([`Review after ${days} days`, `Review in ${days} days`, `F/u ${days}/7`, `Come back after ${days} days`]);
  return { text: `${phrase}${purpose ? ` ${purpose}` : ''}.`, gt: { dueDate: isoDay(due), asNeeded: false } };
}

// ---------------------------------------------------------------------------
// patients
// ---------------------------------------------------------------------------
export function generatePatients(r, n, today) {
  const used = new Set();
  const out = [];
  while (out.length < n) {
    const sex = r.chance(0.52) ? 'F' : 'M';
    const name = `${r.pick(sex === 'F' ? FIRST_F : FIRST_M)} ${r.pick(LAST)}`;
    if (used.has(name)) continue;
    used.add(name);
    const age = Math.max(18, Math.min(88, Math.round(r.normal(46, 15))));
    const dob = new Date(Date.UTC(today.getUTCFullYear() - age, r.int(0, 11), r.int(1, 28)));
    const chronic = Object.entries(CHRONIC).filter(([, c]) => r.chance(c.prevalence(age, sex))).map(([code]) => code);
    if (chronic.includes('E11') && !chronic.includes('E78.5') && r.chance(0.4)) chronic.push('E78.5');
    out.push({
      name, sex, age, dob,
      phone: `9${r.int(100000000, 999999999)}`,
      allergies: r.chance(0.06) ? [r.pick(['penicillin', 'sulfa drugs', 'aspirin'])] : [],
      chronic,
      // how reliably this patient returns for reviews
      adherence: r.chance(0.18) ? 'dropout' : r.chance(0.2) ? 'irregular' : 'regular',
      meds: new Map(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// chronic disease management
// ---------------------------------------------------------------------------
function initialRegimen(r, p) {
  const m = new Map();
  const set = (generic, dose, unit, frequency, form = 'Tab') => m.set(generic, { generic, dose, unit, frequency, form });
  if (p.chronic.includes('E11')) {
    set('metformin', r.pick([500, 500, 1000]), 'mg', 'twice daily');
    if (r.chance(0.35)) set('glimepiride', r.pick([1, 2]), 'mg', 'once daily');
  }
  if (p.chronic.includes('I10')) {
    if (r.chance(0.55)) set('telmisartan', r.pick([40, 40, 80]), 'mg', 'once daily');
    else set('amlodipine', r.pick([5, 5, 10]), 'mg', 'once daily');
  }
  if (p.chronic.includes('E03.9')) set('levothyroxine', r.pick([25, 50, 75, 100]), 'mcg', 'once daily');
  if (p.chronic.includes('E78.5')) set(r.chance(0.7) ? 'atorvastatin' : 'rosuvastatin', r.pick([10, 20]), 'mg', 'at bedtime');
  if (p.chronic.includes('J45.9')) {
    set('budesonide-formoterol', 200, 'mcg', 'twice daily', 'inhaler');
    set('salbutamol', 100, 'mcg', 'as needed', 'inhaler');
  }
  if (p.chronic.includes('M17.9')) set('aceclofenac', 100, 'mg', 'as needed');
  return m;
}

function chronicReview(r, p, visitDate) {
  const symptoms = []; const negatives = []; const labs = []; const vitals = []; const changes = [];
  const purposeBits = [];
  if (p.chronic.includes('E11')) {
    const control = p.dmControl ?? (p.dmControl = r.normal(0, 1));
    const hba1c = r.round(Math.max(5.6, 7.4 + control * 1.1 + r.normal(0, 0.3)), 1);
    const fbs = Math.round(Math.max(85, 95 + (hba1c - 5.5) * 28 + r.normal(0, 12)));
    labs.push(['fasting blood sugar', fbs]);
    if (r.chance(0.6)) labs.push(['post-prandial blood sugar', Math.round(fbs * 1.45 + r.normal(0, 15))]);
    if (r.chance(0.5)) labs.push(['HbA1c', hba1c]);
    if (hba1c > 8.5 && r.chance(0.4)) symptoms.push('polyuria');
    if (hba1c > 9 && r.chance(0.3)) symptoms.push('tingling');
    const met = p.meds.get('metformin');
    if (hba1c > 8 && met && met.dose < 1000 && r.chance(0.7)) {
      changes.push({ action: 'increase', generic: 'metformin', dose: 1000, unit: 'mg', frequency: 'twice daily' });
      met.dose = 1000; p.dmControl -= 0.6;
    } else if (hba1c > 8 && !p.meds.has('glimepiride') && r.chance(0.5)) {
      const g = { generic: 'glimepiride', dose: 1, unit: 'mg', frequency: 'once daily', form: 'Tab' };
      p.meds.set('glimepiride', g); changes.push({ action: 'start', ...g }); p.dmControl -= 0.5;
    } else if (hba1c > 8.5 && !p.meds.has('sitagliptin') && r.chance(0.4)) {
      const g = { generic: 'sitagliptin', dose: 100, unit: 'mg', frequency: 'once daily', form: 'Tab' };
      p.meds.set('sitagliptin', g); changes.push({ action: 'start', ...g }); p.dmControl -= 0.5;
    } else if (hba1c < 6.3 && p.meds.has('glimepiride') && r.chance(0.5)) {
      p.meds.delete('glimepiride'); changes.push({ action: 'stop', generic: 'glimepiride', dose: null, unit: null, frequency: null, reason: 'low sugars' });
    }
    purposeBits.push(r.pick(['with FBS, PPBS', 'with FBS', 'with HbA1c', 'with sugar reports']));
  }
  if (p.chronic.includes('I10')) {
    const ctrl = p.htnControl ?? (p.htnControl = r.normal(0, 1));
    const sys = Math.round(132 + ctrl * 12 + r.normal(0, 6));
    const dia = Math.round(84 + ctrl * 6 + r.normal(0, 4));
    vitals.push(['blood pressure', `${sys}/${dia}`]);
    if (sys > 150 && r.chance(0.4)) symptoms.push('headache');
    const telma = p.meds.get('telmisartan');
    if (sys >= 150 && telma && telma.dose < 80 && r.chance(0.6)) { telma.dose = 80; changes.push({ action: 'increase', generic: 'telmisartan', dose: 80, unit: 'mg', frequency: 'once daily' }); p.htnControl -= 0.7; }
    else if (sys >= 150 && !p.meds.has('amlodipine') && r.chance(0.5)) { const g = { generic: 'amlodipine', dose: 5, unit: 'mg', frequency: 'once daily', form: 'Tab' }; p.meds.set('amlodipine', g); changes.push({ action: 'start', ...g }); p.htnControl -= 0.7; }
    purposeBits.push('for BP check');
  }
  if (p.chronic.includes('E03.9') && r.chance(0.6)) {
    const tsh = r.round(Math.max(0.5, r.normal(3.5, 2.5)), 1);
    labs.push(['TSH', tsh]);
    const lt = p.meds.get('levothyroxine');
    if (tsh > 6 && lt && lt.dose < 125 && r.chance(0.7)) { lt.dose += 25; changes.push({ action: 'increase', generic: 'levothyroxine', dose: lt.dose, unit: 'mcg', frequency: 'once daily' }); }
    purposeBits.push('with TSH');
  }
  if (p.chronic.includes('E78.5') && r.chance(0.35)) labs.push(['LDL cholesterol', Math.round(Math.max(60, r.normal(118, 30)))]);
  if (p.chronic.includes('J45.9') && r.chance(0.4)) symptoms.push(r.pick(['wheezing', 'breathlessness', 'cough']));
  if (p.chronic.includes('M17.9') && r.chance(0.6)) symptoms.push('knee pain');
  if (r.chance(0.5)) negatives.push(r.pick(['chest pain', 'breathlessness', 'pedal oedema', 'blurred vision']));
  if (r.chance(0.35)) vitals.push(['weight', r.int(52, 96)]);
  if (r.chance(0.3)) vitals.push(['pulse', r.int(64, 98)]);
  return { symptoms: [...new Set(symptoms)], negatives: negatives.filter((n) => !symptoms.includes(n)), labs, vitals, changes, purpose: purposeBits.slice(0, 2).join(' & ').replace(' & for', ' and') };
}

// ---------------------------------------------------------------------------
// note writer
// ---------------------------------------------------------------------------
function knownLine(r, p, gt) {
  if (!p.chronic.length) return '';
  const names = p.chronic.map((code) => {
    gt.diagnoses.push({ code, certainty: 'confirmed', context: 'known' });
    return r.pick(CHRONIC[code].aliases);
  });
  const lead = r.pick(['K/c/o', 'Known case of', 'K/c/o', 'k/c/o']);
  const tail = r.pick([' on regular medication.', '.', ', on treatment.']);
  return `${lead} ${names.join(', ')}${tail}`;
}

function complaintLine(r, symptoms, durationDays, gt, typoRate) {
  if (!symptoms.length) return r.pick(['No fresh complaints.', 'Came for routine review, no new complaints.', 'Asymptomatic, came for follow up.']);
  const surf = symptoms.map((s) => {
    let w = r.pick(SYMPTOM_SURFACES[s] ?? [s]);
    if (r.chance(typoRate)) w = typo(r, w);
    gt.symptoms.push({ term: sxTerm(s), negated: false });
    return w;
  });
  const list = surf.length > 1 ? `${surf.slice(0, -1).join(', ')} and ${surf[surf.length - 1]}` : surf[0];
  const lead = r.pick(['C/o', 'Pt c/o', 'Complains of', 'Presents with', 'c/o']);
  const dur = durationDays ? ` ${durationText(r, durationDays)}` : '';
  return `${lead} ${list}${dur}.`;
}

function negativesLine(r, negatives, gt) {
  const real = negatives.filter((n) => SYMPTOM_SURFACES[n]?.[0]);
  if (!real.length) return '';
  const surf = real.map((n) => { gt.symptoms.push({ term: sxTerm(n), negated: true }); return r.pick(SYMPTOM_SURFACES[n]); });
  const lead = r.pick(['No', 'Denies', 'No h/o', 'No']);
  return `${lead} ${surf.length > 1 ? `${surf.slice(0, -1).join(', ')} or ${surf[surf.length - 1]}` : surf[0]}.`;
}

function vitalsLine(r, vitals, gt) {
  if (!vitals.length) return '';
  const parts = vitals.map(([name, v]) => {
    gt.vitals.push({ name, value: v });
    if (name === 'blood pressure') return `BP ${v}${r.chance(0.4) ? ' mmHg' : ''}`;
    if (name === 'pulse') return `PR ${v}${r.chance(0.5) ? '/min' : ''}`;
    if (name === 'temperature') return `Temp ${v}F`;
    if (name === 'SpO2') return `SpO2 ${v}%`;
    if (name === 'weight') return `Wt ${v} kg`;
    return `${name} ${v}`;
  });
  return `${r.pick(['O/E: ', 'O/E ', '', 'Exam: '])}${parts.join(', ')}.`;
}

function labsLine(r, labs, gt) {
  if (!labs.length) return '';
  const parts = labs.map(([test, value]) => { gt.labs.push({ test, value }); return labText(r, test, value); });
  return `${r.pick(['Reports: ', 'Inv: ', '', 'Labs - '])}${parts.join(', ')}.`;
}


// adverse drug reactions: give semantic search realistic "symptom after starting a drug" notes
const ADR = [
  { drug: 'amoxicillin-clavulanate', open: (b) => `Developed itchy rash over trunk and arms 2 days after starting ${b} for throat infection.`, sx: ['rash', 'itching'], neg: ['breathlessness'], dx: ['Drug rash', 'Adverse drug reaction'], next: { generic: 'cetirizine', dose: 10, unit: 'mg', frequency: 'once daily', durationDays: 5, action: 'prescribe' }, allergy: true },
  { drug: 'azithromycin', open: (b) => `Loose stools and abdominal cramps since starting ${b} 3 days ago.`, sx: ['loose stools', 'abdominal pain'], neg: ['fever'], dx: ['Adverse drug reaction', 'Drug reaction'], next: { generic: 'oral rehydration salts', dose: null, unit: null, frequency: null, durationDays: null, action: 'prescribe' } },
  { drug: 'amlodipine', open: (b) => `Swelling of feet for 3 weeks after starting ${b}.`, sx: ['pedal oedema'], neg: ['breathlessness', 'chest pain'], dx: ['Adverse drug reaction', 'Drug reaction'], next: { generic: 'telmisartan', dose: 40, unit: 'mg', frequency: 'once daily', durationDays: null, action: 'start' }, chronicSwap: true },
  { drug: 'ramipril', open: (b) => `Dry cough for 4 weeks since starting ${b} 5 mg.`, sx: ['cough'], neg: ['fever', 'breathlessness'], dx: ['Adverse drug reaction'], next: { generic: 'telmisartan', dose: 40, unit: 'mg', frequency: 'once daily', durationDays: null, action: 'start' } },
  { drug: 'metformin', open: (b) => `Nausea and abdominal discomfort after the dose of ${b} was increased.`, sx: ['nausea', 'abdominal pain'], neg: ['vomiting'], dx: ['Adverse drug reaction', 'Drug reaction'], next: null, reduce: { generic: 'metformin', dose: 500, unit: 'mg', frequency: 'twice daily', action: 'decrease' } },
  { drug: 'telmisartan', open: (b) => `Giddiness on standing since starting ${b} 80.`, sx: ['dizziness'], neg: ['chest pain'], dx: ['Adverse drug reaction'], next: null, reduce: { generic: 'telmisartan', dose: 40, unit: 'mg', frequency: 'once daily', action: 'decrease' } },
  { drug: 'atorvastatin', open: (b) => `Muscle pains in both thighs since starting ${b}.`, sx: ['body ache'], neg: ['fever'], dx: ['Adverse drug reaction', 'Drug reaction'], next: { generic: 'rosuvastatin', dose: 5, unit: 'mg', frequency: 'at bedtime', durationDays: null, action: 'start' } },
];

export function writeAdrVisit(r, p, visitDate) {
  const gt = { symptoms: [], diagnoses: [], medications: [], labs: [], vitals: [], followUp: null };
  const a = r.pick(ADR);
  const brand = brandOrGeneric(r, a.drug);
  const lines = [];
  if (p.chronic.length && r.chance(0.6)) lines.push(knownLine(r, p, gt));
  lines.push(a.open(`${r.chance(0.5) ? 'Tab ' : ''}${brand}`));
  for (const sx of a.sx) gt.symptoms.push({ term: sxTerm(sx), negated: false });
  lines.push(negativesLine(r, a.neg, gt));
  const dx = r.pick(a.dx);
  gt.diagnoses.push({ code: 'T88.7', certainty: 'confirmed', context: 'current' });
  lines.push(r.pick([`Dx: ${dx} due to ${a.drug}.`, `Imp: ${dx} (${a.drug}).`, `A/P: ${dx}.`]));
  if (a.reduce) {
    gt.medications.push({ generic: a.reduce.generic, dose: a.reduce.dose, unit: a.reduce.unit, frequency: a.reduce.frequency, action: 'decrease' });
    lines.push(`Reduce ${brandOrGeneric(r, a.reduce.generic)} to ${a.reduce.dose} ${a.reduce.unit} ${r.pick(FREQ_STYLES[a.reduce.frequency])}.`);
    const cur = p.meds.get(a.reduce.generic);
    if (cur) cur.dose = a.reduce.dose;
  } else {
    gt.medications.push({ generic: a.drug, dose: null, unit: null, frequency: null, action: 'stop' });
    lines.push(`${r.pick(['Stop', 'Discontinue'])} ${brandOrGeneric(r, a.drug)}.`);
    p.meds.delete(a.drug);
  }
  if (a.next) {
    gt.medications.push({ generic: a.next.generic, dose: a.next.dose, unit: a.next.unit, frequency: a.next.frequency, action: a.next.action, durationDays: a.next.durationDays });
    lines.push(`${a.next.action === 'start' ? r.pick(['Start', 'Switch to']) : 'Rx:'} ${medLine(r, { ...a.next, form: 'Tab' })}.`);
    if (a.next.action === 'start') p.meds.set(a.next.generic, { generic: a.next.generic, dose: a.next.dose, unit: a.next.unit, frequency: a.next.frequency, form: 'Tab' });
  }
  if (a.allergy) { lines.push(`Allergy to ${a.drug === 'amoxicillin-clavulanate' ? 'amoxicillin' : a.drug} noted.`); p.allergies = [...new Set([...(p.allergies ?? []), 'amoxicillin'])]; }
  const fu = followUpText(r, r.pick([7, 14]), null, visitDate);
  gt.followUp = fu.gt;
  lines.push(fu.text);
  const body = lines.filter((l) => l && l.trim());
  return { text: r.chance(0.5) ? body.join(' ') : body.join('\n'), gt, kind: 'adr' };
}

/** Write one consultation note and its ground truth. */
export function writeVisit(r, p, visitDate, kind, { typoRate = 0.04 } = {}) {
  if (kind === 'acute' && r.chance(0.07)) return writeAdrVisit(r, p, visitDate);
  const gt = { symptoms: [], diagnoses: [], medications: [], labs: [], vitals: [], followUp: null };
  const lines = [];
  const header = r.chance(0.5) ? `${p.age}${p.sex}. ` : '';

  if (kind === 'chronic') {
    if (!p.meds.size) p.meds = initialRegimen(r, p);
    const rev = chronicReview(r, p, visitDate);
    lines.push(header + knownLine(r, p, gt));
    lines.push(complaintLine(r, rev.symptoms, rev.symptoms.length && r.chance(0.6) ? r.pick([7, 14, 30]) : null, gt, typoRate));
    lines.push(negativesLine(r, rev.negatives, gt));
    lines.push(vitalsLine(r, rev.vitals, gt));
    lines.push(labsLine(r, rev.labs, gt));
    // medications: continue the stable ones, then the changes
    const changed = new Set(rev.changes.map((c) => c.generic));
    const cont = [...p.meds.values()].filter((m) => !changed.has(m.generic));
    if (r.chance(0.3) && rev.changes.length === 0) {
      lines.push(r.pick(['Imp: controlled.', 'Stable on current Rx.', 'Doing well.']));
    }
    const medParts = [];
    if (cont.length) {
      const lead = r.pick(['Cont', 'Continue', 'Cont', 'C/w']);
      medParts.push(`${lead} ${cont.map((m) => { gt.medications.push({ generic: m.generic, dose: m.dose, unit: m.unit, frequency: m.frequency, action: 'continue' }); return medLine(r, { ...m, form: m.form === 'inhaler' ? 'inhaler' : null, durationDays: null }); }).join(', ')}.`);
    }
    for (const c of rev.changes) {
      if (c.action === 'increase') {
        gt.medications.push({ generic: c.generic, dose: c.dose, unit: c.unit, frequency: c.frequency, action: 'increase' });
        medParts.push(`${r.pick(['Increase', 'Increase', 'Step up'])} ${brandOrGeneric(r, c.generic)} to ${c.dose} ${c.unit} ${r.pick(FREQ_STYLES[c.frequency])}.`);
      } else if (c.action === 'start') {
        gt.medications.push({ generic: c.generic, dose: c.dose, unit: c.unit, frequency: c.frequency, action: 'start' });
        medParts.push(`${r.pick(['Start', 'Add', 'Started on'])} ${medLine(r, { ...c, form: r.chance(0.5) ? 'Tab' : null })}.`);
      } else if (c.action === 'stop') {
        gt.medications.push({ generic: c.generic, dose: null, unit: null, frequency: null, action: 'stop' });
        medParts.push(`${r.pick(['Stop', 'Stop', 'Discontinue'])} ${brandOrGeneric(r, c.generic)} (${c.reason}).`);
      }
    }
    lines.push(medParts.join(' '));
    if (r.chance(0.5)) lines.push(r.pick(['Diet and exercise advice given.', 'Advised regular walking.', 'Salt restriction advised.', 'Compliance stressed.']));
    const fuDays = r.pick([28, 28, 30, 42, 56, 60, 84, 90]);
    const fu = followUpText(r, fuDays, rev.purpose || null, visitDate);
    gt.followUp = fu.gt;
    lines.push(fu.text);
  } else {
    // acute episode
    const pool = ACUTE.filter((a) => (!a.sex || a.sex === p.sex) && (!a.season || a.season.includes(visitDate.getUTCMonth() + 1)));
    const weights = pool.map((a) => a.weight);
    let roll = r.next() * weights.reduce((s, w) => s + w, 0);
    const a = pool.find((x, i) => (roll -= weights[i]) < 0) ?? pool[0];
    const symptoms = a.sx.filter(([, pr], i) => i === 0 || r.chance(pr)).map(([s]) => s).filter((s) => SYMPTOM_SURFACES[s]?.[0]);
    const days = r.int(a.days[0], a.days[1]);
    if (r.chance(0.6)) lines.push(header + knownLine(r, p, gt));
    else if (header) lines.push(header.trim());
    lines.push(complaintLine(r, symptoms, days, gt, typoRate));
    lines.push(negativesLine(r, r.sample(a.neg, r.int(0, Math.min(2, a.neg.length))), gt));
    const vitals = [];
    if (symptoms.includes('fever')) vitals.push(['temperature', r.round(r.normal(100.6, 0.8), 1)]);
    if (p.chronic.includes('I10') || r.chance(0.3)) vitals.push(['blood pressure', `${r.int(112, 148)}/${r.int(70, 94)}`]);
    if (symptoms.includes('breathlessness') || a.code === 'J22') vitals.push(['SpO2', r.int(93, 99)]);
    if (r.chance(0.3)) vitals.push(['pulse', r.int(72, 110)]);
    lines.push(vitalsLine(r, vitals, gt));
    const labs = [];
    for (const [test, value, pr] of a.labs ?? []) {
      if (!r.chance(pr)) continue;
      let v = value;
      if (typeof value === 'function') v = value();
      if (value === 'low') v = test === 'haemoglobin' ? r.round(r.normal(9.4, 0.8), 1) : r.int(8, 19);
      labs.push([test, v]);
    }
    lines.push(labsLine(r, labs, gt));
    const provisional = a.provisional && r.chance(a.provisional);
    const dxSurface = r.pick(a.dx);
    gt.diagnoses.push({ code: a.code, certainty: provisional ? 'provisional' : 'confirmed', context: 'current' });
    lines.push(provisional ? r.pick([`?${dxSurface}.`, `Imp: ?${dxSurface}.`, `Likely ${dxSurface}.`, `Dx: suspected ${dxSurface}.`]) : r.pick([`Dx: ${dxSurface}.`, `Imp: ${dxSurface}.`, `Diagnosis - ${dxSurface}.`, `A/P: ${dxSurface}.`]));
    const meds = (a.medsAlt ?? a.meds).filter((m) => drugIndex.has(m.generic));
    if (meds.length) {
      const lead = r.pick(['Rx:', 'Adv:', 'Rx -', 'Plan:']);
      const mtexts = meds.map((m) => {
        const t = r.chance(typoRate) ? { ...m, typo: true } : m;
        gt.medications.push({ generic: m.generic, dose: m.dose, unit: m.unit, frequency: m.frequency, action: 'prescribe', durationDays: m.durationDays ?? null });
        return medLine(r, { ...t, form: m.form ? (m.form === 'Tab' ? r.pick(['Tab', 'Tab', 'T.', 'Tab.']) : m.form) : null });
      });
      lines.push(`${lead} ${mtexts.join(r.pick([', ', '; ', ', ']))}.`);
    }
    if (r.chance(0.4)) lines.push(r.pick(['Plenty of oral fluids.', 'Rest advised.', 'Steam inhalation.', 'Soft bland diet.', 'Warm saline gargles.']));
    const fu = followUpText(r, a.fu, a.fu === 'sos' ? null : r.pick([null, null, 'with reports', 'if needed earlier']), visitDate);
    // "if needed earlier" is not a purpose; keep the gt due date only
    gt.followUp = fu.gt;
    lines.push(fu.text.replace(' if needed earlier.', '.'));
  }
  // drop empty lines; join as one paragraph or several lines
  const body = lines.filter((l) => l && l.trim());
  const text = r.chance(0.5) ? body.join(' ') : body.join('\n');
  // keep only unique gt diagnoses by code+certainty
  const seen = new Set();
  gt.diagnoses = gt.diagnoses.filter((d) => { const k = `${d.code}|${d.certainty}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { text, gt, kind };
}

/**
 * Build visit schedules: chronic patients have regular reviews (some stop
 * coming); everyone can have acute visits. Returns visits sorted by date.
 */
export function scheduleVisits(r, patients, start, today) {
  const visits = [];
  const span = (today - start) / 864e5;
  for (const p of patients) {
    if (p.chronic.length) {
      let d = addDays(start, r.int(0, 40));
      const stopAfter = p.adherence === 'dropout' ? r.int(1, 3) : Infinity;
      let count = 0;
      while (d < today && count < stopAfter) {
        visits.push({ p, date: d, kind: 'chronic' });
        count++;
        const gap = r.pick([28, 30, 42, 56, 60, 84]) + (p.adherence === 'irregular' ? r.int(10, 40) : r.int(-3, 5));
        d = addDays(d, gap);
      }
    }
    const acuteCount = r.chance(0.55) ? r.int(1, 3) : 0;
    for (let i = 0; i < acuteCount; i++) visits.push({ p, date: addDays(start, r.int(0, Math.floor(span))), kind: 'acute' });
  }
  for (const v of visits) v.date = new Date(Date.UTC(v.date.getUTCFullYear(), v.date.getUTCMonth(), v.date.getUTCDate(), r.int(3, 12), r.pick([0, 10, 20, 30, 40, 50])));
  return visits.filter((v) => v.date <= today).sort((a, b) => a.date - b.date);
}
