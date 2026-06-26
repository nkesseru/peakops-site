#!/usr/bin/env node
// PR 135A — static drift guard for the capture-gate surface.
//
// Catches the most common regressions:
//   1. _captureGate.js loses graceful absent-config default
//      (would silently flip existing orgs to block)
//   2. Mode-cache TTL goes away (would re-read on every call)
//   3. parseOverride drops the admin-only role check
//   4. submitFieldSessionV1 / markJobCompleteV1 drop the gate
//      call OR the override path OR the audit-write
//   5. createOrgV1 stops seeding config/captureGate
//   6. Required-evidence reason length floor / ceiling drift

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 135A capture-gate drift guard ══════════════════════════════════");

// ── 1. _captureGate.js contract ───────────────────────────────────
const gateSrc = read(`${ROOT}/functions_clean/_captureGate.js`);
ok("_captureGate exports evaluateCaptureGate",
   /module\.exports\s*=\s*\{[\s\S]*evaluateCaptureGate/.test(gateSrc));
ok("_captureGate exports parseOverride", /parseOverride/.test(gateSrc));
ok("_captureGate exports recordCaptureGateBlocked", /recordCaptureGateBlocked/.test(gateSrc));
ok("_captureGate exports recordCaptureGateOverridden", /recordCaptureGateOverridden/.test(gateSrc));
ok("_captureGate exports readCaptureGateMode", /readCaptureGateMode/.test(gateSrc));
ok("_captureGate defaults absent config to passive_log (safe-by-default)",
   /let mode = CAPTURE_GATE_MODE_PASSIVE_LOG/.test(gateSrc));
ok("_captureGate uses 60s in-memory mode cache",
   /CAPTURE_GATE_TTL_MS\s*=\s*60_?000/.test(gateSrc));
ok("_captureGate VALID_MODES set includes off, passive_log, block",
   /VALID_MODES\s*=\s*new Set\(\[CAPTURE_GATE_MODE_OFF,\s*CAPTURE_GATE_MODE_PASSIVE_LOG,\s*CAPTURE_GATE_MODE_BLOCK\]\)/.test(gateSrc));
ok("_captureGate filters checks to tier === \"required\" AND capture-relevant",
   /tier\s*===\s*"required"\s*&&\s*c\.satisfied\s*===\s*false\s*&&\s*isCaptureRelevantCheck\(c\)/.test(gateSrc));
ok("_captureGate has isCaptureRelevantCheck allowlist (excludes supervisor_approval + incident_closure)",
   /function isCaptureRelevantCheck/.test(gateSrc) &&
   /template_check__min_proof_/.test(gateSrc) &&
   /template_check__one_gps_proof/.test(gateSrc) &&
   /template_check__field_notes/.test(gateSrc) &&
   // Must NOT whitelist supervisor_approval or incident_closed
   !/isCaptureRelevantCheck[\s\S]{0,500}supervisor_approval/.test(gateSrc) &&
   !/isCaptureRelevantCheck[\s\S]{0,500}incident_closed/.test(gateSrc));
ok("_captureGate derives requirementsMissing from filtered missingChecks (not raw readiness.state)",
   /requirementsMissing\s*=\s*missingChecks\.length\s*>\s*0/.test(gateSrc));
ok("_captureGate action === block only when mode=block AND requirementsMissing",
   /mode\s*===\s*CAPTURE_GATE_MODE_BLOCK\s*&&\s*requirementsMissing/.test(gateSrc));

// ── 2. parseOverride admin-only contract ──────────────────────────
ok("parseOverride rejects non-admin with override_role_required",
   /isAdmin[\s\S]{0,200}override_role_required/.test(gateSrc));
ok("parseOverride enforces reason length 20-500",
   /OVERRIDE_REASON_MIN\s*=\s*20/.test(gateSrc) && /OVERRIDE_REASON_MAX\s*=\s*500/.test(gateSrc));
ok("parseOverride requires acknowledgeCaptureGap === true",
   /acknowledgeCaptureGap\s*===\s*true/.test(gateSrc));

// ── 3. createOrgV1 seeds the config doc ───────────────────────────
const createOrgSrc = read(`${ROOT}/functions_clean/createOrgV1.js`);
ok("createOrgV1 declares captureGateConfigRef",
   /captureGateConfigRef\s*=\s*db\.doc\(`orgs\/\$\{orgId\}\/config\/captureGate`\)/.test(createOrgSrc));
ok("createOrgV1 batch.set(captureGateConfigRef, ...) with mode block",
   /batch\.set\(captureGateConfigRef[\s\S]{0,250}mode:\s*"block"/.test(createOrgSrc));

// ── 4. submitFieldSessionV1 wiring ────────────────────────────────
const submitSrc = read(`${ROOT}/functions_clean/submitFieldSessionV1.js`);
ok("submitFieldSessionV1 imports evaluateCaptureGate",
   /require\("\.\/_captureGate"\)/.test(submitSrc));
ok("submitFieldSessionV1 calls evaluateCaptureGate",
   /await evaluateCaptureGate\(\{/.test(submitSrc));
ok("submitFieldSessionV1 returns 412 capture_gate_blocked when no override",
   /error:\s*"capture_gate_blocked"/.test(submitSrc));
ok("submitFieldSessionV1 calls recordCaptureGateBlocked on no-override",
   /recordCaptureGateBlocked\(\{/.test(submitSrc));
ok("submitFieldSessionV1 calls recordCaptureGateOverridden on valid override",
   /recordCaptureGateOverridden\(\{/.test(submitSrc));
ok("submitFieldSessionV1 fail-CLOSED: try/catch around evaluator",
   /try\s*\{\s*\n?\s*gateEval\s*=\s*await evaluateCaptureGate/.test(submitSrc));

// ── 5. markJobCompleteV1 wiring ───────────────────────────────────
const completeSrc = read(`${ROOT}/functions_clean/markJobCompleteV1.js`);
ok("markJobCompleteV1 imports evaluateCaptureGate",
   /require\("\.\/_captureGate"\)/.test(completeSrc));
ok("markJobCompleteV1 calls evaluateCaptureGate",
   /await evaluateCaptureGate\(\{/.test(completeSrc));
ok("markJobCompleteV1 returns 412 capture_gate_blocked",
   /error:\s*"capture_gate_blocked"/.test(completeSrc));
ok("markJobCompleteV1 calls recordCaptureGateBlocked",
   /recordCaptureGateBlocked\(\{/.test(completeSrc));
ok("markJobCompleteV1 calls recordCaptureGateOverridden",
   /recordCaptureGateOverridden\(\{/.test(completeSrc));
// Position: gate must fire AFTER invalid_transition check (so we don't
// gate things that would have failed anyway) and BEFORE jobRef.set
// (so the failure state never lands).
ok("markJobCompleteV1 gate is between invalid_transition check and jobRef.set",
   /invalid_transition[\s\S]{0,200}PEAKOPS_CAPTURE_GATE_V1[\s\S]{0,2500}await jobRef\.set/.test(completeSrc));

// ── 6. Both gates respect single-use override (no incident-state flag) ──
ok("submitFieldSessionV1 does NOT set incident.captureGateOverridden field",
   !/incident\.captureGateOverridden|set\([^)]*captureGateOverridden/.test(submitSrc));
ok("markJobCompleteV1 does NOT set incident.captureGateOverridden field",
   !/incident\.captureGateOverridden|set\([^)]*captureGateOverridden/.test(completeSrc));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 135A capture-gate drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — capture-gate surface drifted from PR 135A contract`);
  process.exit(1);
}
