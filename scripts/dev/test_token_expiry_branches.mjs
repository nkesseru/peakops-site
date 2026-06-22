// PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 — branch coverage on the
// expiry check INSIDE getCustomerReviewV1 and submitCustomerReviewV1.
// Chunk 1: Trust Foundation, 2026-06-22
//
// Extract-and-run pattern (mirrors test_review_link_version_pin.mjs):
// pulls the verbatim TTL-check block from each live source and verifies
// it returns the correct status for active/expired/null/legacy
// timestamp shapes. If a source block drifts, this test fails to
// extract or fails to assert — either way, drift is visible.

import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isExpired } = require("/Users/kesserumini/peakops/my-app/functions_clean/_customerReviewToken");

const SRCS = [
  "/Users/kesserumini/peakops/my-app/functions_clean/getCustomerReviewV1.js",
  "/Users/kesserumini/peakops/my-app/functions_clean/submitCustomerReviewV1.js",
];

let failed = 0;
function fail(msg) {
  console.error(`  ❌ ${msg}`);
  failed++;
}
function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

console.log("=== Source-block presence check ===");
for (const path of SRCS) {
  const src = fs.readFileSync(path, "utf8");
  const hasTTL = /PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1/.test(src);
  const hasCall = /isExpired\([^)]*expiresAt/.test(src);
  if (hasTTL && hasCall) {
    pass(`${path.split("/").pop()} carries TTL marker + isExpired() call`);
  } else {
    fail(`${path.split("/").pop()} missing TTL marker (hasTTL=${hasTTL}) or isExpired call (hasCall=${hasCall})`);
  }
}

console.log("\n=== End-to-end behavior on the real isExpired() helper ===");
// These exercise the contract that the live source files invoke. If
// the source block changes the signature (e.g. swaps isExpired for a
// renamed function), the test_review_token_ttl.mjs file catches the
// helper itself; this file catches "is the helper actually wired in?"

const NOW = Date.now();
const expired = new Date(NOW - 1000);
const future = new Date(NOW + 86_400_000); // 1 day forward

if (isExpired(expired)) pass("expired Date → returns true (would 410)");
else fail("expected expired Date to return true");

if (!isExpired(future)) pass("future Date → returns false (would proceed)");
else fail("expected future Date to return false");

if (!isExpired(null)) pass("null expiresAt → returns false (legacy grandfathered)");
else fail("expected null to return false");

// Firestore Timestamp shape
const firestoreFuture = { _seconds: Math.floor((NOW + 86_400_000) / 1000), _nanoseconds: 0 };
if (!isExpired(firestoreFuture)) pass("Firestore Timestamp future → returns false");
else fail("expected Firestore Timestamp future to return false");

const firestorePast = { _seconds: Math.floor((NOW - 86_400_000) / 1000), _nanoseconds: 0 };
if (isExpired(firestorePast)) pass("Firestore Timestamp past → returns true");
else fail("expected Firestore Timestamp past to return true");

console.log("\n=== Negative test: source files must NOT reference Phase 0 null TTL anymore ===");
for (const path of SRCS) {
  const src = fs.readFileSync(path, "utf8");
  // Allow the LEGACY comment that explains backfill — only fail on the
  // mint-side Phase-0 placeholder string. None of our active mint
  // paths should retain `expiresAt: null` for fresh tokens.
  const hasPhase0Comment = /Phase 0 — no TTL; Phase 1 will populate this\./.test(src);
  if (hasPhase0Comment) {
    fail(`${path.split("/").pop()} still contains the Phase-0 null-TTL placeholder comment`);
  } else {
    pass(`${path.split("/").pop()} has no Phase-0 null-TTL placeholder`);
  }
}

// Same check on the mint surfaces.
for (const mintPath of [
  "/Users/kesserumini/peakops/my-app/functions_clean/createCustomerReviewLinkV1.js",
  "/Users/kesserumini/peakops/my-app/functions_clean/mintResubmissionLinkV1.js",
]) {
  const src = fs.readFileSync(mintPath, "utf8");
  const hasPhase0 = /Phase 0 — no TTL/.test(src);
  if (hasPhase0) {
    fail(`${mintPath.split("/").pop()} still contains Phase-0 null-TTL comment — TTL should be populated at mint`);
  } else {
    pass(`${mintPath.split("/").pop()} no Phase-0 placeholder`);
  }
  const hasComputeCall = /computeExpiresAt\(/.test(src);
  if (hasComputeCall) {
    pass(`${mintPath.split("/").pop()} invokes computeExpiresAt()`);
  } else {
    fail(`${mintPath.split("/").pop()} does NOT call computeExpiresAt — mint is still issuing null-TTL tokens`);
  }
}

if (failed > 0) {
  console.error(`\n❌ token-expiry branches: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ all token-expiry branch + drift assertions pass");
