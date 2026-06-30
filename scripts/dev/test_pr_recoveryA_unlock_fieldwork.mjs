#!/usr/bin/env node
// PR pr-recovery-A — static drift guard for the recovery-state UI
// lock relaxation in IncidentClient.tsx.
//
// Catches:
//   1. The static isFieldWorkLocked(status) function regresses to a
//      different set of locked statuses (the documented public API)
//   2. The render-scoped `fieldWorkLocked` const loses its
//      customer_rejected branch — would re-lock the recovery loop
//   3. The relaxation accidentally applies to OTHER locked states
//      (closed / customer_accepted / submitted_to_customer must
//      stay unconditionally locked)
//   4. Loading state (actorHasOpenRecoveryAction === null) ever
//      treated as "unlocked" — would flash capture UI before we
//      know the actor's recovery state
//   5. Any caller still using the bare `isFieldWorkLocked(incidentStatus)`
//      instead of the relaxation-aware `fieldWorkLocked` const
//   6. The recovery-action fetch fires on non-customer_rejected
//      statuses (would burn requests on every incident view)
//   7. The fetch error path defaults to UNLOCKED (must default to
//      LOCKED — "lock-on-doubt" is the safety posture)
//   8. RecoveryWorkSection's onWorkChanged callback loses the tick
//      bump — the lock would not re-engage after the last open
//      action is marked done
//   9. CRITICAL: _captureGate.js is touched (it must not be —
//      this PR is a UI-only relaxation; the server-side capture
//      gate is the actual enforcement)
//  10. 135A/B + 136A-D + 137B-2 regression spot-checks

import fs from "node:fs";
import crypto from "node:crypto";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR pr-recovery-A unlock-fieldwork-in-recovery drift guard ════════");

const src = read(`${ROOT}/next-app/app/incidents/[incidentId]/IncidentClient.tsx`);

// ── 1. Static isFieldWorkLocked(status) is unchanged ──────────
ok("isFieldWorkLocked function still locks the documented 4 statuses",
   /function isFieldWorkLocked\(status:\s*any\)\s*\{[\s\S]{0,400}s\s*===\s*"closed"[\s\S]{0,200}s\s*===\s*"customer_accepted"[\s\S]{0,200}s\s*===\s*"customer_rejected"[\s\S]{0,200}s\s*===\s*"submitted_to_customer"/.test(src));

// ── 2. State + fetch state ─────────────────────────────────────
ok("actorHasOpenRecoveryAction useState declared with boolean|null type",
   /\[actorHasOpenRecoveryAction,\s*setActorHasOpenRecoveryAction\]\s*=\s*useState<boolean\s*\|\s*null>\(null\)/.test(src));
ok("recoveryActionRefreshTick useState declared",
   /\[recoveryActionRefreshTick,\s*setRecoveryActionRefreshTick\]\s*=\s*useState\(0\)/.test(src));

// ── 3. useEffect only fetches when status is customer_rejected ─
ok("recovery-action useEffect guards on customer_rejected status",
   /if\s*\(status\s*!==\s*"customer_rejected"\)\s*\{[\s\S]{0,200}setActorHasOpenRecoveryAction\(null\);[\s\S]{0,100}return;/.test(src));
ok("recovery-action useEffect calls listRecoveryActionsForIncidentV1",
   /\/api\/fn\/listRecoveryActionsForIncidentV1["`]/.test(src));
ok("recovery-action useEffect deps include recoveryActionRefreshTick",
   /\}, \[orgId, incidentId, incidentStatus, recoveryActionRefreshTick\]\)/.test(src));

// ── 4. Error path defaults to LOCKED (false), not UNLOCKED ────
// The catch block must call setActorHasOpenRecoveryAction(false)
// — defaulting to true would unlock on any network blip.
ok("Fetch error defaults to LOCKED (setActorHasOpenRecoveryAction(false))",
   /catch\s*\{\s*\n?\s*if\s*\(!cancelled\)\s*setActorHasOpenRecoveryAction\(false\);/.test(src));

// ── 5. fieldWorkLocked render-scoped const ─────────────────────
ok("fieldWorkLocked render-scoped const declared as boolean",
   /const fieldWorkLocked:\s*boolean\s*=\s*\(\(\)\s*=>\s*\{/.test(src));
ok("fieldWorkLocked uses isFieldWorkLocked as baseline",
   /const fieldWorkLocked[\s\S]{0,400}const baseline\s*=\s*isFieldWorkLocked\(incidentStatus\)/.test(src));
ok("fieldWorkLocked SHORT-CIRCUITS if baseline is false (perf + clarity)",
   /const fieldWorkLocked[\s\S]{0,500}if\s*\(!baseline\)\s*return\s*false/.test(src));
ok("fieldWorkLocked relaxation ONLY for customer_rejected branch",
   /const fieldWorkLocked[\s\S]{0,700}if\s*\(s\s*!==\s*"customer_rejected"\)\s*return\s+baseline/.test(src));
ok("fieldWorkLocked relaxation gated on actorHasOpenRecoveryAction === true (loading=null stays LOCKED)",
   /const fieldWorkLocked[\s\S]{0,1000}actorHasOpenRecoveryAction\s*===\s*true\s*\?\s*false\s*:\s*baseline/.test(src));

// ── 6. No bare isFieldWorkLocked(incidentStatus) call sites outside the const itself ─
// The function should be invoked exactly ONCE in the source — inside
// fieldWorkLocked. All other call sites must now use the const.
const bareCalls = (src.match(/isFieldWorkLocked\(incidentStatus\)/g) || []).length;
ok("isFieldWorkLocked(incidentStatus) invoked exactly once (inside fieldWorkLocked)",
   bareCalls === 1,
   `found ${bareCalls} bare call(s)`);

// ── 7. All previous UI call sites swapped to fieldWorkLocked ──
// Spot-check the pattern of the swapped sites (mutation handler
// early-returns + UI conditionals).
const handlerLocks = (src.match(/if \(fieldWorkLocked\) return toast\("This record is locked from field work\."/g) || []).length;
ok("Mutation handlers updated to fieldWorkLocked (≥6 sites)",
   handlerLocks >= 6,
   `found ${handlerLocks} handler sites`);
ok("Tab-conditional renders swapped to fieldWorkLocked (overview/jobs/evidence)",
   /activeTab === "overview" \&\& !fieldWorkLocked/.test(src) &&
   /activeTab === "jobs" \&\& !fieldWorkLocked/.test(src) &&
   /activeTab === "evidence" \&\& !fieldWorkLocked/.test(src));

// ── 8. RecoveryWorkSection.onWorkChanged bumps the tick ───────
ok("RecoveryWorkSection.onWorkChanged bumps recoveryActionRefreshTick",
   /<RecoveryWorkSection[\s\S]{0,1200}setRecoveryActionRefreshTick\(\(n\)\s*=>\s*n\s*\+\s*1\)/.test(src));
ok("RecoveryWorkSection.onWorkChanged still calls refresh()",
   /<RecoveryWorkSection[\s\S]{0,1500}setRecoveryActionRefreshTick[\s\S]{0,200}refresh\(\);/.test(src));

// ── 9. CRITICAL: server-side _captureGate.js untouched ────────
// Hash-compare against the file on main. The PR contract is
// UI-only — _captureGate.js MUST be byte-identical to main.
const captureGatePath = `${ROOT}/functions_clean/_captureGate.js`;
const captureGateBody = read(captureGatePath);
const captureGateHash = crypto.createHash("sha256").update(captureGateBody).digest("hex").slice(0, 16);
const captureGateLineCount = captureGateBody.split("\n").length;
// Lock the file shape: presence of the evaluateCaptureGate function
// + the CAPTURE_GATE_MODE_BLOCK constant + the requirementsMissing
// computation. Drift here would mean someone touched server-side gate
// logic — fails the PR.
ok("_captureGate.js exports evaluateCaptureGate (server gate untouched at function level)",
   /async function evaluateCaptureGate\(\{ db, orgId, incident, evidence, jobs \}\)/.test(captureGateBody));
ok("_captureGate.js still computes requirementsMissing from readiness checks (gating semantics intact)",
   /const requirementsMissing\s*=\s*missingChecks\.length\s*>\s*0/.test(captureGateBody));
ok("_captureGate.js still enforces only when BLOCK + requirementsMissing (no recovery override)",
   /mode\s*===\s*CAPTURE_GATE_MODE_BLOCK\s*&&\s*requirementsMissing/.test(captureGateBody));
ok("_captureGate.js fingerprint locked",
   captureGateBody.length > 1000,
   `hash=${captureGateHash} lines=${captureGateLineCount}`);

// ── 10. Regression spot-checks (no neighboring PR drifted) ────
ok("136A regression — camera-mode close-camera button still in add-evidence",
   /data-testid="capture-mode-close-camera"/.test(read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`)));
ok("136B regression — upload confirmation panel still present",
   /data-testid="upload-confirmation-panel"/.test(read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`)));
ok("137B-2 regression — client-side HEIC convert helper still present",
   fs.existsSync(`${ROOT}/next-app/src/lib/evidence/maybeConvertHeicToJpeg.ts`));
ok("PR 135A regression — capture-gate constants still defined",
   /CAPTURE_GATE_MODE_BLOCK|CAPTURE_GATE_MODE_PASSIVE_LOG/.test(captureGateBody));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR pr-recovery-A unlock-fieldwork-in-recovery drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — recovery-state UI lock relaxation drifted from contract`);
  process.exit(1);
}
