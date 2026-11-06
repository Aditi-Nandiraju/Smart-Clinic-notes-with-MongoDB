// Blind test notes, written after development and NOT used for tuning.
// Results on this set are the honest estimate of how the extractor does on
// unseen hand-written notes. visitDate for all: 2026-10-01.

export const BLIND_VISIT_DATE = '2026-10-01';

export const BLIND_CASES = [
  {
    text: '52 yr old male, diabetic x 8 yrs. Burning feet at night, numbness both soles. FBS 186 mg/dl, HbA1c 8.6%. Diabetic neuropathy. Add Tab Pregeb 75 mg HS. Increase metformin to 1000 BD. Review after 1 month with FBS/PPBS.',
    gt: { symptoms: [['tingling', false]], diagnoses: [['E11', 'confirmed'], ['G62.9', 'confirmed']], medications: [['pregabalin', 75, 'at bedtime', 'start'], ['metformin', 1000, 'twice daily', 'increase']], labs: [['fasting blood sugar', 186], ['HbA1c', 8.6]], followUp: { dueDate: '2026-10-31' } },
  },
  {
    text: 'Child brought by mother - ear pain since 2 days, fever 101F. No discharge. R TM bulging. AOM. Syp Augmentin 228 mg BD x 7d, Syp Calpol SOS. Review in 5 days.',
    gt: { symptoms: [['ear pain', false], ['fever', false]], diagnoses: [['H66.9', 'confirmed']], medications: [['amoxicillin-clavulanate', 228, 'twice daily', 'prescribe'], ['paracetamol', null, 'as needed', 'prescribe']], vitals: [['temperature', 101]], followUp: { dueDate: '2026-10-06' } },
  },
  {
    text: 'Palpitations and weight loss 3 months, heat intolerance. TSH <0.01. Thyrotoxicosis. Start Tab Ciplar 20 mg BD. Refer endocrinology. f/u 2 wks.',
    gt: { symptoms: [['palpitations', false], ['weight loss', false]], diagnoses: [['E05.9', 'confirmed']], medications: [['propranolol', 20, 'twice daily', 'start']], followUp: { dueDate: '2026-10-15' } },
  },
  {
    text: 'Pt is a k/c/o COPD, smoker. Increased breathlessness & cough with sputum x 1 week. No chest pain. SpO2 91% RA. Acute exacerbation of COPD. Tab Azee 500 OD x 5 days, Tab Wysolone 40 mg OD x 5 days, continue Foracort. Review after 3 days, earlier if worse.',
    gt: { symptoms: [['breathlessness', false], ['cough', false], ['chest pain', true]], diagnoses: [['J44.9', 'confirmed']], medications: [['azithromycin', 500, 'once daily', 'prescribe'], ['prednisolone', 40, 'once daily', 'prescribe'], ['budesonide-formoterol', null, null, 'continue']], vitals: [['SpO2', 91]], followUp: { dueDate: '2026-10-04' } },
  },
  {
    text: 'Swelling of both feet for 10 days. BP 150/90. Creatinine 2.4. CKD stage 3? Stop Brufen (was taking for knee pain). Tab Lasix 40 mg OD. USG KUB advised. Review with reports in 1 week.',
    gt: { symptoms: [['pedal oedema', false], ['knee pain', false]], diagnoses: [['N18.9', 'provisional']], medications: [['ibuprofen', null, null, 'stop'], ['furosemide', 40, 'once daily', 'prescribe']], labs: [['serum creatinine', 2.4]], vitals: [['blood pressure', '150/90']], followUp: { dueDate: '2026-10-08' } },
  },
  {
    text: 'Sore throat, odynophagia, fever x 2 days. Tonsils enlarged with exudates. Acute tonsillitis. Tab Amoxicillin 500 mg TDS x 5 days, Dolo 650 SOS, warm saline gargles. No review needed unless symptoms persist.',
    gt: { symptoms: [['sore throat', false], ['fever', false]], diagnoses: [['J03.9', 'confirmed']], medications: [['amoxicillin', 500, 'three times daily', 'prescribe'], ['paracetamol', 650, 'as needed', 'prescribe']], followUp: null },
  },
  {
    text: 'Follow up visit. HTN well controlled on Amlokind 5 OD, BP 128/80. Lipids: LDL 96, TG 180. Cont same. Next visit after 3 months with lipid profile.',
    gt: { symptoms: [], diagnoses: [['I10', 'confirmed']], medications: [['amlodipine', 5, 'once daily', 'continue']], labs: [['LDL cholesterol', 96], ['triglycerides', 180]], vitals: [['blood pressure', '128/80']], followUp: { dueDate: '2026-12-30' } },
  },
  {
    text: '34F, irregular periods, weight gain and acne x 1 yr. USG s/o PCOS. Lifestyle modification. Tab Metformin 500 mg BD after food. Review in 3 months.',
    gt: { symptoms: [['irregular periods', false], ['weight gain', false]], diagnoses: [['E28.2', 'provisional']], medications: [['metformin', 500, 'twice daily', 'prescribe']], followUp: { dueDate: '2026-12-30' } },
  },
  {
    text: 'Headache on and off for 6 months, worse with stress, band-like. No vomiting, no visual symptoms. Tension type headache. Tab Tryptomer 10 mg HS x 1 month. Review after 4 wks.',
    gt: { symptoms: [['headache', false], ['vomiting', true]], diagnoses: [['G44.2', 'confirmed']], medications: [['amitriptyline', 10, 'at bedtime', 'prescribe']], followUp: { dueDate: '2026-10-29' } },
  },
  {
    text: 'Fall at home, wrist pain. X-ray normal. Soft tissue injury. Tab Ultracet 1 tab SOS, crepe bandage. If pain persists review after 1 week.',
    gt: { symptoms: [], diagnoses: [], medications: [['tramadol', null, 'as needed', 'prescribe']], followUp: { dueDate: '2026-10-08' } },
  },
  {
    text: 'Known hypothyroid on Eltroxin 50mcg. Feeling low, poor sleep, crying spells x 6 wks. No suicidal ideation. Depression. Start Tab Nexito 5 mg OD. Counselling referral. Review in 2 weeks.',
    gt: { symptoms: [['low mood', false], ['poor sleep', false]], diagnoses: [['E03.9', 'confirmed'], ['F32.9', 'confirmed']], medications: [['levothyroxine', 50, null, 'continue'], ['escitalopram', 5, 'once daily', 'start']], followUp: { dueDate: '2026-10-15' } },
  },
  {
    text: 'Redness, warmth and swelling left leg x 3 days with fever. Cellulitis L leg. Cap Cefuroxime 500 BD x 7 days, Tab PCM 500 TDS. Limb elevation. Review after 48 hrs.',
    gt: { symptoms: [['fever', false]], diagnoses: [['L03.9', 'confirmed']], medications: [['cefuroxime', 500, 'twice daily', 'prescribe'], ['paracetamol', 500, 'three times daily', 'prescribe']], followUp: { dueDate: '2026-10-03' } },
  },
];
