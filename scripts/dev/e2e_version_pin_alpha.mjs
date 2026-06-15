#!/usr/bin/env node
// End-to-end verification of version-pinned customer review (slices 1–4)
// on peakops-internal-alpha / peakops-pilot.
//
// Creates a FRESH alpha incident and drives the full happy path:
//   create → addJob → startSession → markArrived → uploadEvidence →
//   markJobComplete → submitFieldSession → updateJobStatus →
//   approveJob → closeIncident → exportIncidentPacket → mint review
//   link (Slice 1 pin) → fetch review (Slice 2 read) → submit accept
//   (Slice 3 reviewedPacket) → verify Summary panel state (Slice 4).
//
// Stops at first non-2xx response and prints the exact failure.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const sha256 = (s) => createHash("sha256").update(String(s||""), "utf8").digest("hex");
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const ORG = "peakops-internal-alpha";
const OWNER_UID = "dMHgyxL2queI83frr2OVdCVSrzy1";    // role=owner
const ADMIN_UID = "qTZahBZ59UTHj0CGNSdjF8ivyhX2";    // role=admin
const CUSTOMER_EMAIL = "nick+e2e@pioneercomclean.com";

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function ok(s)  { return `\x1b[32m${s}\x1b[0m`; }
function bad(s) { return `\x1b[31m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function head(n, title) { console.log(`\n── ${n}. ${title} ${"─".repeat(Math.max(0, 60-title.length))}`); }

async function post(fn, body) {
  const r = await fetch(`${FN_BASE}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text, raw: text };
}
async function get(fn, qs) {
  const url = `${FN_BASE}/${fn}?${new URLSearchParams(qs).toString()}`;
  const r = await fetch(url);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text, raw: text };
}
function require200(label, res) {
  if (res.status < 200 || res.status >= 300 || (res.body && res.body.ok === false)) {
    console.log(bad(`✗ FAIL at ${label} — status=${res.status}`));
    console.log("  body:", typeof res.body === "string" ? res.body.slice(0, 600) : JSON.stringify(res.body).slice(0, 800));
    process.exit(1);
  }
}

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

async function readIncident(incidentId) {
  // Both paths, prefer canonical
  const c = await db.doc(`orgs/${ORG}/incidents/${incidentId}`).get();
  if (c.exists) return c.data();
  const l = await db.doc(`incidents/${incidentId}`).get();
  return l.exists ? l.data() : null;
}

async function main() {
  console.log(`E2E version-pin verification — ${PROJECT}/${ORG}`);

  // ── 1. createIncidentV1 ────────────────────────────────────────
  head(1, "createIncidentV1 (fresh)");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const incidentId = `e2e_vp_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: "E2E version-pin verification — fresh incident",
    status: "open",
    archetype: "fiber",
    filingTypesRequired: ["DIRS"],
    location: "Internal Alpha Test — Seattle",
    customer: "Internal Alpha",
    priority: "normal",
  });
  require200("createIncidentV1", r);
  console.log(ok(`  ✓ created incidentId=${incidentId}`));

  // ── 2. createJobV1 ─────────────────────────────────────────────
  head(2, "createJobV1");
  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: "Splice cabinet inspection — E2E job",
  });
  require200("createJobV1", r);
  const jobId = r.body.job?.jobId || r.body.jobId;
  console.log(ok(`  ✓ jobId=${jobId}`));

  // ── 3. startFieldSessionV1 + markArrivedV1 ─────────────────────
  head(3, "startFieldSession + markArrived");
  r = await post("startFieldSessionV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID, techUserId: OWNER_UID,
  });
  require200("startFieldSessionV1", r);
  const sessionId = r.body.sessionId;
  console.log(`  ✓ sessionId=${sessionId}`);

  r = await post("markArrivedV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    gps: { lat: 47.6062, lng: -122.3321, accuracyM: 8 },
  });
  require200("markArrivedV1", r);
  console.log(ok(`  ✓ field arrived`));

  // ── 4. createEvidenceUploadUrlV1 + GCS PUT + addEvidenceV1 ─────
  head(4, "Evidence upload + register");
  r = await post("createEvidenceUploadUrlV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    fileName: "e2e_evidence.png", contentType: "image/png",
  });
  require200("createEvidenceUploadUrlV1", r);
  const { uploadUrl, uploadMethod, storagePath, bucket } = r.body;

  const putRes = await fetch(uploadUrl, {
    method: uploadMethod,
    headers: { "content-type": "image/png" },
    body: PNG_1x1,
  });
  if (!putRes.ok) {
    console.log(bad(`✗ FAIL GCS PUT — status=${putRes.status}`));
    console.log("  ", (await putRes.text()).slice(0, 400));
    process.exit(1);
  }
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  r = await post("addEvidenceV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    jobId,                                  // assign at create time
    bucket, storagePath,
    fileName: "e2e_evidence.png",
    originalName: "e2e_evidence.png",
    contentType: "image/png",
    sizeBytes: PNG_1x1.length,
    sha256: sha,
    phase: "DAMAGE",
    labels: ["DAMAGE"],
    gps: { lat: 47.6062, lng: -122.3321, accuracyM: 8 },
  });
  require200("addEvidenceV1", r);
  const evidenceId = r.body.evidenceId || r.body.evidence?.evidenceId;
  console.log(ok(`  ✓ evidenceId=${evidenceId}  (assigned to jobId at create)`));

  // ── 5. markJobCompleteV1 ───────────────────────────────────────
  head(5, "markJobCompleteV1");
  r = await post("markJobCompleteV1", {
    orgId: ORG, incidentId, jobId, actorUid: OWNER_UID, sessionId,
  });
  require200("markJobCompleteV1", r);
  console.log(ok(`  ✓ job complete`));

  // ── 6. submitFieldSessionV1 (emits field_submitted) ────────────
  head(6, "submitFieldSessionV1");
  r = await post("submitFieldSessionV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
  });
  require200("submitFieldSessionV1", r);
  console.log(ok(`  ✓ session submitted`));

  // ── 7. updateJobStatusV1 complete → review ─────────────────────
  head(7, "updateJobStatus complete → review");
  r = await post("updateJobStatusV1", {
    orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID, status: "review",
  });
  require200("updateJobStatusV1(review)", r);
  console.log(ok(`  ✓ in review`));

  // ── 8. approveJobV1 ────────────────────────────────────────────
  head(8, "approveJobV1");
  r = await post("approveJobV1", {
    orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID,
  });
  require200("approveJobV1", r);
  console.log(ok(`  ✓ job approved`));

  // ── 9. closeIncidentV1 ─────────────────────────────────────────
  head(9, "closeIncidentV1");
  r = await post("closeIncidentV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
  });
  require200("closeIncidentV1", r);
  console.log(ok(`  ✓ incident closed`));

  // ── 10. exportIncidentPacketV1 ─────────────────────────────────
  head(10, "exportIncidentPacketV1");
  r = await post("exportIncidentPacketV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
  });
  require200("exportIncidentPacketV1", r);
  const postExport = await readIncident(incidentId);
  const pkt = postExport.packetMeta || {};
  console.log(`  ✓ packet v${pkt.packetVersion}  zipSha256=${(pkt.zipSha256||"").slice(0,16)}…`);
  console.log(`    storagePath=${pkt.storagePath}`);
  console.log(`    download (signed): ${r.body.downloadUrl ? r.body.downloadUrl.slice(0, 80)+"…" : "<none>"}`);

  // ── 11. createCustomerReviewLinkV1 (Slice 1: pin packet) ───────
  head(11, "createCustomerReviewLinkV1 (Slice 1 — pin)");
  r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
    customerEmail: CUSTOMER_EMAIL,
  });
  require200("createCustomerReviewLinkV1", r);
  const token = r.body.token || r.body.reviewToken || r.body.link?.token;
  const tokenHash = sha256(token);
  console.log(`  ✓ token=${token?.slice(0,12)}…  hash=${tokenHash.slice(0,12)}…`);
  const linkSnap = await db.doc(`customer_review_links/${tokenHash}`).get();
  const link = linkSnap.data() || {};
  if (!link.pinnedPacket) { console.log(bad("✗ slice 1: pinnedPacket ABSENT")); process.exit(1); }
  console.log(`  link.pinnedPacket = { v:${link.pinnedPacket.version} hash:${link.pinnedPacket.zipSha256?.slice(0,16)}… pinnedAt:${link.pinnedPacket.pinnedAt?.toDate?.()?.toISOString()} }`);
  if (link.pinnedPacket.version !== pkt.packetVersion) {
    console.log(bad(`✗ pinned v${link.pinnedPacket.version} ≠ exported v${pkt.packetVersion}`)); process.exit(1);
  }

  // ── 12. getCustomerReviewV1 (Slice 2: composes packet block) ───
  head(12, "getCustomerReviewV1 (Slice 2 — read)");
  r = await get("getCustomerReviewV1", { token });
  require200("getCustomerReviewV1", r);
  const rv = r.body;
  if (!rv.packet || !rv.packet.pinned) {
    console.log(bad("✗ slice 2: packet/pinned missing")); console.log(JSON.stringify(rv,null,2).slice(0,800)); process.exit(1);
  }
  console.log(`  packet.pinned   = { v:${rv.packet.pinned.version} hash:${rv.packet.pinned.hashPrefix} }`);
  console.log(`  packet.current  = { v:${rv.packet.current?.version} hash:${rv.packet.current?.hashPrefix} }`);
  console.log(`  packet.isLatest = ${rv.packet.isLatest}`);
  if (rv.packet.isLatest !== true) { console.log(bad(`✗ isLatest=${rv.packet.isLatest} expected true`)); process.exit(1); }
  console.log(ok(`  ✓ customer screen shows v${rv.packet.pinned.version}  isLatest=true`));

  // ── 13. submitCustomerReviewV1 accept (Slice 3 — reviewedPacket)
  head(13, "submitCustomerReviewV1 action=accept (Slice 3)");
  r = await post("submitCustomerReviewV1", {
    token, action: "accept",
    comment: "E2E acceptance — version-pinned customer review path.",
  });
  require200("submitCustomerReviewV1", r);
  console.log(ok(`  ✓ submit accepted`));

  // ── 14. Verify durable slice 3 fields ──────────────────────────
  head(14, "Verify reviewedPacket + incident summary fields");
  const linkAfter = (await db.doc(`customer_review_links/${tokenHash}`).get()).data() || {};
  if (!linkAfter.reviewedPacket) { console.log(bad("✗ link.reviewedPacket ABSENT")); process.exit(1); }
  console.log(`  link.reviewedPacket = { v:${linkAfter.reviewedPacket.version} action:${linkAfter.reviewedPacket.action} hash:${linkAfter.reviewedPacket.zipSha256?.slice(0,16)}… reviewedAt:${linkAfter.reviewedPacket.reviewedAt?.toDate?.()?.toISOString()} }`);

  const inc = await readIncident(incidentId);
  console.log(`  incident.status                          = ${inc.status}`);
  console.log(`  incident.customerAcceptedPacketVersion   = ${inc.customerAcceptedPacketVersion ?? bad("MISSING")}`);
  console.log(`  incident.customerAcceptedPacketHash      = ${(inc.customerAcceptedPacketHash||"").slice(0,16)}…`);
  console.log(`  incident.customerAcceptedAt              = ${inc.customerAcceptedAt?.toDate?.()?.toISOString?.() || "<absent>"}`);
  console.log(`  incident.customerAcceptanceComment       = ${JSON.stringify(inc.customerAcceptanceComment || null)}`);
  console.log(`  incident.packetMeta.packetVersion        = ${inc.packetMeta?.packetVersion}`);

  if (inc.customerAcceptedPacketVersion !== pkt.packetVersion) {
    console.log(bad(`✗ acceptedV=${inc.customerAcceptedPacketVersion} ≠ packet v=${pkt.packetVersion}`)); process.exit(1);
  }

  // ── 15. Slice 4 panel-state derivation ─────────────────────────
  head(15, "Slice 4 — derived Summary panel state");
  const latestV = inc.packetMeta?.packetVersion;
  const acceptedV = inc.customerAcceptedPacketVersion;
  let state;
  if (inc.status === "customer_rejected") state = "rejected";
  else if (inc.status === "submitted_to_customer") state = "awaiting";
  else if (inc.status === "customer_accepted") {
    if (acceptedV == null) state = "accepted_legacy";
    else if (acceptedV === latestV) state = "up_to_date";
    else state = "out_of_date";
  } else state = "(suppressed — wrong status)";
  console.log(`  status=${inc.status}  latestV=${latestV}  acceptedV=${acceptedV}`);
  console.log(`  → panel state: ${ok(state)}`);

  console.log(`\n  Summary URL: https://app.peakops.app/incidents/${incidentId}/summary?orgId=${ORG}`);
  console.log(`  Customer review URL (consumed): https://app.peakops.app/review/${token}`);

  if (state === "up_to_date") {
    console.log("\n" + ok("✅ GREEN — slices 1–4 verified end-to-end on prod alpha."));
  } else {
    console.log("\n" + bad(`✗ NOT GREEN — final state=${state}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(bad("unexpected error:"), e?.stack || e);
  process.exit(2);
});
