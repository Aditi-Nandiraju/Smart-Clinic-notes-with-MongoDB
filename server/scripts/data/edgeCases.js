// Hand-written notes that target known hard cases for clinical NLP:
// negation scope, uncertainty, history vs current, allergies, typos,
// brand names, implicit units, dose changes and unusual follow-up wording.
// Ground truth written by hand. visitDate for all: 2026-10-01.

export const EDGE_VISIT_DATE = '2026-10-01';

export const EDGE_CASES = [
  {
    text: 'No fever, cough or breathlessness. C/o sore throat x 2 days. Dx: acute pharyngitis. Tab Azithral 500 OD x 3 days. Review SOS.',
    gt: { symptoms: [['fever', true], ['cough', true], ['breathlessness', true], ['sore throat', false]], diagnoses: [['J02.9', 'confirmed']], medications: [['azithromycin', 500, 'once daily', 'prescribe']], followUp: { asNeeded: true } },
  },
  {
    text: 'Fever x 3/7 but no cough. ?Dengue vs viral fever. NS1 pending. Rx: PCM 650 mg TDS. Review after 2 days with CBC.',
    gt: { symptoms: [['fever', false], ['cough', true]], diagnoses: [['A90', 'provisional'], ['B34.9', 'provisional']], medications: [['paracetamol', 650, 'three times daily', 'prescribe']], followUp: { dueDate: '2026-10-03' } },
  },
  {
    text: 'Known diabetic and hypertensive. h/o CAD s/p PTCA 2019. Mother had breast cancer. Sugars uncontrolled, HbA1c 9.4%. Increase Glycomet to 1000 mg BD. Add Tab Januvia 100 mg OD. Cont Ecosprin 75 OD, Atorva 40 HS. Review in 6 weeks with HbA1c.',
    gt: { symptoms: [], diagnoses: [['E11', 'confirmed'], ['I10', 'confirmed'], ['I25.1', 'confirmed']], medications: [['metformin', 1000, 'twice daily', 'increase'], ['sitagliptin', 100, 'once daily', 'start'], ['aspirin', 75, 'once daily', 'continue'], ['atorvastatin', 40, 'at bedtime', 'continue']], labs: [['HbA1c', 9.4]], followUp: { dueDate: '2026-11-12' } },
  },
  {
    text: 'Allergic to penicillin. C/o burning micturition, frequency x 2d. Urine culture sent. Dx: UTI. Tab Niftran 100 BD x 5/7. Avoid amoxicillin. f/u 1/52 with culture report.',
    gt: { symptoms: [['dysuria', false], ['urinary frequency', false]], diagnoses: [['N39.0', 'confirmed']], medications: [['nitrofurantoin', 100, 'twice daily', 'prescribe']], allergies: ['penicillin'], followUp: { dueDate: '2026-10-08' } },
  },
  {
    text: 'Pt c/o vomitting and loose motions since morning, abd pain. Denies fever. Dx AGE. ORS, Tab Ondem 4 mg SOS, Tab Metrogyl 400 TDS x 5 days. Review if not better.',
    gt: { symptoms: [['vomiting', false], ['diarrhoea', false], ['abdominal pain', false], ['fever', true]], diagnoses: [['A09', 'confirmed']], medications: [['oral rehydration salts', null, null, 'prescribe'], ['ondansetron', 4, 'as needed', 'prescribe'], ['metronidazole', 400, 'three times daily', 'prescribe']], followUp: { asNeeded: true } },
  },
  {
    text: 'Asthmatic, on Foracort 200 inhaler BD. Wheeze x 2 days after URTI. SpO2 95%. Typhoid ruled out last week. Add Montair 10 mg HS x 2 wks. Asthalin inhaler SOS. Review after 10 days.',
    gt: { symptoms: [['wheezing', false]], diagnoses: [['J45.9', 'confirmed'], ['J06.9', 'confirmed'], ['A01.0', 'ruled_out']], medications: [['budesonide-formoterol', 200, 'twice daily', 'continue'], ['montelukast', 10, 'at bedtime', 'start'], ['salbutamol', null, 'as needed', 'prescribe']], vitals: [['SpO2', 95]], followUp: { dueDate: '2026-10-11' } },
  },
  {
    text: 'K/c/o hypothyroidism. Fatigue, weight gain, hair fall x 2 months. TSH 11.2. Increase Thyronorm to 75 mcg OD empty stomach. Recheck TSH after 6 wks.',
    gt: { symptoms: [['fatigue', false], ['weight gain', false], ['hair loss', false]], diagnoses: [['E03.9', 'confirmed']], medications: [['levothyroxine', 75, 'once daily', 'increase']], labs: [['TSH', 11.2]], followUp: { dueDate: '2026-11-12' } },
  },
  {
    text: 'BP 168/102, PR 92. Headache and giddiness x 1 wk. No chest pain. Imp: uncontrolled HTN. Stop Amlong. Start Telma 40 mg OD. Review on 15/10/2026 for BP check.',
    gt: { symptoms: [['headache', false], ['dizziness', false], ['chest pain', true]], diagnoses: [['I10', 'confirmed']], medications: [['amlodipine', null, null, 'stop'], ['telmisartan', 40, 'once daily', 'start']], vitals: [['blood pressure', '168/102'], ['pulse', 92]], followUp: { dueDate: '2026-10-15' } },
  },
  {
    text: 'Itchy annular rash over groin and thighs x 3 wks. Likely tinea corporis. Tab Terbicip 250 mg OD x 2 wks, Candid cream BD. No steroid creams. F/u 2/52.',
    gt: { symptoms: [['rash', false], ['itching', false]], diagnoses: [['B35.4', 'provisional']], medications: [['terbinafine', 250, 'once daily', 'prescribe'], ['clotrimazole', null, 'twice daily', 'prescribe']], followUp: { dueDate: '2026-10-15' } },
  },
  {
    text: 'Low back pain after lifting, x 4 days. No numbness, no bladder issues. Mechanical LBP. Tab Zerodol 100 BD x 5 days with Pan 40 OD. Physio advised. Review after 2 weeks.',
    gt: { symptoms: [['back pain', false], ['tingling', true]], diagnoses: [['M54.5', 'confirmed']], medications: [['aceclofenac', 100, 'twice daily', 'prescribe'], ['pantoprazole', 40, 'once daily', 'prescribe']], followUp: { dueDate: '2026-10-15' } },
  },
  {
    text: 'Not taking metformin regularly. FBS 210, PPBS 298. T2DM, poor control. Counselled on compliance. Cont metformin 500 BD. Review in 4 wks.',
    gt: { symptoms: [], diagnoses: [['E11', 'confirmed']], medications: [['metformin', 500, 'twice daily', 'continue']], labs: [['fasting blood sugar', 210], ['post-prandial blood sugar', 298]], followUp: { dueDate: '2026-10-29' } },
  },
  {
    text: 'Hb 8.9 g/dL. C/o tiredness and breathlessness on exertion. Dx: iron deficiency anaemia. Tab Livogen 1 OD x 3 months, Folvite 5 mg OD. Review after 1 month with Hb.',
    gt: { symptoms: [['fatigue', false], ['breathlessness', false]], diagnoses: [['D50.9', 'confirmed']], medications: [['ferrous sulfate', null, 'once daily', 'prescribe'], ['folic acid', 5, 'once daily', 'prescribe']], labs: [['haemoglobin', 8.9]], followUp: { dueDate: '2026-10-31' } },
  },
  {
    text: 'Red eye with watering x 2 days, no blurred vision. Conjunctivitis. Advised hygiene. Review SOS.',
    gt: { symptoms: [['red eye', false], ['blurred vision', true]], diagnoses: [['H10.9', 'confirmed']], medications: [], followUp: { asNeeded: true } },
  },
  {
    text: 'Poor sleep and anxiety for 1 month after job loss. No low mood, no suicidal thoughts. Insomnia. Tab Clonotril 0.25 mg HS x 2 wks. Sleep hygiene discussed. f/u after 14 days.',
    gt: { symptoms: [['poor sleep', false], ['anxiety', false], ['low mood', true]], diagnoses: [['G47.0', 'confirmed']], medications: [['clonazepam', 0.25, 'at bedtime', 'prescribe']], followUp: { dueDate: '2026-10-15' } },
  },
  {
    text: 'Fever with chills and rigors x 5 days, headache. Widal positive. Enteric fever. Tab Taxim-O 200 mg BD x 14 days, PCM 650 SOS. Review after 3 days.',
    gt: { symptoms: [['fever', false], ['chills', false], ['headache', false]], diagnoses: [['A01.0', 'confirmed']], medications: [['cefixime', 200, 'twice daily', 'prescribe'], ['paracetamol', 650, 'as needed', 'prescribe']], labs: [['Widal test', 'positive']], followUp: { dueDate: '2026-10-04' } },
  },
  {
    text: 'Glimepride 2 mg stopped due to hypoglycaemia episodes. Metformn 1000 mg BD continued. HbA1c 6.1. DM2 well controlled. Review after 3 months.',
    gt: { symptoms: [], diagnoses: [['E11', 'confirmed']], medications: [['glimepiride', 2, null, 'stop'], ['metformin', 1000, 'twice daily', 'continue']], labs: [['HbA1c', 6.1]], followUp: { dueDate: '2026-12-30' } },
  },
  {
    text: 'Sneezing, blocked nose and itching every morning x 2 months. Allergic rhinitis. Tab Allegra 120 mg OD x 7 days, Montair 10 HS x 2 wks. Avoid dust. Review SOS.',
    gt: { symptoms: [['sneezing', false], ['nasal congestion', false], ['itching', false]], diagnoses: [['J30.4', 'confirmed']], medications: [['fexofenadine', 120, 'once daily', 'prescribe'], ['montelukast', 10, 'at bedtime', 'prescribe']], followUp: { asNeeded: true } },
  },
  {
    text: 'Productive cough and fever x 5 days, SOB on climbing stairs. SpO2 93%. Crepts right base. LRTI. Tab Augmentin 625 BD x 5 days. Review in 3 days.',
    gt: { symptoms: [['cough', false], ['fever', false], ['breathlessness', false]], diagnoses: [['J22', 'confirmed']], medications: [['amoxicillin-clavulanate', 625, 'twice daily', 'prescribe']], vitals: [['SpO2', 93]], followUp: { dueDate: '2026-10-04' } },
  },
  {
    text: 'Bilateral knee pain, worse on climbing stairs. OA knee. Tab Hifenac 100 mg SOS, Shelcal 500 OD. Quadriceps exercises. Review after 1 month.',
    gt: { symptoms: [['knee pain', false]], diagnoses: [['M17.9', 'confirmed']], medications: [['aceclofenac', 100, 'as needed', 'prescribe'], ['calcium carbonate', 500, 'once daily', 'prescribe']], followUp: { dueDate: '2026-10-31' } },
  },
  {
    text: 'Pain abdomen after meals and acidity x 2 wks. No vomiting, no weight loss, no black stools. GERD. Tab Razo 20 mg OD x 4 wks. Review in 4 weeks.',
    gt: { symptoms: [['abdominal pain', false], ['heartburn', false], ['vomiting', true], ['weight loss', true]], diagnoses: [['K21.9', 'confirmed']], medications: [['rabeprazole', 20, 'once daily', 'prescribe']], followUp: { dueDate: '2026-10-29' } },
  },
];
