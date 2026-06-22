// PEAKOPS_TENANT_ISOLATION_V1 — centralized helper unit test
// Chunk 1: Trust Foundation, 2026-06-22
//
// Pure-Node test for assertIncidentBelongsToOrg in functions_clean/_authz.js.
// No emulator. No Firebase. No imports beyond the live module.
//
// Exercises every branch:
//   1. Matching orgs → match: true
//   2. Mismatched orgs → match: false (no exception, caller renders 404)
//   3. Legacy doc with no orgId field → match: true (grandfathered)
//   4. Nonexistent snap → match: false
//   5. Null/undefined snap → match: false (no throw)
//
// A test failure here is a security-critical drift signal — fix the
// helper before touching anything else.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const a = require("/Users/kesserumini/peakops/my-app/functions_clean/_authz");

function snap({ exists = true, orgId = null, id = "test-incident" }) {
  return { exists, id, data: () => (orgId == null ? {} : { orgId }) };
}

function check(label, result, expectMatch) {
  const ok = result && result.match === expectMatch;
  console.log(`  ${ok ? "✅" : "❌"} ${label}  match=${result?.match}  expectMatch=${expectMatch}`);
  if (!ok) process.exitCode = 1;
}

// Silence the expected mismatch warning for cleaner test output.
const _origWarn = console.warn;
console.warn = () => {};

console.log("=== CASE 1: matching orgs ===");
check("orgA snap, caller orgA", a.assertIncidentBelongsToOrg(snap({ orgId: "orgA" }), "orgA"), true);

console.log("\n=== CASE 2: mismatched orgs (returns match:false, NEVER throws) ===");
check("orgA snap, caller orgB", a.assertIncidentBelongsToOrg(snap({ orgId: "orgA" }), "orgB"), false);
check("orgB snap, caller orgA", a.assertIncidentBelongsToOrg(snap({ orgId: "orgB" }), "orgA"), false);

console.log("\n=== CASE 3: legacy doc with no orgId field → grandfathered (match:true) ===");
check("no-orgId, caller orgA", a.assertIncidentBelongsToOrg(snap({ orgId: null }), "orgA"), true);
check("empty-orgId, caller orgA", a.assertIncidentBelongsToOrg(snap({ orgId: "" }), "orgA"), true);

console.log("\n=== CASE 4: nonexistent snap ===");
check("exists:false", a.assertIncidentBelongsToOrg(snap({ exists: false }), "orgA"), false);

console.log("\n=== CASE 5: null / undefined snap (must not throw) ===");
check("null snap", a.assertIncidentBelongsToOrg(null, "orgA"), false);
check("undefined snap", a.assertIncidentBelongsToOrg(undefined, "orgA"), false);

console.log("\n=== CASE 6: incidentOrgId returned for caller-side logging ===");
const r6 = a.assertIncidentBelongsToOrg(snap({ orgId: "orgX" }), "orgA");
const ok6 = r6.match === false && r6.incidentOrgId === "orgX";
console.log(`  ${ok6 ? "✅" : "❌"} mismatch returns incidentOrgId for audit: ${JSON.stringify(r6)}`);
if (!ok6) process.exitCode = 1;

console.warn = _origWarn;

if (process.exitCode) {
  console.log("\n❌ tenant_isolation centralized helper FAILED — see above");
  process.exit(process.exitCode);
}
console.log("\n✅ all tenant-isolation assertions pass");
