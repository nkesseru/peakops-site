#!/usr/bin/env node
// Read-only — lists recovery cases for an org in prod with their state,
// action counts, and packetVersions length so we can pick a safe target
// for the PR 129a prod smoke.
//
// Usage:
//   node scripts/dev/read_prod_recovery_cases.mjs <orgId>
//
// Never writes. Reads with Application Default Credentials.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const [orgId] = process.argv.slice(2);
if (!orgId) {
  console.error("Usage: read_prod_recovery_cases.mjs <orgId>");
  process.exit(2);
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function tsIso(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (v?.toDate) return v.toDate().toISOString();
  return String(v);
}

async function main() {
  const casesSnap = await db
    .collection("orgs").doc(orgId).collection("recovery_cases")
    .limit(50)
    .get();

  if (casesSnap.empty) {
    console.log(`No recovery cases in org=${orgId}`);
    return;
  }

  const rows = [];
  for (const doc of casesSnap.docs) {
    const data = doc.data() || {};
    const id = doc.id;
    const actions = await doc.ref.collection("actions").get();
    let openCount = 0, doneCount = 0, skippedCount = 0;
    const actionDetails = [];
    for (const a of actions.docs) {
      const ad = a.data() || {};
      const s = String(ad.status || "");
      if (s === "done") doneCount += 1;
      else if (s === "skipped") skippedCount += 1;
      else openCount += 1;
      actionDetails.push({ id: a.id, status: s, type: ad.type, title: ad.title });
    }
    rows.push({
      id,
      incidentId: data.incidentId,
      status: data.status,
      cause: data.cause?.primary || "(unset)",
      revenue: data.revenueAtRisk?.amount || 0,
      packetVersions: (data.packetVersions || []).length,
      actions: { total: actions.size, open: openCount, done: doneCount, skipped: skippedCount, details: actionDetails },
      openedAt: tsIso(data.openedAt),
      updatedAt: tsIso(data.updatedAt),
      resolvedAt: tsIso(data.resolvedAt),
    });
  }

  // Sort: non-terminal first, then most recent updates
  const TERM = new Set(["recovered", "partial_recovery", "abandoned", "expired"]);
  rows.sort((a, b) => {
    const ta = TERM.has(a.status) ? 1 : 0;
    const tb = TERM.has(b.status) ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  console.log(`org=${orgId} cases=${rows.length}\n`);
  for (const r of rows) {
    console.log(`${r.id}`);
    console.log(`  incident=${r.incidentId}  status=${r.status}  cause=${r.cause}  $${r.revenue}  pkts=${r.packetVersions}`);
    console.log(`  actions=${r.actions.total} (open=${r.actions.open} done=${r.actions.done} skipped=${r.actions.skipped})`);
    for (const a of r.actions.details) {
      console.log(`    - ${a.id} [${a.status}] ${a.type} — ${a.title}`);
    }
    console.log(`  openedAt=${r.openedAt}  updatedAt=${r.updatedAt}  resolvedAt=${r.resolvedAt || "(n/a)"}`);
    console.log("");
  }
}

main().catch((e) => { console.error("read_prod_recovery_cases failed:", e); process.exit(2); });
