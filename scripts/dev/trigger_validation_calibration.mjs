#!/usr/bin/env node
// PR 133B calibration — fire refreshReadinessCache directly on the
// 4 demo records so the passive validator emits fresh log entries we
// can read. The validator only fires when refreshReadinessCache runs,
// and refreshReadinessCache only runs when an incident mutation hits
// the production code path — so this script is the one-shot trigger
// for observation events outside the normal write paths.
//
// Reads no data; writes only the readinessCache field (which
// refreshReadinessCache does as its primary job). Does NOT write the
// complianceReadiness field because alpha is on `passive_log` mode,
// not `passive_persist`.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

admin.initializeApp({ projectId: "peakops-pilot" });

const { refreshReadinessCache } = require("/Users/kesserumini/peakops/my-app/functions_clean/_readiness.js");

const ORG = "peakops-internal-alpha";
const INCIDENTS = [
  "demo_field_work_001",        // SPEC.A — DIRS stripped → expect not_evaluated
  "demo_rejected_001",          // SPEC.B — DIRS stripped → expect not_evaluated
  "demo_20260616T122606Z_5ax3", // Northgate — DIRS populated → expect clear
  "demo_draft_001",             // SPEC.C — untouched DIRS → expect issues_blocking (control)
];

for (const incidentId of INCIDENTS) {
  process.stdout.write(`  ▸ ${incidentId}  `);
  const t0 = Date.now();
  try {
    const r = await refreshReadinessCache({ orgId: ORG, incidentId });
    console.log(`done (${Date.now() - t0}ms) state=${r?.state || "(null)"}`);
  } catch (e) {
    console.log(`FAIL — ${e?.message || e}`);
  }
}

console.log("\nDone. Wait 2–3s, then read logs:");
console.log("  gcloud logging read 'textPayload:\"compliance_check\"' --project=peakops-pilot --freshness=2m");
process.exit(0);
