// PEAKOPS_STORAGE_RULES_V2 — storage rules drift guard
// Chunk 1: Trust Foundation, 2026-06-22
//
// Asserts that the file Firebase CLI actually deploys
// (firebase/storage.rules per firebase.json) denies all client SDK
// reads and writes. Pure file inspection — no emulator required.
//
// This is the cheapest possible regression guard for the wide-open
// rules that shipped during alpha development. If anything reverts
// the rules back to `allow read: if true` or `allow write: if true`,
// CI fails before a deploy can land.

import fs from "node:fs";

const REPO = "/Users/kesserumini/peakops/my-app";
const FIREBASE_JSON = `${REPO}/firebase.json`;
const ROOT_RULES = `${REPO}/storage.rules`;

let failed = 0;
function fail(msg) {
  console.error(`  ❌ ${msg}`);
  failed++;
}
function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

console.log("=== firebase.json points at the expected storage rules file ===");
const fbConfig = JSON.parse(fs.readFileSync(FIREBASE_JSON, "utf8"));
const deployedPath = String(fbConfig?.storage?.rules || "").trim();
if (deployedPath) {
  pass(`firebase.json declares storage.rules path: ${deployedPath}`);
} else {
  fail("firebase.json missing storage.rules path entry");
}
const fullDeployedPath = `${REPO}/${deployedPath}`;

function assertDenyAll(label, path) {
  if (!fs.existsSync(path)) {
    fail(`${label} not found at ${path}`);
    return;
  }
  const raw = fs.readFileSync(path, "utf8");

  // Strip line-comments and block-comments so we don't match `if true`
  // strings that appear inside documentation comments (we DO talk about
  // the prior wide-open rule in the rationale block).
  const noLineComments = raw.replace(/\/\/.*$/gm, "");
  const src = noLineComments.replace(/\/\*[\s\S]*?\*\//g, "");

  // Must NOT contain any unconditionally-true allow on an actual rule
  // line (whitespace flexible). `allow read, write: if false` is fine.
  const allowIfTrue = /\ballow\b[^;]*:\s*if\s+true\b/g.test(src);
  if (allowIfTrue) {
    fail(`${label} contains 'allow ... if true' — WIDE-OPEN rules detected`);
    return;
  }

  // Must contain explicit deny statements for read AND write. Be
  // generous on syntax: `allow read: if false;` OR `allow read, write: if false;`
  // OR even no allow at all (default-deny). Refuse to pass if there's
  // no `if false` anywhere AND no explicit read/write rule.
  const allowIfFalse = /\ballow\b[^;]*:\s*if\s+false\b/.test(src);
  const noAllowAtAll = !/\ballow\b/.test(src);
  if (!allowIfFalse && !noAllowAtAll) {
    fail(`${label} has 'allow' rules but none are 'if false' — may be conditional but not verified`);
    return;
  }

  // Must carry the PEAKOPS_STORAGE_RULES_V2 marker so future readers
  // can find the rationale doc. Check the RAW source (the marker lives
  // inside a comment block by design — comments hold the rationale).
  if (!/PEAKOPS_STORAGE_RULES_V2/.test(raw)) {
    fail(`${label} missing PEAKOPS_STORAGE_RULES_V2 marker (rationale lost)`);
    return;
  }

  pass(`${label} is deny-all with marker (path=${path.replace(REPO + "/", "")})`);
}

console.log("\n=== Deployed storage rules (firebase/storage.rules per firebase.json) ===");
assertDenyAll("Deployed rules", fullDeployedPath);

console.log("\n=== Root storage.rules (kept in sync as defense-in-depth) ===");
assertDenyAll("Root rules", ROOT_RULES);

if (failed) {
  console.error(`\n❌ storage-rules deny-all: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ all storage-rules drift assertions pass");
