#!/usr/bin/env node
// PR 136C — static drift guard for dock weighting + relabel.
//
// Catches:
//   1. Dock labels regress (terse "Proof" / "Notes" labels were
//      Phase 1 confusion points — verb-led labels match the
//      NextBestAction CTA above the dock)
//   2. Notes button stops being gated on _hasEvidence (regresses
//      the progressive-disclosure pattern: proof → notes → submit)
//   3. Notes-disabled tooltip drifts away from the operator-
//      educational copy ("Capture proof first — notes come next")
//   4. data-testid hooks removed (drift-guard alignment lock)
//   5. Submit button gating untouched (don't regress 135B contract)

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 136C dock weighting + relabel drift guard ══════════════════════");

const src = read(`${ROOT}/next-app/app/incidents/[incidentId]/IncidentClient.tsx`);

// ── 1. Relabel: Proof → Capture proof ──────────────────────────
ok("Capture-proof dock button has data-testid",
   /data-testid="dock-button-capture-proof"/.test(src));
ok("Capture-proof button label reads \"Capture proof\" (not bare \"Proof\")",
   />\s*Capture proof\s*</.test(src));
// Make sure the old terse label isn't still hanging around as a
// stray button child somewhere in this file. The regex matches
// `>Proof<` as a JSX text-node (not "Proof captured (done)" inside
// a title attribute, which is a quoted string). Allow whitespace
// around the text node since JSX usually wraps button children
// on their own lines.
ok("No stray bare \">Proof<\" text node remains",
   !/>\s*Proof\s*</.test(src) || />\s*Capture proof\s*</.test(src) && !/>\s*Proof\s*<\/button>/.test(src.replace(/>\s*Capture proof\s*</g, "")));

// ── 2. Relabel: Notes → Write notes ────────────────────────────
ok("Write-notes dock button has data-testid",
   /data-testid="dock-button-write-notes"/.test(src));
ok("Write-notes button label reads \"Write notes\"",
   />\s*Write notes\s*</.test(src));
// The stray-bare-Notes check must allow "Write notes" through.
ok("No stray bare \">Notes<\" text node remains",
   !/>\s*Notes\s*<\/button>/.test(src.replace(/>\s*Write notes\s*</g, "")));

// ── 3. Notes-button progressive-disclosure gating ──────────────
ok("Write-notes button disabled when no evidence AND no notes yet",
   /disabled=\{isClosed\s*\|\|\s*\(!_hasEvidence\s*&&\s*!_hasNotes\)\}/.test(src));
ok("Write-notes button uses dim styling when prerequisites unmet",
   /\(!_hasEvidence\s*\|\|\s*isClosed\)[\s\S]{0,120}cursor-not-allowed/.test(src));
ok("Disabled-state title explains WHY the button is dimmed",
   /Capture proof first — notes come next/.test(src));

// ── 4. Re-edit allowed (re-entry case) ─────────────────────────
// If the operator already saved notes (e.g. came back to edit a
// typo), the button stays clickable. _hasNotes makes the disabled
// predicate false even when evidence is missing for some edge case.
ok("Re-edit allowed when _hasNotes already true",
   /disabled=\{isClosed\s*\|\|\s*\(!_hasEvidence\s*&&\s*!_hasNotes\)\}/.test(src));

// ── 5. Submit button gating UNCHANGED (135B contract) ──────────
ok("Submit button still gated on arrived + _hasEvidence + _hasNotes",
   /disabled=\{[\s\S]*?submitting\s*\|\|\s*!arrived\s*\|\|\s*!_hasEvidence\s*\|\|\s*!_hasNotes/.test(src));
ok("Submit button still uses captureGateShouldDisable (135B regression)",
   /captureGateShouldDisable\(incidentReadinessCache\)\s*&&\s*!captureGateOverride/.test(src));

// ── 6. Mobile typography parity ────────────────────────────────
// Capture-proof + Write-notes both use text-[11px] sm:text-sm so
// the longer verb labels don't wrap on a 4-col mobile grid (~80px
// per cell). Submit already uses this; the two relabeled buttons
// now match.
ok("Capture-proof button uses text-[11px] sm:text-sm mobile-fit",
   /data-testid="dock-button-capture-proof"[\s\S]{0,300}text-\[11px\] sm:text-sm/.test(src));
ok("Write-notes button uses text-[11px] sm:text-sm mobile-fit",
   /data-testid="dock-button-write-notes"[\s\S]{0,300}text-\[11px\] sm:text-sm/.test(src));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 136C dock weighting + relabel drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — dock surface drifted from PR 136C contract`);
  process.exit(1);
}
