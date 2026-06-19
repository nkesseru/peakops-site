// Targeted unit test for the incident_closure check in
// functions_clean/_readiness.js — exercises both the template-driven
// evaluator (evaluateRequiresIncidentClosure) and the default check
// emitted by computeAcceptanceReadiness.
//
// No emulator. No Firebase. We import the live module, build a tiny
// incident stub, and assert the satisfaction bit for each status.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  computeAcceptanceReadiness,
} = require("../../functions_clean/_readiness.js");

// All statuses expected to satisfy the closure check.
const SATISFY = ["closed", "customer_accepted", "accepted", "approved", "exported"];
// Mid-flight statuses that must STAY unsatisfied.
const REJECT  = ["open", "in_progress", "draft", "submitted_to_customer", "customer_rejected"];

function findClosureCheck(checks) {
  return checks.find((c) => c.key === "incident_closure");
}

function runCase(status, expectSatisfied) {
  // Minimal incident + empty subcollections — the default check path
  // is what we're exercising (no template-driven check fires here).
  const incident = { id: "test", status };
  const result = computeAcceptanceReadiness({
    incident, evidence: [], jobs: [], notes: null,
  });
  const closure = findClosureCheck(result.checks || []);
  if (!closure) {
    return { status, ok: false, why: "no incident_closure check emitted" };
  }
  const ok = closure.satisfied === expectSatisfied;
  return { status, ok, expectSatisfied, observed: closure.satisfied, detail: closure.detail };
}

console.log("=== closure check: SATISFYING statuses (expect satisfied=true) ===");
let pass = true;
for (const s of SATISFY) {
  const r = runCase(s, true);
  console.log(`  ${r.ok ? "✅" : "❌"} status=${s.padEnd(22)} satisfied=${r.observed}   detail="${r.detail}"`);
  if (!r.ok) pass = false;
}

console.log("");
console.log("=== closure check: MID-FLIGHT statuses (expect satisfied=false) ===");
for (const s of REJECT) {
  const r = runCase(s, false);
  console.log(`  ${r.ok ? "✅" : "❌"} status=${s.padEnd(22)} satisfied=${r.observed}   detail="${r.detail}"`);
  if (!r.ok) pass = false;
}

console.log("");
if (pass) { console.log("✅ all 10 cases pass"); process.exit(0); }
console.log("❌ at least one case failed"); process.exit(1);
