// Targeted smoke for PEAKOPS_REVIEW_VERSION_PIN_V3 (slice 3) in
// functions_clean/submitCustomerReviewV1.js — exercises the inner
// transaction's _reviewedPacket construction across pinnedPacket
// shapes and accept/reject actions.
//
// No emulator. No Firebase. Extracts the verbatim block from the
// live source and evaluates it against stubbed inputs.

import fs from "node:fs";

const SRC = "functions_clean/submitCustomerReviewV1.js";
const src = fs.readFileSync(SRC, "utf8");

// Extract the block from the marker comment header through the
// closing brace of the `_reviewedPacket = ... : null;` ternary.
const m = src.match(
  /\/\/ PEAKOPS_REVIEW_VERSION_PIN_V3 \(2026-06-15\)[\s\S]*?const _reviewedPacket = \([\s\S]*?\n          \: null;\n/,
);
if (!m) {
  console.error(`FAIL: PEAKOPS_REVIEW_VERSION_PIN_V3 block not found in ${SRC}`);
  process.exit(1);
}
const block = m[0];

// Port the file's trimStr helper so the block can call it.
const trimStrSrc = `function trimStr(v){ return String(v==null?"":v).trim(); }`;

// FieldValue stub — same sentinel as slice 1 smoke.
const FieldValueStub = { serverTimestamp: () => "@@SERVER_TIMESTAMP@@" };

function runBlock(pinnedPacket, finalAction) {
  const data = pinnedPacket === undefined ? {} : { pinnedPacket };
  // eslint-disable-next-line no-new-func
  const runner = new Function(
    "data, finalAction, FieldValue, trimStr",
    `${trimStrSrc}\n${block}\nreturn _reviewedPacket;`,
  );
  return runner(data, finalAction, FieldValueStub, trimStrSrc);
}

const FULL_PP = {
  version: 17,
  fileName: "v17__Fiber_splice_verification_Jun15__v17.zip",
  storagePath: "exports/incidents/X/v17__Fiber_splice_verification_Jun15__v17.zip",
  bucket: "peakops-pilot.firebasestorage.app",
  zipSha256: "abcd1234567890",
  originalRecordHash: "sha256:zzzz9999",
  generatedAt: "2026-06-15T18:27:14Z",
  pinnedAt: { _seconds: 1781556434, _nanoseconds: 0 },  // resolved Timestamp from Firestore
};

let pass = true;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) pass = false;
}

console.log("=== CASE 1: full pinnedPacket + accepted → 10-key reviewedPacket ===");
{
  const r = runBlock(FULL_PP, "accepted");
  check("reviewedPacket built", !!r);
  if (r) {
    check("version === 17 (number)", r.version === 17 && typeof r.version === "number");
    check("fileName carried", r.fileName === FULL_PP.fileName);
    check("storagePath carried", r.storagePath === FULL_PP.storagePath);
    check("bucket carried", r.bucket === FULL_PP.bucket);
    check("zipSha256 carried", r.zipSha256 === FULL_PP.zipSha256);
    check("originalRecordHash carried", r.originalRecordHash === FULL_PP.originalRecordHash);
    check("generatedAt carried", r.generatedAt === FULL_PP.generatedAt);
    check("pinnedAt = original Timestamp shape", r.pinnedAt && r.pinnedAt._seconds === FULL_PP.pinnedAt._seconds);
    check("reviewedAt = serverTimestamp sentinel", r.reviewedAt === "@@SERVER_TIMESTAMP@@");
    check("action = 'accepted'", r.action === "accepted");
    check("exactly 10 keys", Object.keys(r).length === 10, `(got ${Object.keys(r).join(",")})`);
  }
}

console.log("");
console.log("=== CASE 2: full pinnedPacket + rejected → action='rejected' ===");
{
  const r = runBlock(FULL_PP, "rejected");
  check("reviewedPacket built", !!r);
  check("action = 'rejected'", r && r.action === "rejected");
  check("version still 17", r && r.version === 17);
}

console.log("");
console.log("=== CASE 3: pinnedPacket field absent on link (pre-slice-1) → null (graceful skip) ===");
{
  const r = runBlock(undefined, "accepted");
  check("reviewedPacket is null", r === null);
}

console.log("");
console.log("=== CASE 4: pinnedPacket explicitly null → null ===");
{
  const r = runBlock(null, "accepted");
  check("reviewedPacket is null", r === null);
}

console.log("");
console.log("=== CASE 5: pinnedPacket missing .version → null (defensive) ===");
{
  const r = runBlock({ storagePath: "exports/x.zip", zipSha256: "abc" }, "accepted");
  check("reviewedPacket is null", r === null);
}

console.log("");
console.log("=== CASE 6: pinnedPacket.version non-numeric ('abc') → null ===");
{
  const r = runBlock({ version: "abc", storagePath: "exports/x.zip" }, "accepted");
  check("reviewedPacket is null", r === null);
}

console.log("");
console.log("=== CASE 7: pinnedPacket present but missing optional fields → reviewedPacket built with empty strings ===");
{
  // Only version + storagePath present. Defensive copy: other fields → ""
  const r = runBlock({ version: 5, storagePath: "exports/x.zip" }, "accepted");
  check("reviewedPacket built (version is the only required field)", !!r);
  check("version === 5", r && r.version === 5);
  check("fileName === '' (no source)", r && r.fileName === "");
  check("bucket === ''", r && r.bucket === "");
  check("zipSha256 === ''", r && r.zipSha256 === "");
  check("originalRecordHash === ''", r && r.originalRecordHash === "");
  check("generatedAt === ''", r && r.generatedAt === "");
  check("pinnedAt === null (no source)", r && r.pinnedAt === null);
}

console.log("");
if (pass) { console.log("✅ all assertions pass"); process.exit(0); }
console.log("❌ at least one assertion failed"); process.exit(1);
