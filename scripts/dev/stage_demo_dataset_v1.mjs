#!/usr/bin/env node
// Demo Dataset v1 — stages 3 showcase incidents on alpha so a
// telecom prospect exploring the org sees realistic variety beyond
// the Northgate Mutual + Internal Alpha Test pair.
//
// Idempotent: hardcoded incident IDs. Re-running skips already-
// created records (createIncidentV1 returns 409 — caught + ignored).
//
// Records:
//   A — demo_field_work_001       Cascade Fiber Networks      in_progress
//   B — demo_rejected_001         Riverbend Power & Light     customer_rejected
//   C — demo_draft_001            Pioneer Broadband Coop      draft (open intake)

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const sha256 = (s) => createHash("sha256").update(String(s || ""), "utf8").digest("hex");
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const ORG = "peakops-internal-alpha";
const OWNER_UID = "dMHgyxL2queI83frr2OVdCVSrzy1";
const ADMIN_UID = "qTZahBZ59UTHj0CGNSdjF8ivyhX2";

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

function ok(s)  { return `\x1b[32m${s}\x1b[0m`; }
function bad(s) { return `\x1b[31m${s}\x1b[0m`; }
function head(t) { console.log("\n══ " + t + " " + "═".repeat(Math.max(0, 60 - t.length))); }
function sub(t) { console.log("  • " + t); }

async function post(fn, body) {
  const r = await fetch(`${FN}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}

function need(label, r, allowExistsErr = false) {
  if (r.status < 200 || r.status >= 300 || (r.body && r.body.ok === false)) {
    if (allowExistsErr && typeof r.body === "object" && /already exists/i.test(String(r.body.error || ""))) {
      console.log(`    ${ok("✓")} ${label} — already exists, skipping create`);
      return false;
    }
    console.log(bad(`    ✗ FAIL ${label}  status=${r.status}  body=${JSON.stringify(r.body).slice(0, 300)}`));
    process.exit(1);
  }
  return true;
}

async function uploadEvidence({ incidentId, sessionId, jobId, fileName, label }) {
  let r = await post("createEvidenceUploadUrlV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    fileName, contentType: "image/png",
  });
  need(`createEvidenceUploadUrlV1(${fileName})`, r);
  const { uploadUrl, uploadMethod, storagePath, bucket } = r.body;
  const put = await fetch(uploadUrl, {
    method: uploadMethod,
    headers: { "content-type": "image/png" },
    body: PNG_1x1,
  });
  if (!put.ok) { console.log(bad(`    ✗ GCS PUT ${fileName} → ${put.status}`)); process.exit(1); }
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  r = await post("addEvidenceV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID, jobId,
    bucket, storagePath,
    fileName, originalName: fileName,
    contentType: "image/png", sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "DAMAGE", labels: [label],
    gps: { lat: 45.5152, lng: -122.6784, accuracyM: 6 },
  });
  need(`addEvidenceV1(${fileName})`, r);
}

// ── RECORD A — in_progress, partial proof captured, notes ────────
async function stageRecordA() {
  head("RECORD A — Cascade Fiber Networks (in_progress)");
  const incidentId = "demo_field_work_001";
  sub(`incidentId = ${incidentId}`);

  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: "Splice cabinet repair — North Loop cabinet 14",
    status: "open",
    archetype: "fiber_splice_verification",
    filingTypesRequired: ["DIRS"],
    location: "1820 Burnside St, Portland OR",
    customer: "Cascade Fiber Networks",
    priority: "normal",
    notes: "Damage from buried-cable strike. Replaced spliced fiber sleeve; pending splice loss measurement (OTDR) before submission.",
  });
  if (!need("createIncidentV1(A)", r, true)) return incidentId;

  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: "Splice repair — segment 4",
  });
  need("createJobV1(A)", r);
  const jobId = r.body.job?.jobId || r.body.jobId;
  sub(`jobId = ${jobId}`);

  r = await post("startFieldSessionV1", { orgId: ORG, incidentId, actorUid: OWNER_UID, techUserId: OWNER_UID });
  need("startFieldSessionV1(A)", r);
  const sessionId = r.body.sessionId;
  sub(`sessionId = ${sessionId}`);

  r = await post("markArrivedV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    gps: { lat: 45.5152, lng: -122.6784, accuracyM: 6 },
  });
  need("markArrivedV1(A)", r);

  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "site_arrival_north_loop.png", label: "ARRIVAL" });
  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "splice_damage_before.png",    label: "BEFORE" });
  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "new_splice_tray.png",         label: "DURING" });
  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "equipment_serial_label.png",  label: "EQUIPMENT" });
  sub(`evidence: 4 items attached`);

  // Emit NOTES_SAVED timeline event directly so the IncidentClient
  // reads notes as present. The timeline_events collection is the
  // authoritative source for "what happened on this record."
  await db.collection(`incidents/${incidentId}/timeline_events`).add({
    type: "NOTES_SAVED",
    actor: OWNER_UID,
    occurredAt: FieldValue.serverTimestamp(),
    meta: { source: "demo_dataset_v1", noteLength: 132 },
  });
  sub(`notes saved (timeline event written)`);

  // Leave the job at in_progress (status auto-flipped from open via
  // startFieldSession). Do NOT mark complete — record A's whole point
  // is "still in progress, OTDR trace pending."
  sub(`final state: in_progress with partial proof + arrived + notes`);
  return incidentId;
}

// ── RECORD B — full lifecycle to customer_rejected ──────────────
async function stageRecordB() {
  head("RECORD B — Riverbend Power & Light (customer_rejected)");
  const incidentId = "demo_rejected_001";
  sub(`incidentId = ${incidentId}`);

  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: "Pole inspection — Highline crossing route 7",
    status: "open",
    archetype: "pole_inspection",
    filingTypesRequired: ["DIRS"],
    location: "Highline Service Road, Mile 12, Spokane Valley WA",
    customer: "Riverbend Power & Light",
    priority: "normal",
    notes: "Annual contracted pole inspection on the Highline 12kv crossing. Climbed, photographed, tested.",
  });
  if (!need("createIncidentV1(B)", r, true)) return { incidentId, caseId: null };

  r = await post("createJobV1", { orgId: ORG, incidentId, actorUid: OWNER_UID, title: "Pole #4892 climb + condition photos" });
  need("createJobV1(B)", r);
  const jobId = r.body.job?.jobId || r.body.jobId;

  r = await post("startFieldSessionV1", { orgId: ORG, incidentId, actorUid: OWNER_UID, techUserId: OWNER_UID });
  need("startFieldSessionV1(B)", r);
  const sessionId = r.body.sessionId;

  r = await post("markArrivedV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    gps: { lat: 47.6679, lng: -117.2389, accuracyM: 8 },
  });
  need("markArrivedV1(B)", r);

  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "pole_exterior_wide.png", label: "WIDE" });
  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "climbing_harness_inuse.png", label: "PPE" });
  await uploadEvidence({ incidentId, sessionId, jobId, fileName: "pole_tag_id_plate.png", label: "ID_PLATE" });
  sub(`evidence: 3 items attached`);

  for (const [fn, body] of [
    ["markJobCompleteV1", { orgId: ORG, incidentId, jobId, actorUid: OWNER_UID, sessionId }],
    ["submitFieldSessionV1", { orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID }],
    ["updateJobStatusV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID, status: "review" }],
    ["approveJobV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID }],
    ["closeIncidentV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID }],
    ["exportIncidentPacketV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID }],
  ]) {
    const rr = await post(fn, body); need(`${fn}(B)`, rr);
  }
  sub("packet v1 minted");

  r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
    customerEmail: "nick+riverbend@pioneercomclean.com",
  });
  need("createCustomerReviewLinkV1(B)", r);
  const tokenB = r.body.token;
  sub(`customer review link minted`);

  r = await post("submitCustomerReviewV1", {
    token: tokenB, action: "reject",
    comment: "Need OSHA fall-protection signoff photo before we can accept. Photo 2 shows climber without secondary lanyard — that's not compliant with our contractor PPE addendum. Please reshoot with both lanyards visible.",
  });
  need("submitCustomerReviewV1-reject(B)", r);

  await new Promise(res => setTimeout(res, 2000));
  const casesQ = await db.collection(`orgs/${ORG}/recovery_cases`).where("incidentId", "==", incidentId).limit(1).get();
  const caseId = casesQ.empty ? null : casesQ.docs[0].id;
  sub(`recovery case auto-created: ${caseId || "(none — autoCreate may have failed)"}`);

  sub("final state: customer_rejected with auto-created recovery case");
  return { incidentId, caseId };
}

// ── RECORD C — draft / clean intake state ────────────────────────
async function stageRecordC() {
  head("RECORD C — Pioneer Broadband Cooperative (draft)");
  const incidentId = "demo_draft_001";
  sub(`incidentId = ${incidentId}`);

  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: "Aerial fiber pull — Westport to Mill District backhaul",
    status: "draft",
    archetype: "fiber_splice_verification",
    filingTypesRequired: ["DIRS"],
    location: "Westport Substation Yard, Eugene OR",
    customer: "Pioneer Broadband Cooperative",
    priority: "high",
  });
  if (!need("createIncidentV1(C)", r, true)) return incidentId;

  sub("final state: draft — no jobs, no sessions, no evidence (clean intake)");
  return incidentId;
}

// ── main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`Demo Dataset v1 — staging on ${PROJECT}/${ORG}`);
  const aId = await stageRecordA();
  const bResult = await stageRecordB();
  const cId = await stageRecordC();

  console.log("\n══ Created incidents ══════════════════════════════════════════");
  console.log(`  A: ${aId}`);
  console.log(`  B: ${bResult.incidentId}  (recovery case: ${bResult.caseId || "n/a"})`);
  console.log(`  C: ${cId}`);
  console.log("");
  console.log("Next: add these IDs to PROTECTED_DEMO_IDS in lib/incidents/demoHygiene.ts:");
  console.log(`  "${aId}",`);
  console.log(`  "${bResult.incidentId}",`);
  console.log(`  "${cId}",`);
}

main().catch((e) => { console.error("unexpected:", e?.stack || e); process.exit(2); });
