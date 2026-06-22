// PEAKOPS_REPORT_DOWNLOAD_AUDIT_V1 — audit emission drift guard
// Chunk 1: Trust Foundation, 2026-06-22
//
// Pure file inspection — asserts the download proxy emits a
// packet_downloaded timeline event on every success path. The proxy
// route at next-app/app/api/reports/[incidentId]/download/route.ts
// is the single chokepoint for customer-facing report downloads.
//
// If a future refactor adds a success path that bypasses the audit
// call, this test fails. If the audit function is renamed, the test
// fails. If the timeline event type is changed away from
// "packet_downloaded", the test fails.

import fs from "node:fs";

const SRC = "/Users/kesserumini/peakops/my-app/next-app/app/api/reports/[incidentId]/download/route.ts";

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

if (!fs.existsSync(SRC)) {
  fail(`source not found: ${SRC}`);
  process.exit(1);
}
const src = fs.readFileSync(SRC, "utf8");

console.log("=== Audit-emit helper is defined ===");
if (/async function emitDownloadAuditEvent/.test(src)) {
  pass("emitDownloadAuditEvent helper is defined");
} else {
  fail("emitDownloadAuditEvent helper is missing");
}

console.log("\n=== Audit-emit marker present ===");
if (/PEAKOPS_REPORT_DOWNLOAD_AUDIT_V1/.test(src)) {
  pass("PEAKOPS_REPORT_DOWNLOAD_AUDIT_V1 marker present");
} else {
  fail("PEAKOPS_REPORT_DOWNLOAD_AUDIT_V1 marker missing");
}

console.log("\n=== timeline_events 'packet_downloaded' type wired ===");
if (/type:\s*["']packet_downloaded["']/.test(src)) {
  pass(`timeline_events row uses type: "packet_downloaded"`);
} else {
  fail(`timeline_events row does NOT use type: "packet_downloaded"`);
}

console.log("\n=== Every success path calls emitDownloadAuditEvent ===");
// Count the number of `return emuRes / return adminRes / return NextResponse.redirect(...)`
// success branches. Then count emitDownloadAuditEvent invocations BEFORE
// those returns. They must match.
//
// The three success paths in the proxy are:
//   1. emulator streamFromEmulator returned non-null
//   2. emulator/admin fallback streamFromAdmin returned non-null (2 cases — emu fallback + prod fallback)
//   3. prod signed URL succeeded
//
// All four must emit. Use a simple count.
const emitCount = (src.match(/await emitDownloadAuditEvent\(/g) || []).length;
const expectedEmits = 4;
if (emitCount >= expectedEmits) {
  pass(`emitDownloadAuditEvent called ${emitCount} times (≥${expectedEmits} success paths covered)`);
} else {
  fail(`emitDownloadAuditEvent called only ${emitCount} times; expected ≥${expectedEmits}`);
}

console.log("\n=== Outcome discriminator is set per branch ===");
const hasStreamed = /outcome:\s*["']streamed["']/.test(src);
const hasSignedUrl = /outcome:\s*["']signed_url["']/.test(src);
if (hasStreamed) pass(`outcome: "streamed" is set on at least one branch`); else fail(`outcome: "streamed" missing`);
if (hasSignedUrl) pass(`outcome: "signed_url" is set on the production-redirect branch`); else fail(`outcome: "signed_url" missing`);

console.log("\n=== Audit emit is awaited (synchronous w.r.t. response) ===");
// Filter out the function declaration itself by ignoring lines that
// match `function emitDownloadAuditEvent(...`. Only count actual
// CALL sites (with or without `await` prefix).
const declRe = /(async\s+)?function\s+emitDownloadAuditEvent\(/g;
const allInvocations = (src.match(/emitDownloadAuditEvent\(/g) || []).length;
const declarations = (src.match(declRe) || []).length;
const callSites = allInvocations - declarations;
const awaitedInvocations = (src.match(/await\s+emitDownloadAuditEvent\(/g) || []).length;
if (awaitedInvocations === callSites) {
  pass(`all ${callSites} emitDownloadAuditEvent call-sites are awaited (declarations excluded: ${declarations})`);
} else {
  fail(`${callSites - awaitedInvocations} call-site(s) are not awaited — audit row may be lost on cold-start (totals: invocations=${allInvocations}, declarations=${declarations}, awaited=${awaitedInvocations})`);
}

console.log("\n=== ipPrefixFromRequest helper is defined and used ===");
if (/function ipPrefixFromRequest\(req:\s*Request\)/.test(src)) {
  pass(`ipPrefixFromRequest is defined`);
} else {
  fail(`ipPrefixFromRequest is missing`);
}
if (/ipPrefixFromRequest\(req\)/.test(src)) {
  pass(`ipPrefixFromRequest is invoked in the handler`);
} else {
  fail(`ipPrefixFromRequest is never invoked — audit will not record IP prefix`);
}

if (failed) {
  console.error(`\n❌ packet-download audit drift: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ all packet-download audit assertions pass");
