#!/usr/bin/env node
// PR 136D — static drift guard for the desktop-aware primary
// capture button.
//
// Catches:
//   1. Surface detection regressing to a single-signal predicate
//      (the literal "navigator.mediaDevices?.getUserMedia"
//      detection from the spec misclassifies desktop Chrome with
//      a webcam as mobile — the demo would still show camera
//      primary on the laptop, defeating the point of the PR)
//   2. Runtime fallback (cameraFailedAtRuntime) removed — the
//      one-way flip prevents flapping when the operator retries
//      a getUserMedia call that previously failed
//   3. JSX swap removed (file-picker always second in DOM order)
//   4. Slot-aware pickButtonLabel removed (parity with the camera
//      button's "Capture: <slot>" treatment is what makes the
//      desktop primary feel guided rather than generic)
//   5. data-testid hooks removed (drift-guard alignment lock)
//   6. 136A/136B regressions

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 136D desktop-aware primary capture drift guard ═════════════════");

const src = read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`);

// ── 1. Two-signal surface detection ────────────────────────────
ok("filePickerPrimaryFlag state declared",
   /\[filePickerPrimaryFlag,\s*setFilePickerPrimaryFlag\]\s*=\s*useState/.test(src));
ok("cameraFailedAtRuntime state declared",
   /\[cameraFailedAtRuntime,\s*setCameraFailedAtRuntime\]\s*=\s*useState/.test(src));
ok("Detection reads navigator.mediaDevices.getUserMedia",
   /navigator\.mediaDevices\s*&&\s*navigator\.mediaDevices\.getUserMedia/.test(src));
ok("Detection reads matchMedia (pointer: coarse) — touch device signal",
   /matchMedia\?\.\(["']\(pointer:\s*coarse\)["']\)/.test(src));
ok("File-picker primary unless BOTH hasUserMedia AND coarsePointer (NOT single-signal)",
   /setFilePickerPrimaryFlag\(!\(hasUserMedia\s*&&\s*coarsePointer\)\)/.test(src));
ok("Effective predicate combines flag with runtime fallback",
   /const filePickerPrimary\s*=\s*filePickerPrimaryFlag\s*\|\|\s*cameraFailedAtRuntime/.test(src));

// ── 2. Runtime fallback wired into openCamera catch ───────────
// The openCamera catch block must include both setCameraError and
// setCameraFailedAtRuntime — assert structural co-location loosely.
ok("openCamera catch sets cameraFailedAtRuntime",
   (() => {
     const m = /async function openCamera\(\)[\s\S]*?\n  \}/.exec(src);
     if (!m) return false;
     return /setCameraError\(/.test(m[0]) && /setCameraFailedAtRuntime\(true\)/.test(m[0]);
   })());
ok("Comment notes fallback is one-way (no flap)",
   /[Oo]ne-way flip[\s\S]{0,200}never reverts/.test(src));

// ── 3. Slot-aware file-picker label ────────────────────────────
ok("pickButtonLabel declared alongside captureButtonLabel",
   /let pickButtonLabel\s*=\s*"Upload photos"/.test(src));
ok("pickButtonLabel becomes \"Upload: <slot>\" when next target available",
   /pickButtonLabel\s*=\s*`Upload:\s*\$\{nextTargetLabel\}`/.test(src));
ok("pickButtonLabel becomes \"Upload more proof\" when all slots filled",
   /pickButtonLabel\s*=\s*"Upload more proof"/.test(src));

// ── 4. JSX order swap based on filePickerPrimary ──────────────
ok("Camera button JSX has data-testid + data-primary attr",
   /data-testid="capture-camera-button"/.test(src) &&
   /data-primary=\{!filePickerPrimary\}/.test(src));
ok("File-picker button JSX has data-testid + data-primary attr",
   /data-testid="capture-pick-button"/.test(src) &&
   /data-primary=\{filePickerPrimary\}/.test(src));
ok("Container row has data-testid + data-file-picker-primary attr",
   /data-testid="capture-buttons-row"\s+data-file-picker-primary=\{filePickerPrimary\}/.test(src));
ok("JSX conditionally renders filePickerButtonJSX FIRST when filePickerPrimary",
   /filePickerPrimary\s*\?\s*\(\s*<>\s*\n?\s*\{filePickerButtonJSX\}/.test(src));
ok("JSX conditionally renders cameraButtonJSX FIRST when !filePickerPrimary",
   /:\s*\(\s*<>\s*\n?\s*\{cameraButtonJSX\}/.test(src));

// ── 5. Style swap (primary vs secondary) ──────────────────────
ok("primaryClass + secondaryClass declared",
   /const primaryClass\s*=/.test(src) && /const secondaryClass\s*=/.test(src));
ok("Camera button uses primary class when !filePickerPrimary, secondary when filePickerPrimary",
   /filePickerPrimary\s*\?\s*secondaryClass\s*:\s*primaryClass/.test(src));
ok("File-picker button uses primary class when filePickerPrimary, secondary when !filePickerPrimary",
   /filePickerPrimary\s*\?\s*primaryClass\s*:\s*secondaryClass/.test(src));

// ── 6. Label conditional ──────────────────────────────────────
ok("File-picker label switches to pickButtonLabel when primary",
   /filePickerPrimary\s*\?\s*pickButtonLabel\s*:\s*"Pick multiple photos\/videos"/.test(src));

// ── 7. Hidden input stays in render tree ──────────────────────
ok("Hidden file input still ref'd as fileInputRef",
   /ref=\{fileInputRef\}/.test(src));

// ── 8. PR 136A + 136B regression spot-checks ─────────────────
ok("136A regression — capture-mode close-camera button present",
   /data-testid="capture-mode-close-camera"/.test(src));
ok("136A regression — per-slot capture counter present",
   /data-testid="capture-mode-slot-counter"/.test(src));
ok("136B regression — upload confirmation panel present",
   /data-testid="upload-confirmation-panel"/.test(src));
ok("136B regression — no setTimeout(router.push) auto-redirect",
   !/setTimeout\(\(\)\s*=>\s*router\.push\([^)]*incidents/.test(src));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 136D desktop-aware primary capture drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — desktop-aware surface drifted from PR 136D contract`);
  process.exit(1);
}
