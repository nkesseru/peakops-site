#!/usr/bin/env node
// PR 133B — static drift guard for the compliance UI helpers.
//
// next-app has no jest/vitest runner and the helpers are TypeScript,
// so this is a structural source check rather than a runtime unit
// test. It catches the most common regressions:
//
//   1. CODE_DICTIONARY going out of sync with the live DIRS rulepack
//      (every rule code in functions_clean/_complianceRulepacks/dirs/v1.json
//      must have a matching dictionary entry with title/explanation)
//   2. deriveChipState losing its blocking/warning branches
//   3. severityCopy losing its ERROR/WARN/INFO label mapping
//   4. ComplianceGuardModal losing its admin-only override input + the
//      reason-length minimum
//   5. SendToCustomerModal losing its 412 compliance_block recognition
//
// Static checks are deliberately conservative — they assert presence
// of identifiable patterns. If you intentionally refactor any of the
// scanned files, update this guard in the same PR.

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ Compliance UI drift guard ════════════════════════════════════════");

// ── 1. Dictionary parity with live DIRS rulepack ──────────────────
const rulepack = JSON.parse(read(`${ROOT}/functions_clean/_complianceRulepacks/dirs/v1.json`));
const ruleCodes = (rulepack.rules || []).map((r) => r.code);
const evidenceCodes = (rulepack.evidenceRequirements || []).map((r) => r.code);
const allLiveCodes = [...ruleCodes, ...evidenceCodes];

const copySource = read(`${ROOT}/next-app/lib/compliance/complianceCopy.ts`);
for (const code of allLiveCodes) {
  ok(
    `CODE_DICTIONARY has entry for ${code}`,
    copySource.includes(`"${code}"`),
    "verifies dictionary stays in sync with rulepack v1.json"
  );
}

// Synthetic codes the backend emits that the UI must also recognize.
for (const code of ["acceptance.requirements_missing", "required_field_missing"]) {
  ok(`CODE_DICTIONARY has entry for synthetic code ${code}`, copySource.includes(`"${code}"`));
}

// ── 2. deriveChipState branches ───────────────────────────────────
ok("deriveChipState exported", /export function deriveChipState/.test(copySource));
ok("deriveChipState has blocking branch", /state: "blocking"/.test(copySource));
ok("deriveChipState has warning branch", /state: "warning"/.test(copySource));
ok("deriveChipState has ready branch", /state: "ready"/.test(copySource));
ok("deriveChipState has unknown branch", /state: "unknown"/.test(copySource));
ok("deriveChipState uses blockerCount in label", /blocker/i.test(copySource));
ok("deriveChipState uses warningCount in label", /warning/i.test(copySource));

// ── 3. severityCopy mapping ────────────────────────────────────────
ok("severityCopy maps ERROR → BLOCKING / red",
   /ERROR.*BLOCKING.*red|"BLOCKING".*"red"/s.test(copySource));
ok("severityCopy maps WARN → WARNING / amber",
   /WARN.*WARNING.*amber|"WARNING".*"amber"/s.test(copySource));
ok("severityCopy maps INFO → INFO / blue",
   /INFO.*INFO.*blue|"INFO".*"blue"/s.test(copySource));

// ── 4. ComplianceGuardModal contract ──────────────────────────────
const guardSource = read(`${ROOT}/next-app/components/ComplianceGuardModal.tsx`);
ok("ComplianceGuardModal exported", /export function ComplianceGuardModal/.test(guardSource));
ok("ComplianceGuardModal has admin check", /isAdmin\s*=\s*actorRole/.test(guardSource));
ok("ComplianceGuardModal has reason length floor REASON_MIN", /REASON_MIN\s*=\s*\d+/.test(guardSource));
ok("ComplianceGuardModal has reason length ceiling REASON_MAX", /REASON_MAX\s*=\s*\d+/.test(guardSource));
ok("ComplianceGuardModal renders nonadmin block", /data-testid="compliance-guard-nonadmin"/.test(guardSource));
ok("ComplianceGuardModal renders admin override block", /data-testid="compliance-guard-override"/.test(guardSource));
ok("ComplianceGuardModal override input is disabled until reason is valid",
   /disabled=\{[^}]*!reasonValid/.test(guardSource));

// ── 5. SendToCustomerModal 412 recognition ────────────────────────
const sendSource = read(`${ROOT}/next-app/app/incidents/[incidentId]/summary/SendToCustomerModal.tsx`);
ok("SendToCustomerModal recognizes 412 status", /res\.status\s*===\s*412/.test(sendSource));
ok("SendToCustomerModal recognizes compliance_block error", /"compliance_block"/.test(sendSource));
ok("SendToCustomerModal renders compliance_block step", /step\.kind\s*===\s*"compliance_block"/.test(sendSource));
ok("SendToCustomerModal forwards acknowledgeViolations", /acknowledgeViolations/.test(sendSource));
ok("SendToCustomerModal forwards violationAcknowledgmentReason", /violationAcknowledgmentReason/.test(sendSource));
ok("SendToCustomerModal disables override submit on bad length",
   /OVERRIDE_REASON_MIN|REASON_MIN/.test(sendSource));

// ── 6. SummaryClient wiring ───────────────────────────────────────
const summarySource = read(`${ROOT}/next-app/app/incidents/[incidentId]/summary/SummaryClient.tsx`);
ok("SummaryClient imports ComplianceFindingsPanel", /ComplianceFindingsPanel/.test(summarySource));
ok("SummaryClient imports ComplianceGuardModal", /ComplianceGuardModal/.test(summarySource));
ok("SummaryClient renders ComplianceFindingsPanel", /<ComplianceFindingsPanel/.test(summarySource));
ok("SummaryClient renders ComplianceGuardModal", /<ComplianceGuardModal/.test(summarySource));
ok("SummaryClient pre-flight gate calls maybeBlockOnPreflight", /maybeBlockOnPreflight/.test(summarySource));
ok("SummaryClient export handler recognizes 412 compliance_block",
   /status\s*===\s*412[\s\S]{0,180}compliance_block/.test(summarySource));
ok("SummaryClient forwards override fields in export body",
   /acknowledgeViolations[\s\S]{0,180}violationAcknowledgmentReason/.test(summarySource));
ok("SummaryClient gates send-to-customer via openSendToCustomerWithGuard",
   /openSendToCustomerWithGuard/.test(summarySource));
ok("SummaryClient passes actorRole into SendToCustomerModal",
   /<SendToCustomerModal[\s\S]{0,300}actorRole=/.test(summarySource));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 133B compliance UI drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — UI surface drifted from PR 133B contract`);
  process.exit(1);
}
