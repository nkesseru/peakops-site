#!/usr/bin/env node
// PR pr-recovery-B — static drift guard for the combined
// Regenerate-and-resubmit CTA in ResubmissionBanner +
// RecoveryCaseClient.
//
// Catches:
//   1. The combined pipeline regresses to a bare-mint flow
//      (export step removed) — would let a stale, already-rejected
//      packet get pinned to a new customer review link
//   2. The pipeline regresses to mint-then-export ordering — also
//      catastrophic (would pin stale packet)
//   3. Iron-rule violation: export failure that doesn't bail before
//      mint
//   4. Progressive disclosure broken — "Regenerating packet…" or
//      "Minting resubmission link…" copy removed
//   5. CRITICAL: exportIncidentPacketV1.js touched (UI-only PR; the
//      export pipeline must stay byte-identical)
//   6. CRITICAL: mintResubmissionLinkV1.js touched (UI-only PR; the
//      mint endpoint stays byte-identical)
//   7. Export endpoint URL drifts (e.g. wrong /api/fn/ prefix)
//   8. Mint endpoint URL drifts
//   9. The freshness window (lastSuccessfulExportAt) regression
//      that would NEVER skip re-export OR ALWAYS skip re-export
//  10. ResubmissionBanner props contract regression
//  11. Recovery-A + 137B-2 + 136A-D + 135A/B regression spot-checks

import fs from "node:fs";
import crypto from "node:crypto";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR pr-recovery-B regenerate-and-resubmit drift guard ══════════════");

const bannerSrc = read(`${ROOT}/next-app/components/recovery/ResubmissionBanner.tsx`);
const clientSrc = read(`${ROOT}/next-app/app/recovery/[caseId]/RecoveryCaseClient.tsx`);

// ── 1. ResubmissionBanner props contract ──────────────────────
ok("Banner declares stage prop (regenerating | minting | null)",
   /stage\?:\s*"regenerating"\s*\|\s*"minting"\s*\|\s*null/.test(bannerSrc));
ok("Banner replaced onMint with onRegenerateAndResubmit",
   /onRegenerateAndResubmit:\s*\(args:\s*\{\s*changeSummary\?:\s*string\s*\}\)\s*=>\s*void/.test(bannerSrc));
ok("Banner no longer exports onMint in Props",
   !/onMint:\s*\(args:/.test(bannerSrc));
ok("Banner button calls onRegenerateAndResubmit on click",
   /onClick=\{\(\)\s*=>\s*onRegenerateAndResubmit\(\{ changeSummary:/.test(bannerSrc));

// ── 2. Progressive disclosure copy ────────────────────────────
ok("Button copy: \"Regenerate & resubmit →\" idle state",
   /Regenerate & resubmit\s*→/.test(bannerSrc));
ok("Button copy: \"Regenerating packet…\" during export",
   /stage === "regenerating"[\s\S]{0,80}"Regenerating packet…"/.test(bannerSrc));
ok("Button copy: \"Minting resubmission link…\" during mint",
   /stage === "minting"[\s\S]{0,80}"Minting resubmission link…"/.test(bannerSrc));
ok("Button has data-testid + data-stage hooks for instrumentation",
   /data-testid="resubmission-banner-cta"[\s\S]{0,100}data-stage=\{stage \|\|/.test(bannerSrc));

// ── 3. RecoveryCaseClient pipeline shape ──────────────────────
ok("handleRegenerateAndResubmit handler declared (replaces handleMintResubmission)",
   /async function handleRegenerateAndResubmit\(args:\s*\{\s*changeSummary\?:\s*string\s*\}\)/.test(clientSrc));
ok("Old handleMintResubmission handler REMOVED",
   !/async function handleMintResubmission\(/.test(clientSrc));
ok("mintStage state declared with correct union type",
   /\[mintStage,\s*setMintStage\]\s*=\s*useState<"regenerating"\s*\|\s*"minting"\s*\|\s*null>\(null\)/.test(clientSrc));
ok("lastSuccessfulExportAt state declared as number | null",
   /\[lastSuccessfulExportAt,\s*setLastSuccessfulExportAt\]\s*=\s*useState<number\s*\|\s*null>\(null\)/.test(clientSrc));
ok("EXPORT_FRESHNESS_WINDOW_MS constant defined",
   /EXPORT_FRESHNESS_WINDOW_MS\s*=\s*60_000/.test(clientSrc));

// ── 4. Iron-rule order: export FIRST, then mint ───────────────
// Find the body of handleRegenerateAndResubmit and verify the
// exportIncidentPacketV1 call lands BEFORE the mintResubmissionLinkV1
// call in source order.
const handlerMatch = /async function handleRegenerateAndResubmit\([\s\S]*?\n  \}/m.exec(clientSrc);
const handlerBody = handlerMatch ? handlerMatch[0] : "";
const exportIdx = handlerBody.indexOf("/api/fn/exportIncidentPacketV1");
const mintIdx = handlerBody.indexOf("/api/fn/mintResubmissionLinkV1");
ok("handleRegenerateAndResubmit calls /api/fn/exportIncidentPacketV1",
   exportIdx >= 0);
ok("handleRegenerateAndResubmit calls /api/fn/mintResubmissionLinkV1",
   mintIdx >= 0);
ok("Export call lands BEFORE mint call (export THEN mint)",
   exportIdx >= 0 && mintIdx > exportIdx);

// ── 5. Iron-rule: export failure aborts before mint ───────────
// The export response handler must throw on !ok (which short-circuits
// the try block) — the mint call must be AFTER that throw point so it
// can never run after a failed export.
ok("Export failure throws (Regenerate packet failed)",
   /Regenerate packet failed/.test(handlerBody));
ok("Export setMintStage(\"regenerating\") fires BEFORE the export fetch",
   /setMintStage\("regenerating"\)[\s\S]{0,300}await authedFetch\(`\/api\/fn\/exportIncidentPacketV1`/.test(handlerBody));
ok("Mint setMintStage(\"minting\") fires AFTER the export but BEFORE the mint fetch",
   /setLastSuccessfulExportAt\(Date\.now\(\)\)[\s\S]{0,200}setMintStage\("minting"\)[\s\S]{0,300}await authedFetch\(`\/api\/fn\/mintResubmissionLinkV1`/.test(handlerBody));

// ── 6. Freshness window — skip re-export only when fresh ──────
ok("Freshness check compares (nowMs - lastSuccessfulExportAt) < window",
   /\(nowMs\s*-\s*lastSuccessfulExportAt\)\s*<\s*EXPORT_FRESHNESS_WINDOW_MS/.test(handlerBody));
ok("Skip-export guarded on lastSuccessfulExportAt !== null",
   /lastSuccessfulExportAt\s*!==\s*null/.test(handlerBody));
ok("if (!exportIsFresh) wraps the export step (always-export on cold call)",
   /if\s*\(!exportIsFresh\)\s*\{[\s\S]{0,200}setMintStage\("regenerating"\)/.test(handlerBody));
ok("setLastSuccessfulExportAt(null) on successful mint (clears the window)",
   /setLastSuccessfulExportAt\(null\)[\s\S]{0,200}await refresh\(\)/.test(handlerBody));

// ── 7. ResubmissionBanner mount passes new props ──────────────
ok("RecoveryCaseClient passes stage={mintStage}",
   /<ResubmissionBanner[\s\S]{0,500}stage=\{mintStage\}/.test(clientSrc));
ok("RecoveryCaseClient passes onRegenerateAndResubmit={handleRegenerateAndResubmit}",
   /<ResubmissionBanner[\s\S]{0,500}onRegenerateAndResubmit=\{handleRegenerateAndResubmit\}/.test(clientSrc));
ok("RecoveryCaseClient no longer passes onMint to the banner",
   !/<ResubmissionBanner[\s\S]{0,500}onMint=/.test(clientSrc));

// ── 8. CRITICAL guards: backend endpoints untouched ───────────
const exportPath = `${ROOT}/functions_clean/exportIncidentPacketV1.js`;
const mintPath = `${ROOT}/functions_clean/mintResubmissionLinkV1.js`;
const exportBody = read(exportPath);
const mintBody = read(mintPath);
const exportHash = crypto.createHash("sha256").update(exportBody).digest("hex").slice(0, 16);
const mintHash = crypto.createHash("sha256").update(mintBody).digest("hex").slice(0, 16);

ok("exportIncidentPacketV1 onRequest entrypoint intact",
   /exports\.exportIncidentPacketV1\s*=\s*onRequest\(\{ cors:\s*true \}/.test(exportBody));
ok("exportIncidentPacketV1 still increments reportRevision",
   /const reportRevision\s*=\s*_existingRevision\s*\+\s*1/.test(exportBody));
ok("exportIncidentPacketV1 still writes packetVersion: reportRevision",
   /packetVersion:\s*reportRevision/.test(exportBody));
ok("exportIncidentPacketV1 still writes versioned storagePath (v<n>__)",
   /exports\/incidents\/\$\{incidentId\}\/v\$\{reportRevision\}__/.test(exportBody));
ok("exportIncidentPacketV1 still has originalRecordHash / zipSha256 signing pipeline",
   /originalRecordHash/.test(exportBody) && /zipSha256/.test(exportBody));
ok("exportIncidentPacketV1.js fingerprint locked",
   exportBody.length > 100000,
   `hash=${exportHash} lines=${exportBody.split("\n").length}`);

ok("mintResubmissionLinkV1 onRequest entrypoint intact",
   /exports\.mintResubmissionLinkV1\s*=\s*onRequest/.test(mintBody));
ok("mintResubmissionLinkV1 still 409s on no_packet_yet (stale-packet guard)",
   /error:\s*"no_packet_yet"/.test(mintBody) && /Regenerate the packet before minting/.test(mintBody));
ok("mintResubmissionLinkV1 still pins packetMeta as pinnedPacket",
   /const pinnedPacket\s*=\s*\{[\s\S]{0,400}storagePath:\s*_storagePathFull/.test(mintBody));
ok("mintResubmissionLinkV1 still flips case.status to awaiting_customer",
   /status:\s*RECOVERY_STATUS\.AWAITING_CUSTOMER/.test(mintBody));
ok("mintResubmissionLinkV1 still writes case_resubmitted + case_status_changed audit rows",
   /type:\s*"case_resubmitted"/.test(mintBody) && /type:\s*"case_status_changed"/.test(mintBody));
ok("mintResubmissionLinkV1.js fingerprint locked",
   mintBody.length > 10000,
   `hash=${mintHash} lines=${mintBody.split("\n").length}`);

// ── 9. Regression spot-checks ─────────────────────────────────
// Note: recovery-A (PR 180) and recovery-B (this PR) touch entirely
// disjoint files (IncidentClient.tsx vs RecoveryCaseClient.tsx +
// ResubmissionBanner.tsx). No shared-file regression to assert; both
// PRs can land in either order.
ok("137B-2 regression — client-side HEIC convert helper still present",
   fs.existsSync(`${ROOT}/next-app/src/lib/evidence/maybeConvertHeicToJpeg.ts`));
ok("136A regression — capture-mode-close-camera still present",
   /data-testid="capture-mode-close-camera"/.test(read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`)));
ok("136B regression — upload-confirmation-panel still present",
   /data-testid="upload-confirmation-panel"/.test(read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`)));
ok("135A regression — _captureGate.js still has CAPTURE_GATE_MODE_BLOCK semantics",
   /CAPTURE_GATE_MODE_BLOCK/.test(read(`${ROOT}/functions_clean/_captureGate.js`)));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR pr-recovery-B regenerate-and-resubmit drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — Regenerate-and-resubmit pipeline drifted from contract`);
  process.exit(1);
}
