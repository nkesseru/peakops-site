#!/usr/bin/env node
// PR 137B-2 — static drift guard for the client-side HEIC convert
// at capture time.
//
// Catches:
//   1. The maybeConvertHeicToJpeg helper losing its iron-rule
//      fallback (the catch block that returns the ORIGINAL file
//      when WASM load / decode fails or times out)
//   2. addPickedFiles regressing to a non-HEIC-aware path (no
//      `optimizing` flag, no background convert kickoff, items
//      pushed without `URL.revokeObjectURL` cleanup on swap)
//   3. heic-to becoming a static import — would inflate the main
//      bundle by ~3 MB even for non-HEIC sessions
//   4. Upload button gate losing the `items.some(i => i.optimizing)`
//      check — would allow shipping original HEIC bytes while a
//      convert is still in flight (defeats the on-brand "clean
//      record at the source" outcome)
//   5. Tile rendering losing the "Optimizing photo…" or "Couldn't
//      preview · original kept" UI affordances (transparency is
//      part of the iron rule — silent fallback hides a real fact)
//   6. capturePhoto being accidentally rerouted through the convert
//      helper (camera-captured JPEG never needs it)
//   7. PR 136A/B/D regressions in the same file

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 137B-2 client-side HEIC convert drift guard ════════════════════");

const helper = read(`${ROOT}/next-app/src/lib/evidence/maybeConvertHeicToJpeg.ts`);
const addSrc = read(`${ROOT}/next-app/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx`);
const pkg = JSON.parse(read(`${ROOT}/next-app/package.json`));

// ── 1. Helper exists + iron-rule semantics ──────────────────────
ok("maybeConvertHeicToJpeg helper present", helper.length > 0);
ok("CONVERT_TIMEOUT_MS is 6000ms (per approved plan)",
   /CONVERT_TIMEOUT_MS\s*=\s*6000/.test(helper));
ok("Returns ConvertResult with file + converted flag",
   /converted:\s*true/.test(helper) && /converted:\s*false/.test(helper));
ok("Iron rule — catch block returns ORIGINAL file when convert fails",
   /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}return\s*\{\s*file,\s*converted:\s*false/.test(helper));
ok("heic-to imported dynamically (not statically)",
   /await\s+(?:withTimeout\(\s*)?import\(\s*["']heic-to["']\s*\)/.test(helper) &&
   !/^import\s+[^;]*from\s+["']heic-to["']/m.test(helper));
ok("Convert wrapped in withTimeout(load + decode)",
   /withTimeout\([\s\S]{0,200}["']load-timeout["']/.test(helper) &&
   /withTimeout\([\s\S]{0,300}["']decode-timeout["']/.test(helper));
ok("Helper sniffs HEIC by file ext OR mime type",
   /\.\(heic\|heif\)\$/.test(helper) && /heic\|heif/.test(helper));

// ── 2. heic-to dependency listed in next-app/package.json ──────
ok("heic-to is a dependency of next-app",
   typeof pkg?.dependencies?.["heic-to"] === "string");
ok("heic-to pinned at ^1.5.x (maintained branch)",
   /^\^?1\.[5-9]\./.test(String(pkg?.dependencies?.["heic-to"] || "")));

// ── 3. AddEvidenceClient wires the helper into addPickedFiles ──
ok("AddEvidenceClient imports maybeConvertHeicToJpeg",
   /import\s*\{\s*maybeConvertHeicToJpeg\s*\}\s*from\s*["']@\/lib\/evidence\/maybeConvertHeicToJpeg["']/.test(addSrc));
ok("Item type carries optimizing + originalRetained flags",
   /optimizing\?:\s*boolean/.test(addSrc) &&
   /originalRetained\?:\s*boolean/.test(addSrc));
ok("addPickedFiles marks HEIC items as optimizing on push",
   /heicCandidate\s*=\s*[\s\S]{0,200}\.\(heic\|heif\)\$[\s\S]{0,400}optimizing:\s*heicCandidate/.test(addSrc));
ok("addPickedFiles kicks off background convert for each HEIC item",
   /for\s*\(\s*const\s+seed\s+of\s+next\s*\)[\s\S]{0,300}maybeConvertHeicToJpeg\(originalFile\)/.test(addSrc));
ok("Convert resolution patches item in-place (file + url + optimizing:false)",
   /setItems\(\(prev\)\s*=>\s*prev\.map\([\s\S]{0,500}optimizing:\s*false[\s\S]{0,200}originalRetained:\s*!result\.converted/.test(addSrc));
ok("Old blob URL is revoked before swap to avoid leak",
   /URL\.revokeObjectURL\(it\.url\)[\s\S]{0,200}URL\.createObjectURL\(result\.file\)/.test(addSrc));

// ── 4. capturePhoto NOT routed through the convert helper ──────
// Camera-captured items are JPEG already (canvas.toBlob image/jpeg).
ok("capturePhoto path does NOT invoke maybeConvertHeicToJpeg",
   (() => {
     const m = /function capturePhoto\(\)[\s\S]*?\n  \}/.exec(addSrc);
     if (!m) return false;
     return !/maybeConvertHeicToJpeg/.test(m[0]);
   })());

// ── 5. Upload button gates on optimizing-in-flight ─────────────
ok("Upload button disabled while any item is optimizing",
   /disabled=\{[\s\S]{0,300}items\.some\(\(i\)\s*=>\s*i\.optimizing\)/.test(addSrc));
ok("Upload button title surfaces optimizing count when in flight",
   /items\.some\(\(i\)\s*=>\s*i\.optimizing\)[\s\S]{0,200}Optimizing\s+\$\{[\s\S]{0,200}\}\s+photo/.test(addSrc));

// ── 6. Tile rendering — transparency affordances ───────────────
ok("Tile shows \"Optimizing photo…\" placeholder while converting",
   /data-testid="capture-tile-optimizing"[\s\S]{0,300}Optimizing photo…/.test(addSrc));
ok("Tile shows \"HEIC original\" placeholder when fallback retained",
   /data-testid="capture-tile-original-retained"[\s\S]{0,300}HEIC original/.test(addSrc));
ok("Bottom strip shows \"Couldn't preview · original kept\" badge on fallback",
   /data-testid="capture-tile-original-retained-badge"[\s\S]{0,500}Couldn&apos;t preview\s*·\s*original kept/.test(addSrc));

// ── 7. PR 136A/B/D regression spot-checks ──────────────────────
ok("136A regression — camera-mode close-camera button still present",
   /data-testid="capture-mode-close-camera"/.test(addSrc));
ok("136A regression — per-slot capture counter still present",
   /data-testid="capture-mode-slot-counter"/.test(addSrc));
ok("136B regression — upload confirmation panel still present",
   /data-testid="upload-confirmation-panel"/.test(addSrc));
ok("136D regression — desktop-aware primary capture surface intact",
   /data-testid="capture-buttons-row"\s+data-file-picker-primary/.test(addSrc));

// ── 8. Scope-lock guard — convert function side ─────────────────
// Server-side convertHeicOnFinalize.js must NOT be touched by this PR.
// We can't easily diff against main from a static check, but we can
// at least assert the file hasn't been deleted (still present + still
// exports onObjectFinalized).
const serverFn = (() => { try { return read(`${ROOT}/functions_clean/convertHeicOnFinalize.js`); } catch { return ""; } })();
ok("Server-side convertHeicOnFinalize still present (left dormant per plan)",
   /onObjectFinalized/.test(serverFn));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 137B-2 client-side HEIC convert drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — client-side HEIC convert surface drifted from PR 137B-2 contract`);
  process.exit(1);
}
