#!/usr/bin/env node
// PR 136A — static drift guard for the camera-mode polish.
//
// Catches:
//   1. Per-slot capture counter inside the camera-mode banner
//      regresses or gets removed (operator loses immediate
//      feedback that captures are registering)
//   2. Camera-mode "Done" button text drifts back from
//      "Close camera" (the rename addresses a real first-timer
//      abandonment risk — see Phase 1 Gap #2)
//   3. Above-video hint disappears
//   4. Regression check: the underlying queue-merge that PR 96
//      shipped (items.some(...) || serverCapturedKeys.has(...))
//      is still in place, so the checklist still updates from
//      queued + persisted sources

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 136A capture-flow polish drift guard ═══════════════════════════");

const src = read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`);

// ── 1. Per-slot capture counter ─────────────────────────────────
ok("AddEvidenceClient has slotItemCount computation in camera-mode banner",
   /slotItemCount\s*=\s*items\.filter\([\s\S]{0,200}slot\?\.requirementKey\s*===\s*currentSlot\.requirementKey/.test(src));
ok("Camera-mode banner renders slot counter with data-testid",
   /data-testid="capture-mode-slot-counter"/.test(src));
ok("Slot counter displays empty state when 0 captured",
   /slotItemCount\s*===\s*0[\s\S]{0,80}"0 captured"/.test(src));
ok("Slot counter displays captured count with checkmark when > 0",
   /\$\{slotItemCount\}\s*captured\s*✓/.test(src));
ok("Slot counter has color flip (emerald when > 0, neutral when 0)",
   /slotItemCount\s*>\s*0[\s\S]{0,200}emerald-300\/40/.test(src) &&
   /slotItemCount\s*>\s*0[\s\S]{0,200}border-white\/15/.test(src));

// ── 2. Above-video hint ─────────────────────────────────────────
ok("Camera-mode hint paragraph rendered",
   /data-testid="capture-mode-hint"/.test(src));
ok("Hint mentions Capture photo + Close camera",
   /Capture photo[\s\S]{0,200}Close camera/.test(src));
ok("Hint reassures photos stay queued",
   /stay queued for upload/.test(src));

// ── 3. "Done" → "Close camera" rename ───────────────────────────
ok("Camera-mode close button labeled 'Close camera' (not 'Done')",
   />Close camera</.test(src));
ok("Close-camera button carries data-testid",
   /data-testid="capture-mode-close-camera"/.test(src));
// Negative: no remaining `>Done<` text in the camera-mode block.
// (Done appears elsewhere in test-id matching, hence the precise
// regex matches the literal JSX text node.)
const stillHasDone = />\s*Done\s*</.test(src);
ok("No stray '>Done<' text node remains in AddEvidenceClient",
   !stillHasDone, stillHasDone ? "found a >Done< text node — was rename incomplete?" : "");

// ── 4. PR 96 merge still in place (regression) ──────────────────
ok("requirementCaptureMap still merges queue items with serverCapturedKeys",
   /requirementCaptureMap\[key\]\s*=\s*\n?\s*items\.some\(\(it\)\s*=>\s*it\.slot\?\.requirementKey\s*===\s*key\)\s*\|\|\s*\n?\s*serverCapturedKeys\.has\(key\)/.test(src));

// ── 5. Capture-mode banner only renders when currentSlot is set ──
ok("Active-slot banner gated on currentSlot (no banner when no slot)",
   /\{currentSlot\s*\?[\s\S]{0,200}data-testid="capture-mode-active-slot-banner"/.test(src));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 136A capture-flow polish drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — capture-flow polish drifted from PR 136A contract`);
  process.exit(1);
}
