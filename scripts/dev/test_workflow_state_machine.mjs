// PEAKOPS_WORKFLOW_STATE_MACHINE_V1 — Chunk 2: Workflow Completion
// Pure-Node assertion suite for functions_clean/incidentState.js.
//
// Goal: prove that every scenario A/B/C transition the workflow needs
// to support is actually allowed by canTransitionIncident(), and that
// no state is permanently stuck (every non-terminal status has at
// least one outbound edge).
//
// Loud failure if a future refactor walks back a transition the
// pilot workflow depends on.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  INCIDENT_STATUS: S,
  canTransitionIncident,
} = require("/Users/kesserumini/peakops/my-app/functions_clean/incidentState");

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

function assertCan(from, to, label) {
  if (canTransitionIncident(from, to)) {
    pass(`${label}: ${from} → ${to} allowed`);
  } else {
    fail(`${label}: ${from} → ${to} expected ALLOWED but rejected`);
  }
}
function assertCannot(from, to, label) {
  if (!canTransitionIncident(from, to)) {
    pass(`${label}: ${from} → ${to} correctly rejected`);
  } else {
    fail(`${label}: ${from} → ${to} expected REJECTED but allowed`);
  }
}

console.log("=== Scenario A: open → ... → customer_accepted ===");
assertCan(S.OPEN, S.IN_PROGRESS, "A1");
assertCan(S.IN_PROGRESS, S.SUBMITTED_TO_CUSTOMER, "A2 (mint review link)");
assertCan(S.SUBMITTED_TO_CUSTOMER, S.CUSTOMER_ACCEPTED, "A3 (customer accepts)");

console.log("\n=== Scenario A continued: legacy close fallback ===");
assertCan(S.OPEN, S.CLOSED, "Legacy A4: open→closed (pre-126 flow)");
assertCan(S.IN_PROGRESS, S.CLOSED, "Legacy A5: in_progress→closed");
assertCan(S.CLOSED, S.SUBMITTED_TO_CUSTOMER, "Retroactive customer review (PR 126c)");

console.log("\n=== Scenario B: rejection → rework → resubmit → accept ===");
assertCan(S.SUBMITTED_TO_CUSTOMER, S.CUSTOMER_REJECTED, "B1 (customer rejects)");
assertCan(S.CUSTOMER_REJECTED, S.IN_PROGRESS, "B2 (route to rework)");
assertCan(S.CUSTOMER_REJECTED, S.SUBMITTED_TO_CUSTOMER, "B3 (re-send after rework)");
assertCan(S.SUBMITTED_TO_CUSTOMER, S.CUSTOMER_ACCEPTED, "B4 (customer accepts on resubmission)");

console.log("\n=== Scenario B continued: operator revoke before customer acts ===");
assertCan(S.SUBMITTED_TO_CUSTOMER, S.IN_PROGRESS, "B5 (coordinator cancels outstanding link)");

console.log("\n=== Terminal states (must reject every outbound transition except self) ===");
assertCannot(S.CUSTOMER_ACCEPTED, S.IN_PROGRESS, "CUSTOMER_ACCEPTED is terminal");
assertCannot(S.CUSTOMER_ACCEPTED, S.SUBMITTED_TO_CUSTOMER, "CUSTOMER_ACCEPTED is terminal");
assertCannot(S.CUSTOMER_ACCEPTED, S.CUSTOMER_REJECTED, "CUSTOMER_ACCEPTED is terminal");
assertCannot(S.CUSTOMER_ACCEPTED, S.OPEN, "CUSTOMER_ACCEPTED is terminal");
assertCannot(S.CUSTOMER_ACCEPTED, S.CLOSED, "CUSTOMER_ACCEPTED is terminal");
// Self-transition is allowed (idempotent close-out)
assertCan(S.CUSTOMER_ACCEPTED, S.CUSTOMER_ACCEPTED, "CUSTOMER_ACCEPTED self-loop allowed");

console.log("\n=== Closed terminal (legacy) + opt-in retro review ===");
assertCannot(S.CLOSED, S.IN_PROGRESS, "CLOSED rejects in_progress (no edit-after-close)");
assertCannot(S.CLOSED, S.OPEN, "CLOSED rejects open");
assertCannot(S.CLOSED, S.CUSTOMER_ACCEPTED, "CLOSED rejects customer_accepted directly");
assertCannot(S.CLOSED, S.CUSTOMER_REJECTED, "CLOSED rejects customer_rejected directly");
assertCan(S.CLOSED, S.CLOSED, "CLOSED self-loop allowed");

console.log("\n=== No orphan states: every status has at least one outbound edge ===");
const allStates = [S.OPEN, S.IN_PROGRESS, S.SUBMITTED_TO_CUSTOMER, S.CUSTOMER_ACCEPTED, S.CUSTOMER_REJECTED, S.CLOSED];
for (const from of allStates) {
  const outbound = allStates.filter((to) => to !== from && canTransitionIncident(from, to));
  if (outbound.length === 0 && from !== S.CUSTOMER_ACCEPTED) {
    // CUSTOMER_ACCEPTED is the only true terminal (no outbound edges).
    // Every other state must have at least one outbound transition.
    fail(`${from} has ZERO outbound transitions — would create stuck incidents`);
  } else {
    pass(`${from} has ${outbound.length} outbound transition(s): ${outbound.join(", ") || "(terminal)"}`);
  }
}

console.log("\n=== Invalid skip transitions (must reject) ===");
assertCannot(S.OPEN, S.SUBMITTED_TO_CUSTOMER, "skip in_progress → reject");
assertCannot(S.OPEN, S.CUSTOMER_ACCEPTED, "skip to terminal → reject");
assertCannot(S.OPEN, S.CUSTOMER_REJECTED, "skip to terminal → reject");
assertCannot(S.IN_PROGRESS, S.CUSTOMER_ACCEPTED, "skip review → reject");
assertCannot(S.IN_PROGRESS, S.CUSTOMER_REJECTED, "skip review → reject");

if (failed) {
  console.error(`\n❌ workflow state machine: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ workflow state machine: all transitions correct, no orphans, no leaks");
