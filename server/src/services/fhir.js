// Export verified encounters as HL7 FHIR R4 resources (a "collection" Bundle),
// the format India's ABDM uses for health record exchange. Identifiers such as
// the phone number are never exported; the raw note is included only on request.
import { SNOMED_BY_ICD, LOINC_BY_LAB, LOINC_BY_VITAL } from '../nlp/lexicon/codes.js';

const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const SNOMED = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const iso = (d) => new Date(d).toISOString();
const day = (d) => new Date(d).toISOString().slice(0, 10);
const UCUM_UNITS = { 'mg/dL': 'mg/dL', '%': '%', 'g/dL': 'g/dL', 'mIU/L': 'm[IU]/L', 'ng/mL': 'ng/mL', 'pg/mL': 'pg/mL', 'mg/L': 'mg/L', mmHg: 'mm[Hg]', bpm: '/min', '°F': '[degF]', '°C': 'Cel', 'breaths/min': '/min', kg: 'kg', 'kg/m²': 'kg/m2' };

function quantity(value, unit) {
  const q = { value: Number(value) };
  if (unit) { q.unit = unit; if (UCUM_UNITS[unit]) { q.system = UCUM; q.code = UCUM_UNITS[unit]; } }
  return q;
}

export function patientResource(p) {
  const [given, ...family] = p.name.split(' ');
  return {
    resourceType: 'Patient',
    id: String(p._id),
    identifier: [{ system: 'urn:cnis:patient-code', value: p.patientCode }],
    name: [{ text: p.name, given: [given], family: family.join(' ') || undefined }],
    gender: p.sex === 'F' ? 'female' : p.sex === 'M' ? 'male' : 'other',
    birthDate: day(p.dob),
    ...(p.synthetic ? { meta: { tag: [{ system: 'urn:cnis:tags', code: 'synthetic', display: 'Synthetic test data' }] } } : {}),
  };
}

export function encounterResources(enc, { includeNote = false } = {}) {
  const x = enc.extraction ?? {};
  const subject = { reference: `Patient/${enc.patientId}` };
  const encRef = { reference: `Encounter/${enc._id}` };
  const out = [{
    resourceType: 'Encounter',
    id: String(enc._id),
    status: 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject,
    period: { start: iso(enc.visitDate) },
  }];

  (x.diagnoses ?? []).forEach((d, i) => {
    const sn = SNOMED_BY_ICD[d.code];
    out.push({
      resourceType: 'Condition',
      id: `${enc._id}-dx-${i}`,
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: d.certainty === 'ruled_out' ? 'inactive' : 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: d.certainty === 'ruled_out' ? 'refuted' : d.certainty === 'provisional' ? 'provisional' : 'confirmed' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: d.context === 'current' ? 'encounter-diagnosis' : 'problem-list-item' }] }],
      code: { coding: [{ system: ICD10, code: d.code, display: d.term }, ...(sn ? [{ system: SNOMED, code: sn[0], display: sn[1] }] : [])], text: d.term },
      subject,
      encounter: encRef,
      recordedDate: iso(enc.visitDate),
    });
  });

  (x.symptoms ?? []).forEach((s, i) => {
    out.push({
      resourceType: 'Observation',
      id: `${enc._id}-sx-${i}`,
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'exam' }] }],
      code: { text: s.term },
      subject, encounter: encRef,
      effectiveDateTime: iso(enc.visitDate),
      valueBoolean: !s.negated,
      ...(s.durationDays ? { note: [{ text: `Duration ${s.durationDays} days` }] } : {}),
    });
  });

  (x.labs ?? []).forEach((l, i) => {
    const ln = LOINC_BY_LAB[l.test];
    out.push({
      resourceType: 'Observation',
      id: `${enc._id}-lab-${i}`,
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      code: { ...(ln ? { coding: [{ system: LOINC, code: ln[0], display: ln[1] }] } : {}), text: l.test },
      subject, encounter: encRef,
      effectiveDateTime: iso(enc.visitDate),
      ...(typeof l.value === 'number' ? { valueQuantity: quantity(l.value, l.unit) } : { valueString: String(l.value) }),
      ...(l.flag && l.flag !== 'normal' ? { interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: l.flag === 'high' ? 'H' : l.flag === 'low' ? 'L' : 'A' }] }] } : {}),
    });
  });

  (x.vitals ?? []).forEach((v, i) => {
    const base = { resourceType: 'Observation', id: `${enc._id}-vital-${i}`, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }], subject, encounter: encRef, effectiveDateTime: iso(enc.visitDate) };
    if (v.name === 'blood pressure' && v.systolic) {
      out.push({ ...base, code: { coding: [{ system: LOINC, code: LOINC_BY_VITAL['blood pressure'][0], display: LOINC_BY_VITAL['blood pressure'][1] }] },
        component: [
          { code: { coding: [{ system: LOINC, code: LOINC_BY_VITAL.systolic[0], display: LOINC_BY_VITAL.systolic[1] }] }, valueQuantity: quantity(v.systolic, 'mmHg') },
          { code: { coding: [{ system: LOINC, code: LOINC_BY_VITAL.diastolic[0], display: LOINC_BY_VITAL.diastolic[1] }] }, valueQuantity: quantity(v.diastolic, 'mmHg') },
        ] });
    } else {
      const ln = LOINC_BY_VITAL[v.name];
      out.push({ ...base, code: { ...(ln ? { coding: [{ system: LOINC, code: ln[0], display: ln[1] }] } : {}), text: v.name }, valueQuantity: quantity(v.value, v.unit) });
    }
  });

  (x.medications ?? []).forEach((m, i) => {
    if (m.negated) return;
    const dosage = [m.dose != null ? `${m.dose} ${m.unit ?? ''}`.trim() : null, m.frequency, m.durationDays ? `for ${m.durationDays} days` : null].filter(Boolean).join(', ');
    out.push({
      resourceType: 'MedicationStatement',
      id: `${enc._id}-med-${i}`,
      status: m.action === 'stop' ? 'stopped' : m.action === 'mention' ? 'unknown' : 'active',
      medicationCodeableConcept: { text: m.generic },
      subject, context: encRef,
      effectiveDateTime: iso(enc.visitDate),
      ...(dosage ? { dosage: [{ text: dosage }] } : {}),
      note: [{ text: `Action at this visit: ${m.action}` }],
    });
  });

  (x.allergies ?? []).forEach((a, i) => {
    out.push({ resourceType: 'AllergyIntolerance', id: `${enc._id}-allergy-${i}`, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { text: a.substance }, patient: subject, encounter: encRef });
  });

  if (x.followUp?.dueDate) {
    out.push({ resourceType: 'Appointment', id: `${enc._id}-followup`, status: 'proposed', description: x.followUp.purpose ?? 'Follow-up visit', start: `${x.followUp.dueDate}T09:00:00Z`, end: `${x.followUp.dueDate}T09:15:00Z`, participant: [{ actor: subject, status: 'needs-action' }] });
  }

  if (includeNote) {
    out.push({ resourceType: 'DocumentReference', id: `${enc._id}-note`, status: 'current', type: { coding: [{ system: LOINC, code: '11488-4', display: 'Consult note' }] }, subject, date: iso(enc.visitDate), context: { encounter: [encRef] }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(enc.rawNote).toString('base64') } }] });
  }
  return out;
}

export function bundle(resources) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: resources.map((r) => ({ fullUrl: `urn:uuid:${r.resourceType}-${r.id}`, resource: r })),
  };
}
