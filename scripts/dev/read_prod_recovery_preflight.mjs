#!/usr/bin/env node
// Read-only preflight for the PR 129a prod smoke target.
// Lists admins for the org and the linked incident's current state
// so we can plan the loop walk.
//
// Usage:
//   node scripts/dev/read_prod_recovery_preflight.mjs <orgId> <caseId>

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const [orgId, caseId] = process.argv.slice(2);
if (!orgId || !caseId) {
  console.error("Usage: read_prod_recovery_preflight.mjs <orgId> <caseId>");
  process.exit(2);
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

async function main() {
  const caseSnap = await db.doc(`orgs/${orgId}/recovery_cases/${caseId}`).get();
  if (!caseSnap.exists) {
    console.error("Case not found.");
    process.exit(3);
  }
  const c = caseSnap.data() || {};
  const incidentId = c.incidentId;

  // Admins / coordinators / supervisors
  const members = await db.collection(`orgs/${orgId}/members`).get();
  const eligible = [];
  for (const m of members.docs) {
    const md = m.data() || {};
    const role = String(md.role || "").toLowerCase();
    if (["owner", "admin", "supervisor", "coordinator"].includes(role)) {
      eligible.push({ uid: m.id, role, displayName: md.displayName || md.name || md.email || "" });
    }
  }

  // Incident — try both canonical and legacy paths
  let incPath = `orgs/${orgId}/incidents/${incidentId}`;
  let incSnap = await db.doc(incPath).get();
  if (!incSnap.exists) {
    incPath = `incidents/${incidentId}`;
    incSnap = await db.doc(incPath).get();
  }
  const inc = incSnap.exists ? (incSnap.data() || {}) : null;

  console.log(`CASE ${caseId}`);
  console.log(`  status=${c.status}  cause.primary=${c.cause?.primary || "(unset)"}`);
  console.log(`  revenueAtRisk=$${c.revenueAtRisk?.amount || 0} (${c.revenueAtRisk?.type || "?"})`);
  console.log(`  packetVersions=${(c.packetVersions || []).length}`);
  console.log(`  incidentId=${incidentId}`);

  console.log(`\nINCIDENT ${incidentId} (${incPath})`);
  if (inc) {
    console.log(`  status=${inc.status || "(unset)"}`);
    console.log(`  title=${inc.title || "(unset)"}`);
    console.log(`  requirements.templateKey=${inc.requirements?.templateKey || "(unset)"}`);
    console.log(`  requirements.templateVersion=${inc.requirements?.templateVersion ?? "(unset)"}`);
    console.log(`  customer=${inc.customer || "(unset)"}`);
  } else {
    console.log(`  (not found)`);
  }

  console.log(`\nELIGIBLE ACTORS (admin / coordinator / supervisor):`);
  for (const e of eligible) {
    console.log(`  - ${e.uid}  (${e.role})  ${e.displayName}`);
  }
}

main().catch((e) => { console.error("preflight failed:", e); process.exit(2); });
