#!/usr/bin/env node
// PR 136B — static drift guard for the inline next-step banners.
//
// Catches:
//   1. Post-upload confirmation panel removed / 350ms redirect
//      sneaks back in (regresses Phase 1 Gap #3 — non-technical
//      first-timers miss the secured-✓ flash + no next-step
//      guidance toward notes)
//   2. uploadConfirmation state captures count BEFORE clearing
//      items.length (otherwise the panel reads "0 items
//      captured" — confusing)
//   3. NotesClient persistent "Ready to submit?" panel removed /
//      1800ms toast pattern sneaks back in
//   4. Confirmation panels lose their auto-dismiss on new
//      activity (would leave a stale "ready" panel sitting
//      next to a fresh queue)
//   5. Return-to-incident button on Notes loses the orgId query
//      string (the missing-orgId guard on the incident page
//      would intercept and show "Incident unavailable")

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 136B inline next-step banners drift guard ══════════════════════");

// ── 1. AddEvidenceClient: post-upload confirmation panel ────────
const addSrc = read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`);

ok("uploadConfirmation state declared",
   /\[uploadConfirmation,\s*setUploadConfirmation\]\s*=\s*useState/.test(addSrc));
// Match the structural invariant in two parts: (a) uploadedCount is
// assigned from items.length BEFORE the setItems(prev => [] ) clear,
// and (b) setUploadConfirmation reads uploadedCount (not items.length,
// which would be 0 by then).
ok("uploadConfirmation captures count BEFORE queue clear",
   (() => {
     const m = /const uploadedCount = items\.length;([\s\S]+?)setUploadConfirmation\(\{ count: uploadedCount \}\)/.exec(addSrc);
     if (!m) return false;
     return /setItems\(\(prev\)\s*=>\s*\{[\s\S]*?return \[\];/.test(m[1]);
   })());
ok("Post-upload confirmation panel renders with data-testid",
   /data-testid="upload-confirmation-panel"/.test(addSrc));
ok("Confirmation panel surfaces \"items captured\" copy",
   /captured and secured/.test(addSrc));
ok("Confirmation panel has \"Next: write notes →\" link",
   /Next:\s*write notes\s*→/.test(addSrc));
ok("Next-notes link uses notes route + orgId preserved",
   /href=\{`\/incidents\/\$\{incidentId\}\/notes\$\{orgId\s*\?\s*`\?orgId=\$\{encodeURIComponent\(orgId\)\}`/.test(addSrc));
ok("Confirmation panel has Back-to-incident link",
   /data-testid="upload-confirmation-back-incident"/.test(addSrc));
ok("AddEvidenceClient does NOT auto-redirect after upload (no setTimeout router.push)",
   !/setTimeout\(\(\)\s*=>\s*router\.push\([^)]*incidents/.test(addSrc));
ok("Confirmation panel auto-dismisses when capturePhoto adds an item",
   /setItems\(\(prev\)\s*=>\s*\[\{ id, file: f, url, slot \}, \.\.\.prev\]\);[\s\S]{0,300}setUploadConfirmation\(null\)/.test(addSrc));
ok("Confirmation panel auto-dismisses when addPickedFiles adds items",
   /setItems\(\(prev\)\s*=>\s*\[\.\.\.next,\s*\.\.\.prev\]\);[\s\S]{0,200}setUploadConfirmation\(null\)/.test(addSrc));

// ── 2. NotesClient: persistent "Ready to submit?" panel ─────────
const notesSrc = read(`${ROOT}/next-app/app/incidents/[incidentId]/notes/NotesClient.tsx`);

ok("savedReadyToSubmit state declared",
   /\[savedReadyToSubmit,\s*setSavedReadyToSubmit\]\s*=\s*useState/.test(notesSrc));
ok("save() success path sets savedReadyToSubmit",
   /setSavedReadyToSubmit\(true\)/.test(notesSrc));
ok("save() no longer uses 1800ms transient toast pattern",
   !/setTimeout\(\(\)\s*=>\s*setMsg\(\s*""\s*\),\s*1800\)/.test(notesSrc));
ok("Persistent banner renders with data-testid",
   /data-testid="notes-saved-ready-panel"/.test(notesSrc));
ok("Banner copy mentions \"Ready to submit?\"",
   /Ready to submit\?/.test(notesSrc));
ok("Return-to-incident button present with data-testid",
   /data-testid="notes-saved-return-button"/.test(notesSrc));
ok("Return button preserves orgId in URL",
   /href=\{`\/incidents\/\$\{incidentId\}\$\{orgId\s*\?\s*`\?orgId=/.test(notesSrc));
ok("\"Keep editing\" dismiss option present",
   /data-testid="notes-saved-dismiss"/.test(notesSrc));
ok("textarea onChange resets savedReadyToSubmit (auto-dismiss on edit)",
   /onChange=\{[\s\S]{0,200}if \(savedReadyToSubmit\) setSavedReadyToSubmit\(false\)/.test(notesSrc));
ok("Banner suppressed when record is sealed (closed or sealedAfterMutation)",
   /savedReadyToSubmit\s*&&\s*!\(incidentStatus\s*===\s*"closed"\s*\|\|\s*sealedAfterMutation\)/.test(notesSrc));

// ── 3. PR 136A regression spot-check (Phase 1 fix lives in same file) ──
ok("PR 136A camera-mode close-camera button still present",
   /data-testid="capture-mode-close-camera"/.test(addSrc));
ok("PR 136A per-slot capture counter still present",
   /data-testid="capture-mode-slot-counter"/.test(addSrc));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 136B inline next-step banners drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — next-step banner surface drifted from PR 136B contract`);
  process.exit(1);
}
