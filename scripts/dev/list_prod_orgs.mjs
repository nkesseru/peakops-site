#!/usr/bin/env node
// Read-only — lists all orgs in peakops-pilot project so we can find
// the right org for prod smoke.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

async function main() {
  const orgsSnap = await db.collection("orgs").get();
  for (const org of orgsSnap.docs) {
    const od = org.data() || {};
    const cases = await db.collection(`orgs/${org.id}/recovery_cases`).limit(1).get();
    const incidents = await db.collection(`orgs/${org.id}/incidents`).limit(1).get();
    console.log(`${org.id}  name=${od.name || "(unset)"}  recovery_cases?=${!cases.empty}  incidents?=${!incidents.empty}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
