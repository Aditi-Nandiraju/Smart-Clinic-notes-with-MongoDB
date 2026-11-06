// Medication lexicon: generic name, drug class, default strength unit, and
// surface forms (Indian brand names, abbreviations, common spellings).
// Matching is case-insensitive and on word boundaries; longest match wins.

export const DRUGS = [
  // Diabetes
  { generic: 'metformin', cls: 'biguanide', unit: 'mg', aliases: ['metformin', 'glycomet', 'glyciphage', 'gluconorm', 'obimet'] },
  { generic: 'glimepiride', cls: 'sulfonylurea', unit: 'mg', aliases: ['glimepiride', 'amaryl', 'glimisave', 'zoryl'] },
  { generic: 'gliclazide', cls: 'sulfonylurea', unit: 'mg', aliases: ['gliclazide', 'diamicron', 'glizid'] },
  { generic: 'sitagliptin', cls: 'DPP-4 inhibitor', unit: 'mg', aliases: ['sitagliptin', 'januvia', 'istavel', 'zita'] },
  { generic: 'vildagliptin', cls: 'DPP-4 inhibitor', unit: 'mg', aliases: ['vildagliptin', 'galvus', 'jalra'] },
  { generic: 'dapagliflozin', cls: 'SGLT2 inhibitor', unit: 'mg', aliases: ['dapagliflozin', 'forxiga', 'oxra'] },
  { generic: 'empagliflozin', cls: 'SGLT2 inhibitor', unit: 'mg', aliases: ['empagliflozin', 'jardiance'] },
  { generic: 'insulin glargine', cls: 'insulin', unit: 'units', aliases: ['insulin glargine', 'glargine', 'lantus', 'basalog'] },
  { generic: 'regular insulin', cls: 'insulin', unit: 'units', aliases: ['regular insulin', 'actrapid', 'huminsulin r'] },
  // Cardiovascular
  { generic: 'amlodipine', cls: 'calcium channel blocker', unit: 'mg', aliases: ['amlodipine', 'amlong', 'amlokind', 'stamlo', 'amlopres'] },
  { generic: 'telmisartan', cls: 'ARB', unit: 'mg', aliases: ['telmisartan', 'telma', 'telmikind', 'telsartan'] },
  { generic: 'losartan', cls: 'ARB', unit: 'mg', aliases: ['losartan', 'losar', 'repace', 'covance'] },
  { generic: 'ramipril', cls: 'ACE inhibitor', unit: 'mg', aliases: ['ramipril', 'cardace'] },
  { generic: 'enalapril', cls: 'ACE inhibitor', unit: 'mg', aliases: ['enalapril', 'envas'] },
  { generic: 'atenolol', cls: 'beta blocker', unit: 'mg', aliases: ['atenolol', 'aten', 'tenormin'] },
  { generic: 'metoprolol', cls: 'beta blocker', unit: 'mg', aliases: ['metoprolol', 'met xl', 'metolar', 'betaloc'] },
  { generic: 'hydrochlorothiazide', cls: 'thiazide diuretic', unit: 'mg', aliases: ['hydrochlorothiazide', 'hctz', 'aquazide'] },
  { generic: 'furosemide', cls: 'loop diuretic', unit: 'mg', aliases: ['furosemide', 'frusemide', 'lasix'] },
  { generic: 'spironolactone', cls: 'potassium-sparing diuretic', unit: 'mg', aliases: ['spironolactone', 'aldactone'] },
  { generic: 'atorvastatin', cls: 'statin', unit: 'mg', aliases: ['atorvastatin', 'atorva', 'lipitor', 'storvas', 'atocor'] },
  { generic: 'rosuvastatin', cls: 'statin', unit: 'mg', aliases: ['rosuvastatin', 'rosuvas', 'rozavel', 'crestor'] },
  { generic: 'aspirin', cls: 'antiplatelet', unit: 'mg', aliases: ['aspirin', 'ecosprin', 'disprin'] },
  { generic: 'clopidogrel', cls: 'antiplatelet', unit: 'mg', aliases: ['clopidogrel', 'clopilet', 'plavix', 'deplatt'] },
  // Analgesics / antipyretics
  { generic: 'paracetamol', cls: 'analgesic', unit: 'mg', aliases: ['paracetamol', 'acetaminophen', 'pcm', 'dolo', 'crocin', 'calpol'] },
  { generic: 'ibuprofen', cls: 'NSAID', unit: 'mg', aliases: ['ibuprofen', 'brufen', 'ibugesic'] },
  { generic: 'diclofenac', cls: 'NSAID', unit: 'mg', aliases: ['diclofenac', 'voveran', 'dynapar'] },
  { generic: 'aceclofenac', cls: 'NSAID', unit: 'mg', aliases: ['aceclofenac', 'zerodol', 'hifenac'] },
  { generic: 'tramadol', cls: 'opioid analgesic', unit: 'mg', aliases: ['tramadol', 'ultracet', 'contramal'] },
  // Antibiotics
  { generic: 'amoxicillin', cls: 'penicillin antibiotic', unit: 'mg', aliases: ['amoxicillin', 'amoxycillin', 'mox', 'novamox'] },
  { generic: 'amoxicillin-clavulanate', cls: 'penicillin antibiotic', unit: 'mg', aliases: ['amoxicillin-clavulanate', 'amoxicillin clavulanate', 'co-amoxiclav', 'augmentin', 'moxikind-cv', 'clavam'] },
  { generic: 'azithromycin', cls: 'macrolide antibiotic', unit: 'mg', aliases: ['azithromycin', 'azithral', 'azee', 'zithromax'] },
  { generic: 'ciprofloxacin', cls: 'fluoroquinolone antibiotic', unit: 'mg', aliases: ['ciprofloxacin', 'ciplox', 'cifran'] },
  { generic: 'levofloxacin', cls: 'fluoroquinolone antibiotic', unit: 'mg', aliases: ['levofloxacin', 'levoflox', 'glevo'] },
  { generic: 'cefixime', cls: 'cephalosporin antibiotic', unit: 'mg', aliases: ['cefixime', 'taxim-o', 'zifi', 'mahacef'] },
  { generic: 'cefuroxime', cls: 'cephalosporin antibiotic', unit: 'mg', aliases: ['cefuroxime', 'ceftum', 'zinnat'] },
  { generic: 'doxycycline', cls: 'tetracycline antibiotic', unit: 'mg', aliases: ['doxycycline', 'doxy-1', 'doxt'] },
  { generic: 'nitrofurantoin', cls: 'urinary antibiotic', unit: 'mg', aliases: ['nitrofurantoin', 'niftran', 'martifur'] },
  { generic: 'metronidazole', cls: 'nitroimidazole', unit: 'mg', aliases: ['metronidazole', 'flagyl', 'metrogyl'] },
  // GI
  { generic: 'pantoprazole', cls: 'proton pump inhibitor', unit: 'mg', aliases: ['pantoprazole', 'pan', 'pantocid', 'pan-d', 'pantop'] },
  { generic: 'omeprazole', cls: 'proton pump inhibitor', unit: 'mg', aliases: ['omeprazole', 'omez'] },
  { generic: 'rabeprazole', cls: 'proton pump inhibitor', unit: 'mg', aliases: ['rabeprazole', 'razo', 'rablet'] },
  { generic: 'ondansetron', cls: 'antiemetic', unit: 'mg', aliases: ['ondansetron', 'emeset', 'ondem', 'vomikind'] },
  { generic: 'domperidone', cls: 'antiemetic', unit: 'mg', aliases: ['domperidone', 'domstal'] },
  { generic: 'oral rehydration salts', cls: 'rehydration', unit: 'sachet', aliases: ['oral rehydration salts', 'ors', 'electral'] },
  { generic: 'lactulose', cls: 'laxative', unit: 'ml', aliases: ['lactulose', 'duphalac'] },
  // Respiratory / allergy
  { generic: 'cetirizine', cls: 'antihistamine', unit: 'mg', aliases: ['cetirizine', 'cetzine', 'okacet', 'alerid'] },
  { generic: 'levocetirizine', cls: 'antihistamine', unit: 'mg', aliases: ['levocetirizine', 'levocet', 'xyzal', 'teczine'] },
  { generic: 'fexofenadine', cls: 'antihistamine', unit: 'mg', aliases: ['fexofenadine', 'allegra'] },
  { generic: 'montelukast', cls: 'leukotriene antagonist', unit: 'mg', aliases: ['montelukast', 'montair', 'romilast'] },
  { generic: 'salbutamol', cls: 'bronchodilator', unit: 'mcg', aliases: ['salbutamol', 'albuterol', 'asthalin'] },
  { generic: 'budesonide', cls: 'inhaled corticosteroid', unit: 'mcg', aliases: ['budesonide', 'budecort', 'pulmicort'] },
  { generic: 'budesonide-formoterol', cls: 'inhaled combination', unit: 'mcg', aliases: ['budesonide-formoterol', 'foracort', 'symbicort'] },
  // Endocrine / supplements
  { generic: 'levothyroxine', cls: 'thyroid hormone', unit: 'mcg', aliases: ['levothyroxine', 'thyroxine', 'thyronorm', 'eltroxin', 'thyrox'] },
  { generic: 'prednisolone', cls: 'corticosteroid', unit: 'mg', aliases: ['prednisolone', 'wysolone', 'omnacortil'] },
  { generic: 'ferrous sulfate', cls: 'iron supplement', unit: 'mg', aliases: ['ferrous sulfate', 'ferrous sulphate', 'iron tablets', 'livogen', 'autrin'] },
  { generic: 'folic acid', cls: 'vitamin', unit: 'mg', aliases: ['folic acid', 'folvite'] },
  { generic: 'cholecalciferol', cls: 'vitamin D', unit: 'IU', aliases: ['cholecalciferol', 'vitamin d3', 'vit d3', 'uprise d3', 'calcirol', 'd-rise'] },
  { generic: 'calcium carbonate', cls: 'calcium supplement', unit: 'mg', aliases: ['calcium carbonate', 'shelcal', 'calcimax'] },
  { generic: 'methylcobalamin', cls: 'vitamin B12', unit: 'mcg', aliases: ['methylcobalamin', 'mecobalamin', 'nurokind', 'methycobal'] },
  // CNS
  { generic: 'sertraline', cls: 'SSRI', unit: 'mg', aliases: ['sertraline', 'serta', 'daxid'] },
  { generic: 'escitalopram', cls: 'SSRI', unit: 'mg', aliases: ['escitalopram', 'nexito', 'cipralex'] },
  { generic: 'alprazolam', cls: 'benzodiazepine', unit: 'mg', aliases: ['alprazolam', 'alprax', 'restyl'] },
  { generic: 'clonazepam', cls: 'benzodiazepine', unit: 'mg', aliases: ['clonazepam', 'clonotril', 'rivotril'] },
  { generic: 'pregabalin', cls: 'gabapentinoid', unit: 'mg', aliases: ['pregabalin', 'pregeb', 'lyrica'] },
  { generic: 'gabapentin', cls: 'gabapentinoid', unit: 'mg', aliases: ['gabapentin', 'gabapin'] },
  { generic: 'amitriptyline', cls: 'tricyclic antidepressant', unit: 'mg', aliases: ['amitriptyline', 'tryptomer'] },
  { generic: 'propranolol', cls: 'beta blocker', unit: 'mg', aliases: ['propranolol', 'ciplar', 'inderal'] },
  { generic: 'sumatriptan', cls: 'triptan', unit: 'mg', aliases: ['sumatriptan', 'suminat'] },
  // Topicals / misc
  { generic: 'clotrimazole', cls: 'antifungal', unit: '%', aliases: ['clotrimazole', 'candid'] },
  { generic: 'fluconazole', cls: 'antifungal', unit: 'mg', aliases: ['fluconazole', 'forcan', 'zocon'] },
  { generic: 'terbinafine', cls: 'antifungal', unit: 'mg', aliases: ['terbinafine', 'terbicip', 'lamisil'] },
  { generic: 'mupirocin', cls: 'topical antibiotic', unit: '%', aliases: ['mupirocin', 't-bact'] },
];

// Words that are also common English words or other meanings.
// They only count as a drug when a dosage form precedes them (e.g. "Tab Pan 40")
// or a strength follows (e.g. "Pan 40 mg").
export const AMBIGUOUS_DRUG_ALIASES = new Set(['pan', 'mox', 'aten', 'zita', 'serta', 'candid', 'telma', 'zifi', 'repace']);

export const DOSAGE_FORMS = {
  tab: 'tablet', 'tab.': 'tablet', tabs: 'tablet', tablet: 'tablet', 't.': 'tablet',
  cap: 'capsule', 'cap.': 'capsule', caps: 'capsule', capsule: 'capsule',
  syp: 'syrup', 'syp.': 'syrup', syrup: 'syrup', susp: 'suspension',
  inj: 'injection', 'inj.': 'injection', injection: 'injection',
  inh: 'inhaler', inhaler: 'inhaler', neb: 'nebulisation', nebulisation: 'nebulisation',
  oint: 'ointment', ointment: 'ointment', cream: 'cream', gel: 'gel', lotion: 'lotion',
  drops: 'drops', sachet: 'sachet',
};

export const FREQUENCIES = [
  { re: /\b(?:od|qd|once daily|once a day|o\.d\.)\b/i, value: 'once daily', perDay: 1 },
  { re: /\b(?:bd|bid|b\.d\.|twice daily|twice a day)\b/i, value: 'twice daily', perDay: 2 },
  { re: /\b(?:tds|tid|t\.d\.s\.|thrice daily|three times a day|thrice a day)\b/i, value: 'three times daily', perDay: 3 },
  { re: /\b(?:qid|qds|four times a day)\b/i, value: 'four times daily', perDay: 4 },
  { re: /\b(?:hs|at bedtime|at night|qhs)\b/i, value: 'at bedtime', perDay: 1 },
  { re: /\b(?:sos|prn|as needed|when required)\b/i, value: 'as needed', perDay: null },
  { re: /\bstat\b/i, value: 'once immediately', perDay: null },
  { re: /\b(?:weekly|once a week|once weekly)\b/i, value: 'once weekly', perDay: null },
  { re: /\b1-0-1\b/, value: 'twice daily', perDay: 2 },
  { re: /\b1-1-1\b/, value: 'three times daily', perDay: 3 },
  { re: /\b1-0-0\b/, value: 'once daily', perDay: 1 },
  { re: /\b0-0-1\b/, value: 'at bedtime', perDay: 1 },
];

export const MED_ACTIONS = [
  { re: /\b(?:stop(?:ped)?|discontinue[d]?|d\/c|hold|withdraw(?:n)?|omit)\b/i, value: 'stop' },
  { re: /\b(?:increase[d]?|step(?:ped)? up|uptitrate[d]?|↑)\b/i, value: 'increase' },
  { re: /\b(?:decrease[d]?|reduce[d]?|taper(?:ed)?|step(?:ped)? down|↓)\b/i, value: 'decrease' },
  { re: /\b(?:cont(?:inue)?\.?|continued|c\/w|same)\b/i, value: 'continue' },
  { re: /\b(?:start(?:ed)?|add(?:ed)?|initiate[d]?|begin|commence[d]?|new|switch(?:ed)? to|change(?:d)? to|shift(?:ed)? to)\b/i, value: 'start' },
];
