// Targeted unit test for PEAKOPS_TENANT_ISOLATION_V1 in
// functions_clean/exportIncidentPacketV1.js.
//
// No emulator. No Firebase. No imports beyond fs.
// Pulls the verbatim block out of the live source file and evaluates it
// in an isolated scope with stubbed locals. If the source block ever
// drifts, this test fails to extract or fails to assert — either way,
// drift becomes visible.

import fs from "node:fs";

const SRC_PATH = "functions_clean/exportIncidentPacketV1.js";
const src = fs.readFileSync(SRC_PATH, "utf8");

// Extract from the comment header through the closing brace at 4-space
// indent (the if block's close).
const m = src.match(/\/\/ PEAKOPS_TENANT_ISOLATION_V1[\s\S]*?\n {4}\}\n/);
if (!m) {
  console.error(`FAIL: PEAKOPS_TENANT_ISOLATION_V1 block not found in ${SRC_PATH}`);
  process.exit(1);
}
const block = m[0];

// Build a runner that supplies the locals the block reads. The block
// uses: incSnap, orgId, actorUid, incidentId, j, res, console.
function runBlock(incSnap, orgId, actorUid, incidentId) {
  let captured = null;
  const j = (_res, status, body) => { captured = { status, body }; };
  const res = {};
  const console_ = { warn: () => {} };
  // eslint-disable-next-line no-new-func
  const runner = new Function(
    "incSnap, orgId, actorUid, incidentId, j, res, console",
    block,
  );
  runner(incSnap, orgId, actorUid, incidentId, j, res, console_);
  return captured;
}

// CASE 1 — matching orgIds → no 404; captured stays null.
const c1 = runBlock({ data: () => ({ orgId: "orgA" }) }, "orgA", "uidX", "incId");
const c1Pass = c1 === null;

// CASE 2 — cross-tenant → returns 404 incident_not_found.
const c2 = runBlock({ data: () => ({ orgId: "orgB" }) }, "orgA", "uidX", "incId");
const c2Pass = c2 && c2.status === 404 && c2.body?.error === "incident_not_found";

console.log(`CASE 1 (orgA === orgA, expect pass):  ${c1Pass ? "PASS" : "FAIL"}  captured=${JSON.stringify(c1)}`);
console.log(`CASE 2 (orgA !== orgB, expect 404):   ${c2Pass ? "PASS" : "FAIL"}  captured=${JSON.stringify(c2)}`);

if (c1Pass && c2Pass) { console.log("\n✅ tenant_isolation: both cases pass"); process.exit(0); }
console.log("\n❌ tenant_isolation: one or more cases failed"); process.exit(1);
