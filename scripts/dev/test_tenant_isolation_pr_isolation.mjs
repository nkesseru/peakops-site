// Drift guard for PEAKOPS_TENANT_ISOLATION_V1 — exportIncidentPacketV1
//
// Chunk 1: Trust Foundation, 2026-06-22 — UPDATED.
// Originally extracted the inline isolation block from the source file
// and re-ran it in a sandbox. The inline block has since been hoisted
// to functions_clean/_authz.js as `assertIncidentBelongsToOrg`. This
// test was rewritten to assert two simpler facts:
//
//   1. exportIncidentPacketV1.js imports the centralized helper.
//   2. exportIncidentPacketV1.js calls the helper with explicit
//      context that includes `fn: "exportIncidentPacketV1"`.
//   3. Mismatch path returns 404 (not 409) and a stable error code.
//
// The helper's own behavior is covered exhaustively by
// scripts/dev/test_tenant_isolation_centralized.mjs. This file
// exists specifically to detect drift on the export endpoint's wiring,
// because export is the most-sensitive cross-tenant attack surface.

import fs from "node:fs";

const SRC_PATH = "/Users/kesserumini/peakops/my-app/functions_clean/exportIncidentPacketV1.js";
const src = fs.readFileSync(SRC_PATH, "utf8");

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

console.log("=== Helper import is present ===");
if (/require\(["']\.\/_authz["']\)/.test(src) && /assertIncidentBelongsToOrg/.test(src)) {
  pass("imports assertIncidentBelongsToOrg from ./_authz");
} else {
  fail("missing assertIncidentBelongsToOrg import from ./_authz");
}

console.log("\n=== Helper is invoked with explicit ctx.fn ===");
// Look for assertIncidentBelongsToOrg(incSnap, orgId, { fn: "exportIncidentPacketV1", ... })
const callPattern = /assertIncidentBelongsToOrg\([^)]*?fn:\s*["']exportIncidentPacketV1["']/s;
if (callPattern.test(src)) {
  pass("assertIncidentBelongsToOrg is called with fn: 'exportIncidentPacketV1'");
} else {
  fail("assertIncidentBelongsToOrg call site missing — or fn: ctx not 'exportIncidentPacketV1'");
}

console.log("\n=== Mismatch returns 404 incident_not_found (not 409 org_mismatch) ===");
// Find the if (!_iso.match) { ... return j(res, 404, ... incident_not_found ... ); } block.
const notFoundReturn = /if\s*\(!\s*_iso\.match\s*\)[\s\S]*?return\s+j\(res,\s*404,[^)]*?incident_not_found/;
if (notFoundReturn.test(src)) {
  pass("404 incident_not_found is returned on mismatch (no existence-leak)");
} else {
  fail("expected 404 incident_not_found return on isolation mismatch — pattern not found");
}

console.log("\n=== No remaining 'org_mismatch' string in export endpoint ===");
if (!/org_mismatch/.test(src)) {
  pass("no org_mismatch literal — endpoint speaks only in 404 incident_not_found");
} else {
  fail("export endpoint still contains 'org_mismatch' literal — leaks existence of foreign incidents");
}

if (failed) {
  console.error(`\n❌ tenant_isolation export-endpoint drift: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ all export-endpoint isolation assertions pass");
