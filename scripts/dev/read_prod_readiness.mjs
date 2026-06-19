#!/usr/bin/env node
// Read-only helper for the PR 108 prod walkthrough.
// Usage: node scripts/dev/read_prod_readiness.mjs <orgId> <incidentId> [--full]
//
// Reads orgs/{orgId}/incidents/{incidentId}.readinessCache from prod
// Firestore (peakops-pilot) via Application Default Credentials. Never
// writes. Falls back to the legacy top-level incidents/{incidentId}
// path if the org-scoped doc doesn't exist.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const args = process.argv.slice(2);
const FULL = args.includes("--full");
const [orgId, incidentId] = args.filter((a) => !a.startsWith("--"));

if (!orgId || !incidentId) {
  console.error("Usage: read_prod_readiness.mjs <orgId> <incidentId> [--full]");
  process.exit(2);
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function fmtTs(v) {
  if (!v) return "<none>";
  if (typeof v === "string") return v;
  if (v?.toDate) return v.toDate().toISOString();
  return String(v);
}

async function read() {
  let path = `orgs/${orgId}/incidents/${incidentId}`;
  let snap = await db.doc(path).get();
  if (!snap.exists) {
    path = `incidents/${incidentId}`;
    snap = await db.doc(path).get();
  }
  if (!snap.exists) {
    console.log(`incident_not_found at either path; org=${orgId} id=${incidentId}`);
    process.exit(1);
  }
  const data = snap.data() || {};
  console.log(`path: ${path}`);
  console.log(`status: ${data.status || "<none>"}`);

  const cache = data.readinessCache;
  if (!cache) {
    console.log("readinessCache: <ABSENT>");
    process.exit(0);
  }

  console.log(`readinessCache.state: ${cache.state}`);
  console.log(`readinessCache.summary: ${JSON.stringify(cache.summary)}`);
  console.log(`readinessCache.generatedAt: ${fmtTs(cache.generatedAt)}`);
  console.log(`readinessCache.cachedAt: ${fmtTs(cache.cachedAt)}`);
  console.log(`readinessCache.checks (${cache.checks?.length || 0}):`);

  for (const c of cache.checks || []) {
    const mark = c.satisfied === true ? "✓" : c.satisfied === false ? "✗" : "?";
    const tier = c.tier === "required" ? "[req]" : "[enc]";
    console.log(`  ${mark} ${tier} ${c.key.padEnd(48)} ${c.label}  — ${c.detail || ""}`);
  }

  if (FULL) {
    console.log("---raw---");
    console.log(JSON.stringify(cache, null, 2));
  }
}

read().catch((e) => { console.error("read failed:", e?.message || e); process.exit(1); });
