// PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 — unit test
// Chunk 1: Trust Foundation, 2026-06-22
//
// Pure-Node test for the token expiration helpers added in
// functions_clean/_customerReviewToken.js. No emulator. No Firebase.
//
// Exercises:
//   - computeExpiresAt() returns Date 90 days in the future
//   - isExpired() handles every persisted timestamp shape Firestore
//     might produce, plus null/undefined for legacy tokens, plus
//     malformed objects (fail-safe = not expired)
//
// Fails loudly if any assertion misses. Drift in _customerReviewToken.js
// that changes the contract will fail to run / fail to assert.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const t = require("/Users/kesserumini/peakops/my-app/functions_clean/_customerReviewToken");

const NOW = 1_750_000_000_000; // arbitrary fixed clock for determinism
const ONE_SEC_MS = 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✅" : "❌"} ${label}  actual=${actual}  expected=${expected}`);
  if (!ok) {
    process.exitCode = 1;
  }
}

console.log("=== TOKEN_TTL_DAYS constant ===");
check("TOKEN_TTL_DAYS === 90", t.TOKEN_TTL_DAYS, 90);
check("TOKEN_TTL_MS === 90 days in ms", t.TOKEN_TTL_MS, NINETY_DAYS_MS);

console.log("\n=== computeExpiresAt(now) ===");
const exp = t.computeExpiresAt(NOW);
check("computeExpiresAt returns Date", exp instanceof Date, true);
check("computeExpiresAt(now).getTime() === now + 90d", exp.getTime(), NOW + NINETY_DAYS_MS);

console.log("\n=== isExpired() — null / undefined (legacy grandfathered) ===");
check("null →  false",      t.isExpired(null, NOW), false);
check("undefined → false",  t.isExpired(undefined, NOW), false);

console.log("\n=== isExpired() — JS Date ===");
check("Date future → false",   t.isExpired(new Date(NOW + ONE_SEC_MS), NOW), false);
check("Date past → true",      t.isExpired(new Date(NOW - ONE_SEC_MS), NOW), true);
check("Date == now → true",    t.isExpired(new Date(NOW), NOW), true);

console.log("\n=== isExpired() — epoch milliseconds ===");
check("epoch ms future → false", t.isExpired(NOW + ONE_SEC_MS, NOW), false);
check("epoch ms past → true",    t.isExpired(NOW - ONE_SEC_MS, NOW), true);

console.log("\n=== isExpired() — ISO string ===");
check("ISO future → false", t.isExpired(new Date(NOW + ONE_SEC_MS).toISOString(), NOW), false);
check("ISO past → true",    t.isExpired(new Date(NOW - ONE_SEC_MS).toISOString(), NOW), true);

console.log("\n=== isExpired() — Firestore Timestamp shape (raw _seconds/_nanoseconds) ===");
const futTs = { _seconds: Math.floor((NOW + ONE_SEC_MS) / 1000), _nanoseconds: 0 };
const pastTs = { _seconds: Math.floor((NOW - ONE_SEC_MS) / 1000), _nanoseconds: 0 };
check("Firestore ts future → false", t.isExpired(futTs, NOW), false);
check("Firestore ts past → true",    t.isExpired(pastTs, NOW), true);

console.log("\n=== isExpired() — Firestore Timestamp with toMillis() ===");
const futWithFn = { toMillis: () => NOW + ONE_SEC_MS };
const pastWithFn = { toMillis: () => NOW - ONE_SEC_MS };
check("toMillis future → false", t.isExpired(futWithFn, NOW), false);
check("toMillis past → true",    t.isExpired(pastWithFn, NOW), true);

console.log("\n=== isExpired() — malformed / unknown shapes (fail-safe = not expired) ===");
check("garbage object → false",       t.isExpired({ foo: 1 }, NOW), false);
check("empty string → false",         t.isExpired("", NOW), false);
check("malformed ISO → false",        t.isExpired("not-a-date", NOW), false);
check("Date+NaN time → false",        t.isExpired(new Date(NaN), NOW), false);

if (process.exitCode) {
  console.log("\n❌ token TTL test FAILED — see above");
  process.exit(process.exitCode);
}
console.log("\n✅ all token-TTL assertions pass");
