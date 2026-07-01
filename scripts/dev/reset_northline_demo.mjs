#!/usr/bin/env node
// scripts/dev/reset_northline_demo.mjs
// Purges the Northline Fiber demo incident + any recovery state so
// the demo can be re-run cleanly. Preserves org / members / template
// / billing / config / capture-gate / Auth users.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=/Users/kesserumini/peakops/my-app/.secrets/sa.json \
//   node scripts/dev/reset_northline_demo.mjs [--purge-review-links]
//
// Deletes (idempotent, no-ops if missing):
//   - incidents/northline_demo_hh2247                     (top-level twin + all subcollections)
//   - orgs/northline-fiber-services/incidents/<id>        (org-scoped + all subcollections)
//   - orgs/northline-fiber-services/recovery_cases/<any>  where incidentId matches, plus actions/*
//   - Optional (--purge-review-links):
//     customer_review_links/<any>  where orgId === northline-fiber-services
//
// Preserves:
//   - orgs/northline-fiber-services (org doc + demo:true tag)
//   - orgs/.../members/*
//   - orgs/.../templates/*  (Cascade template + starter both preserved)
//   - orgs/.../billing/*
//   - orgs/.../config/*     (capture-gate mode)
//   - Firebase Auth users
//
// SCOPE (safety):
//   Every write path filters strictly on orgId === "northline-fiber-
//   services" OR points at a deterministic docId owned by this demo.
//   Cannot cascade to any other org.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const ORG_ID = "northline-fiber-services";
const INCIDENT_ID = "northline_demo_hh2247";

const args = new Set(process.argv.slice(2));
const purgeReviewLinks = args.has("--purge-review-links");

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

let deletedCount = 0;

async function purgeDocIfExists(docPath, label) {
  const ref = db.doc(docPath);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`  ○ ${label} — not present, skipping`);
    return;
  }
  await db.recursiveDelete(ref);
  deletedCount++;
  console.log(`  ✓ ${label} — deleted (recursive)`);
}

async function purgeRecoveryCases() {
  const q = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", INCIDENT_ID)
    .get();
  if (q.empty) {
    console.log(`  ○ recovery_cases where incidentId=${INCIDENT_ID} — none, skipping`);
    return;
  }
  for (const doc of q.docs) {
    await db.recursiveDelete(doc.ref);
    deletedCount++;
    console.log(`  ✓ orgs/${ORG_ID}/recovery_cases/${doc.id} — deleted (recursive, incl. actions/*)`);
  }
}

async function purgeReviewLinksFn() {
  if (!purgeReviewLinks) {
    console.log(`  ○ customer_review_links — --purge-review-links flag OFF, skipping (expired tokens are inert)`);
    return;
  }
  const q = await db.collection("customer_review_links")
    .where("orgId", "==", ORG_ID)
    .get();
  if (q.empty) {
    console.log(`  ○ customer_review_links where orgId=${ORG_ID} — none, skipping`);
    return;
  }
  for (const doc of q.docs) {
    await doc.ref.delete();
    deletedCount++;
    console.log(`  ✓ customer_review_links/${doc.id} — deleted`);
  }
}

(async () => {
  console.log("── Resetting Northline Fiber demo on peakops-pilot ──\n");
  console.log(`Target org:      orgs/${ORG_ID}`);
  console.log(`Target incident: ${INCIDENT_ID}`);
  console.log(`Purge review links: ${purgeReviewLinks ? "YES (--purge-review-links)" : "no (default)"}`);
  console.log("");

  await purgeDocIfExists(`incidents/${INCIDENT_ID}`, `incidents/${INCIDENT_ID} (legacy top-level twin)`);
  await purgeDocIfExists(`orgs/${ORG_ID}/incidents/${INCIDENT_ID}`, `orgs/${ORG_ID}/incidents/${INCIDENT_ID}`);
  await purgeRecoveryCases();
  await purgeReviewLinksFn();

  console.log("");
  if (deletedCount === 0) {
    console.log("○ Nothing to purge. Reset complete (org / members / templates / billing / config intact).");
  } else {
    console.log(`✅ Reset complete. ${deletedCount} top-level path(s) purged. Org / members / templates / billing / config preserved.`);
  }
  console.log("");
  console.log(`   Next: node scripts/dev/seed_northline_demo.mjs`);
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("RESET FAILED:", e?.message || e);
    if (e?.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  });
