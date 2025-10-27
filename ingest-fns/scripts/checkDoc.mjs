// ingest-fns/scripts/checkDoc.mjs
import admin from "firebase-admin";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp(); // uses ADC (gcloud auth) locally or service acct in GCF
const db = getFirestore();

const id = process.argv[2] || "cli-prod-1";
const snap = await db.collection("ingestEmail").doc(id).get();
console.log(snap.exists ? snap.data() : "No doc");
process.exit(0);
