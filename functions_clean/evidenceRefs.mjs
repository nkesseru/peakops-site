import { getFirestore } from "firebase-admin/firestore";

function getDb(db) {
  return db || getFirestore();
}

export function getIncidentRef(db, incidentId) {
  return getDb(db).collection("incidents").doc(String(incidentId));
}

export function getEvidenceCollectionRef(db, incidentId) {
  return getIncidentRef(db, incidentId).collection("evidence_locker");
}

export function getEvidenceDocRef(db, incidentId, evidenceId) {
  return getEvidenceCollectionRef(db, incidentId).doc(String(evidenceId));
}
