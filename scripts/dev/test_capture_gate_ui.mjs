#!/usr/bin/env node
// PR 135B — static drift guard for the capture-gate UI surface.
//
// Catches:
//   1. UI-side isCaptureRelevantCheck drifts from server-side
//      whitelist in functions_clean/_captureGate.js
//   2. CaptureGateNotice loses admin-only override gating
//   3. IncidentClient / JobDetailClient drop the wire-in
//      (notice render, disable predicate, override-flow in body)
//   4. 412 capture_gate_blocked defensive handler removed
//   5. The two surfaces use postJson (which throws and swallows 412)
//      instead of authedFetch for the gated calls

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 135B capture-gate UI drift guard ═══════════════════════════════");

// ── 1. UI-side filter is BYTE-aligned with server-side filter ────
const serverGate = read(`${ROOT}/functions_clean/_captureGate.js`);
const clientGate = read(`${ROOT}/next-app/lib/captureGate/captureGateClient.ts`);

const SERVER_KEYS = [
  "template_check__min_proof_",
  "template_check__one_gps_proof",
  "template_check__field_notes",
];
for (const k of SERVER_KEYS) {
  ok(`server _captureGate.js whitelists "${k}"`, serverGate.includes(k));
  ok(`client captureGateClient.ts whitelists "${k}"`, clientGate.includes(k));
}
ok("client predicate is named isCaptureRelevantCheck",
   /export function isCaptureRelevantCheck/.test(clientGate));
ok("client exports captureGateShouldDisable",
   /export function captureGateShouldDisable/.test(clientGate));
ok("client exports captureRelevantMissing",
   /export function captureRelevantMissing/.test(clientGate));

// ── 2. CaptureGateNotice contract ────────────────────────────────
const noticeSrc = read(`${ROOT}/next-app/components/CaptureGateNotice.tsx`);
ok("CaptureGateNotice exported", /export function CaptureGateNotice/.test(noticeSrc));
ok("CaptureGateNotice gates admin override on actorRole",
   /actorRole\s*===\s*"owner"\s*\|\|\s*actorRole\s*===\s*"admin"/.test(noticeSrc));
ok("CaptureGateNotice has data-testid \"capture-gate-notice\"",
   /data-testid="capture-gate-notice"/.test(noticeSrc));
ok("CaptureGateNotice has data-testid \"capture-gate-admin-override\"",
   /data-testid="capture-gate-admin-override"/.test(noticeSrc));
ok("CaptureGateNotice has data-testid \"capture-gate-nonadmin-msg\"",
   /data-testid="capture-gate-nonadmin-msg"/.test(noticeSrc));
ok("CaptureGateNotice enforces reason length 20-500",
   /REASON_MIN\s*=\s*20/.test(noticeSrc) && /REASON_MAX\s*=\s*500/.test(noticeSrc));
ok("CaptureGateNotice surfaces ackError === override_reason_invalid",
   /override_reason_invalid/.test(noticeSrc));
ok("CaptureGateNotice prefers serverMissing over cached readiness when present",
   /serverMissing\s*&&\s*serverMissing\.length\s*>\s*0/.test(noticeSrc));
ok("CaptureGateNotice renders nothing when missing.length === 0",
   /if\s*\(missing\.length\s*===\s*0\)\s*return null/.test(noticeSrc));

// ── 3. IncidentClient wiring ─────────────────────────────────────
const incClient = read(`${ROOT}/next-app/app/incidents/[incidentId]/IncidentClient.tsx`);
ok("IncidentClient imports CaptureGateNotice", /CaptureGateNotice/.test(incClient));
ok("IncidentClient imports captureGateShouldDisable", /captureGateShouldDisable/.test(incClient));
ok("IncidentClient declares incidentReadinessCache state",
   /\[incidentReadinessCache,\s*setIncidentReadinessCache\]\s*=\s*useState/.test(incClient));
ok("IncidentClient declares captureGateOverride state",
   /\[captureGateOverride,\s*setCaptureGateOverride\]\s*=\s*useState/.test(incClient));
ok("IncidentClient populates incidentReadinessCache from getIncidentV1",
   /setIncidentReadinessCache\(inc\?\.doc\?\.readinessCache\s*\|\|\s*null\)/.test(incClient));
ok("IncidentClient renders <CaptureGateNotice action=\"submit_field_session\"",
   /<CaptureGateNotice[\s\S]{0,250}action="submit_field_session"/.test(incClient));
ok("IncidentClient passes onOverrideChange callback to notice",
   /<CaptureGateNotice[\s\S]{0,500}onOverrideChange=\{setCaptureGateOverride\}/.test(incClient));
ok("IncidentClient submit button disabled by capture gate unless override",
   /captureGateShouldDisable\(incidentReadinessCache\)\s*&&\s*!captureGateOverride/.test(incClient));
ok("IncidentClient submit body adds acknowledgeCaptureGap on override",
   /acknowledgeCaptureGap\s*=\s*true[\s\S]{0,200}captureGapReason/.test(incClient));
ok("IncidentClient submit uses authedFetch (not postJson) to inspect 412",
   /authedFetch\("\/api\/fn\/submitFieldSessionV1"/.test(incClient));
ok("IncidentClient surfaces capture_gate_blocked 412 to notice via serverMissing",
   /capture_gate_blocked[\s\S]{0,400}setCaptureGateServerMissing/.test(incClient));

// ── 4. JobDetailClient wiring ────────────────────────────────────
const jobClient = read(`${ROOT}/next-app/app/jobs/[jobId]/JobDetailClient.tsx`);
ok("JobDetailClient imports CaptureGateNotice", /CaptureGateNotice/.test(jobClient));
ok("JobDetailClient imports captureGateShouldDisable", /captureGateShouldDisable/.test(jobClient));
ok("JobDetailClient declares captureGateOverride state",
   /\[captureGateOverride,\s*setCaptureGateOverride\]\s*=\s*useState/.test(jobClient));
ok("JobDetailClient renders <CaptureGateNotice action=\"mark_job_complete\"",
   /<CaptureGateNotice[\s\S]{0,250}action="mark_job_complete"/.test(jobClient));
ok("JobDetailClient passes onOverrideChange callback to notice",
   /<CaptureGateNotice[\s\S]{0,500}onOverrideChange=\{setCaptureGateOverride\}/.test(jobClient));
ok("JobDetailClient Mark Complete button disabled by capture gate unless override",
   /captureGateShouldDisable\([\s\S]{0,80}\)\s*&&\s*!captureGateOverride/.test(jobClient));
ok("JobDetailClient mark-complete body adds acknowledgeCaptureGap on override",
   /acknowledgeCaptureGap\s*=\s*true[\s\S]{0,200}captureGapReason/.test(jobClient));
ok("JobDetailClient mark-complete uses authedFetch (not postJson) to inspect 412",
   /authedFetch\(`?\/api\/fn\/markJobCompleteV1/.test(jobClient));
ok("JobDetailClient surfaces capture_gate_blocked 412 to notice via serverMissing",
   /capture_gate_blocked[\s\S]{0,400}setCaptureGateServerMissing/.test(jobClient));

// ── 5. Server-side untouched ─────────────────────────────────────
// Spot-check: the PR 135A backend assertions must still hold so this
// PR can't have silently touched the server gate.
ok("Server _captureGate.js still has 60s mode cache",
   /CAPTURE_GATE_TTL_MS\s*=\s*60_?000/.test(serverGate));
ok("Server _captureGate.js still defaults absent config to passive_log",
   /let mode = CAPTURE_GATE_MODE_PASSIVE_LOG/.test(serverGate));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 135B capture-gate UI drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — capture-gate UI surface drifted from PR 135B contract`);
  process.exit(1);
}
