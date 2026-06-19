// Targeted smoke for PEAKOPS_REVIEW_VERSION_PIN_V1 in
// functions_clean/createCustomerReviewLinkV1.js.
//
// No emulator. No Firebase. Extracts the verbatim new block from the
// live source and evaluates it against four stubbed packetMeta shapes.
// If the block drifts, the test fails to extract or fails to assert.

import fs from "node:fs";

const SRC = "functions_clean/createCustomerReviewLinkV1.js";
const src = fs.readFileSync(SRC, "utf8");

// Extract the guard + pinnedPacket-construction block. Anchored on the
// marker comment header through the closing brace of the pinnedPacket
// object literal.
const m = src.match(
  /\/\/ PEAKOPS_REVIEW_VERSION_PIN_V1 \(2026-06-15\)[\s\S]*?const pinnedPacket = \{[\s\S]*?\n    \};\n/,
);
if (!m) {
  console.error(`FAIL: PEAKOPS_REVIEW_VERSION_PIN_V1 block not found in ${SRC}`);
  process.exit(1);
}
const block = m[0];

// Hand-port the file's trimStr helper (one-liner) so the block can call it.
const trimStrSrc = `function trimStr(v){ return String(v==null?"":v).trim(); }`;

// FieldValue stub — sentinel that we can identify in the output.
const FieldValueStub = { serverTimestamp: () => "@@SERVER_TIMESTAMP@@" };

function runBlock(packetMeta, orgId = "org-A", incidentId = "inc-A", actorUid = "uid-A") {
  let captured = null;                       // last j(res, status, body)
  let pinnedPacketOut = null;                // local from the block
  const j = (_r, status, body) => { captured = { status, body }; };
  const incData = packetMeta == null ? {} : { packetMeta };
  const console_ = { warn: () => {} };
  // Build the runner. The block ends with `const pinnedPacket = {…};`,
  // which is a local — surface it explicitly so the test can inspect.
  // eslint-disable-next-line no-new-func
  const runner = new Function(
    "incData, orgId, incidentId, actorUid, j, res, console, FieldValue, trimStr",
    `${trimStrSrc}\n${block}\nreturn typeof pinnedPacket === 'undefined' ? null : pinnedPacket;`,
  );
  pinnedPacketOut = runner(incData, orgId, incidentId, actorUid, j, {}, console_, FieldValueStub, trimStrSrc);
  return { captured, pinnedPacket: pinnedPacketOut };
}

const SAMPLE_PM = {
  packetVersion: 17,
  storagePath: "exports/incidents/inc_X/v17__Fiber_splice_verification_Jun15__v17.zip",
  bucket: "peakops-pilot.firebasestorage.app",
  zipSha256: "abcd1234567890",
  originalRecordHash: "sha256:zzzz9999",
  exportedAt: "2026-06-15T18:27:14Z",
};

let pass = true;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) pass = false;
}

console.log("=== CASE 1: full packetMeta → no 409, pinnedPacket built with all 8 fields ===");
{
  const r = runBlock(SAMPLE_PM);
  check("no 409 captured", r.captured === null);
  check("pinnedPacket present", r.pinnedPacket !== null);
  if (r.pinnedPacket) {
    const p = r.pinnedPacket;
    check("pinnedPacket.version === 17 (number)", p.version === 17 && typeof p.version === "number");
    check("pinnedPacket.fileName basename", p.fileName === "v17__Fiber_splice_verification_Jun15__v17.zip", `(got ${p.fileName})`);
    check("pinnedPacket.storagePath full path", p.storagePath === SAMPLE_PM.storagePath);
    check("pinnedPacket.bucket carried", p.bucket === SAMPLE_PM.bucket);
    check("pinnedPacket.zipSha256 carried", p.zipSha256 === SAMPLE_PM.zipSha256);
    check("pinnedPacket.originalRecordHash carried", p.originalRecordHash === SAMPLE_PM.originalRecordHash);
    check("pinnedPacket.generatedAt carried", p.generatedAt === SAMPLE_PM.exportedAt);
    check("pinnedPacket.pinnedAt = serverTimestamp sentinel", p.pinnedAt === "@@SERVER_TIMESTAMP@@");
    check("exactly 8 keys", Object.keys(p).length === 8, `(got ${Object.keys(p).join(",")})`);
  }
}

console.log("");
console.log("=== CASE 2: no packetMeta at all → 409 no_packet_yet ===");
{
  const r = runBlock(null);
  check("no pinnedPacket built", !r.pinnedPacket);
  check("captured response is 409", r.captured && r.captured.status === 409);
  check("error code = 'no_packet_yet'", r.captured?.body?.error === "no_packet_yet");
  check("ok: false on body", r.captured?.body?.ok === false);
  check("detail present", typeof r.captured?.body?.detail === "string" && r.captured.body.detail.length > 0);
}

console.log("");
console.log("=== CASE 3: packetMeta missing packetVersion → 409 no_packet_yet ===");
{
  const r = runBlock({ storagePath: "exports/x.zip", zipSha256: "abc" });
  check("no pinnedPacket built", !r.pinnedPacket);
  check("409 no_packet_yet", r.captured && r.captured.status === 409 && r.captured.body?.error === "no_packet_yet");
}

console.log("");
console.log("=== CASE 4: packetMeta missing storagePath → 409 no_packet_yet ===");
{
  const r = runBlock({ packetVersion: 5, zipSha256: "abc" });
  check("no pinnedPacket built", !r.pinnedPacket);
  check("409 no_packet_yet", r.captured && r.captured.status === 409 && r.captured.body?.error === "no_packet_yet");
}

console.log("");
console.log("=== CASE 5: packetMeta packetVersion is non-numeric ('abc') → 409 ===");
{
  const r = runBlock({ packetVersion: "abc", storagePath: "exports/x.zip" });
  check("409 no_packet_yet (Number.isFinite gate)", r.captured && r.captured.status === 409 && r.captured.body?.error === "no_packet_yet");
}

console.log("");
if (pass) { console.log("✅ all assertions pass"); process.exit(0); }
console.log("❌ at least one assertion failed"); process.exit(1);
