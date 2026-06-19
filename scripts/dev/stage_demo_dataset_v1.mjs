#!/usr/bin/env node
// Demo Dataset v1 — stages 3 showcase incidents on alpha so a
// telecom prospect exploring the org sees realistic variety beyond
// the Northgate Mutual + Internal Alpha Test pair.
//
// Idempotent in two senses:
//   1. createIncidentV1 returns 409 on existing IDs → caught + skipped.
//   2. After create-or-skip, a patch pass unconditionally upserts the
//      title/notes/location/customer fields (canonical + legacy) plus
//      Record A's job title and Record B's rejection comment +
//      derived recovery cause. Re-running converges to spec.
//
// Records:
//   A — demo_field_work_001       Cascade Fiber Networks      in_progress
//                                 Fiber splice verification — Segment 14
//   B — demo_rejected_001         Riverbend Power & Light     customer_rejected
//                                 OTDR validation — East Ring  (missing OTDR)
//   C — demo_draft_001            Pioneer Broadband Coop      draft (open intake)
//                                 Cabinet inspection — North Spokane

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

// ── Spec (single source for both create + patch passes) ─────────
const SPEC = {
  A: {
    incidentId: "demo_field_work_001",
    title: "Fiber splice verification — Segment 14",
    notes: "Splice loss reading pending OTDR trace. Cleaned and re-spliced cassette in cabinet; awaiting end-to-end loss measurement before submission.",
    location: "Segment 14 splice cabinet, Burnside Loop, Portland OR",
    customer: "Cascade Fiber Networks",
    priority: "normal",
    archetype: "fiber_splice_verification",
    jobTitle: "Splice verification — Segment 14 cassette A",
  },
  B: {
    incidentId: "demo_rejected_001",
    title: "OTDR validation — East Ring",
    notes: "End-to-end OTDR validation on the East Ring backhaul. Re-spliced two vaults, ran loss measurement, photographed labels.",
    location: "East Ring vault E-14, Spokane Valley WA",
    customer: "Riverbend Power & Light",
    priority: "normal",
    archetype: "fiber_splice_verification",
    rejectionComment: "Missing OTDR trace — the packet shows splice photos but no loss measurement printout. Please attach the OTDR end-to-end trace before we can sign off.",
    // "otdr" / "test result" / "missing" all map to missing_test_result
    // via CUSTOMER_COMMENT_CAUSE_KEYWORDS (otdr wins, first match).
    causePrimary: "missing_test_result",
  },
  C: {
    incidentId: "demo_draft_001",
    title: "Cabinet inspection — North Spokane",
    notes: null,
    location: "Cabinet 4187, N Maple St, Spokane WA",
    customer: "Pioneer Broadband Cooperative",
    priority: "high",
    archetype: "fiber_splice_verification",
  },
};

// ── RECORD A — in_progress, partial proof captured, notes ────────
async function stageRecordA() {
  head("RECORD A — Cascade Fiber Networks (in_progress)");
  const incidentId = SPEC.A.incidentId;
  sub(`incidentId = ${incidentId}`);

  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: SPEC.A.title,
    status: "open",
    archetype: SPEC.A.archetype,
    filingTypesRequired: ["DIRS"],
    location: SPEC.A.location,
    customer: SPEC.A.customer,
    priority: SPEC.A.priority,
    notes: SPEC.A.notes,
  });
  if (!need("createIncidentV1(A)", r, true)) return incidentId;

  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: SPEC.A.jobTitle,
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
    title: SPEC.B.title,
    status: "open",
    archetype: SPEC.B.archetype,
    filingTypesRequired: ["DIRS"],
    location: SPEC.B.location,
    customer: SPEC.B.customer,
    priority: SPEC.B.priority,
    notes: SPEC.B.notes,
  });
  if (!need("createIncidentV1(B)", r, true)) return { incidentId, caseId: null };

  r = await post("createJobV1", { orgId: ORG, incidentId, actorUid: OWNER_UID, title: "OTDR pass — East Ring backhaul" });
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
    comment: SPEC.B.rejectionComment,
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
    title: SPEC.C.title,
    status: "draft",
    archetype: SPEC.C.archetype,
    filingTypesRequired: ["DIRS"],
    location: SPEC.C.location,
    customer: SPEC.C.customer,
    priority: SPEC.C.priority,
  });
  if (!need("createIncidentV1(C)", r, true)) return incidentId;

  sub("final state: draft — no jobs, no sessions, no evidence (clean intake)");
  return incidentId;
}

// ── Patch pass — converge spec-drifting fields on existing docs ──
// Runs after stageRecord{A,B,C} regardless of create-or-skip. Spec
// lives in the SPEC object above; this function unconditionally
// upserts the visible fields so a refined demo brief just needs the
// new strings in SPEC + a re-run.

async function patchIncidentDoc(incidentId, fields) {
  const update = { ...fields, updatedAt: FieldValue.serverTimestamp() };
  // Canonical (orgs/{org}/incidents/{id}) is the source of truth
  // post-PR 97. Legacy (incidents/{id}) is dual-written by createIncidentV1
  // — patch both so getIncident fallbacks read the same shape.
  await db.doc(`orgs/${ORG}/incidents/${incidentId}`).set(update, { merge: true });
  await db.doc(`incidents/${incidentId}`).set(update, { merge: true }).catch(() => {});
  sub(`patched incident fields: ${Object.keys(fields).join(", ")}`);
}

async function patchFirstJobTitle(incidentId, newTitle) {
  // Jobs live under both incidents/{id}/jobs and orgs/{org}/incidents/{id}/jobs
  // (dual-write). Patch whichever exists.
  let jobs = await db.collection(`incidents/${incidentId}/jobs`).limit(1).get();
  let path = "incidents";
  if (jobs.empty) {
    jobs = await db.collection(`orgs/${ORG}/incidents/${incidentId}/jobs`).limit(1).get();
    path = "orgs";
  }
  if (jobs.empty) { sub(`no job found to patch on ${incidentId}`); return; }
  const jobId = jobs.docs[0].id;
  await db.doc(`incidents/${incidentId}/jobs/${jobId}`).set({ title: newTitle }, { merge: true }).catch(() => {});
  await db.doc(`orgs/${ORG}/incidents/${incidentId}/jobs/${jobId}`).set({ title: newTitle }, { merge: true }).catch(() => {});
  sub(`patched first job title (${path} path, jobId=${jobId}): ${newTitle}`);
}

async function patchRecoveryCause(incidentId, comment, causePrimary) {
  const casesQ = await db.collection(`orgs/${ORG}/recovery_cases`).where("incidentId", "==", incidentId).limit(1).get();
  if (casesQ.empty) { sub(`no recovery case to patch for ${incidentId}`); return; }
  const ref = casesQ.docs[0].ref;
  await ref.set({
    cause: {
      primary: causePrimary,
      customerComment: comment,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  sub(`patched recovery case ${ref.id}: cause.primary=${causePrimary}`);
}

async function patchRecordsToSpec() {
  head("PATCH PASS — converge to current SPEC");

  await patchIncidentDoc(SPEC.A.incidentId, {
    title: SPEC.A.title,
    notes: SPEC.A.notes,
    location: SPEC.A.location,
    customer: SPEC.A.customer,
    priority: SPEC.A.priority,
    archetype: SPEC.A.archetype,
  });
  await patchFirstJobTitle(SPEC.A.incidentId, SPEC.A.jobTitle);

  await patchIncidentDoc(SPEC.B.incidentId, {
    title: SPEC.B.title,
    notes: SPEC.B.notes,
    location: SPEC.B.location,
    customer: SPEC.B.customer,
    priority: SPEC.B.priority,
    archetype: SPEC.B.archetype,
    customerRejectionComment: SPEC.B.rejectionComment,
  });
  await patchRecoveryCause(SPEC.B.incidentId, SPEC.B.rejectionComment, SPEC.B.causePrimary);

  await patchIncidentDoc(SPEC.C.incidentId, {
    title: SPEC.C.title,
    location: SPEC.C.location,
    customer: SPEC.C.customer,
    priority: SPEC.C.priority,
    archetype: SPEC.C.archetype,
  });
}

// ── main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`Demo Dataset v1 — staging on ${PROJECT}/${ORG}`);
  const aId = await stageRecordA();
  const bResult = await stageRecordB();
  const cId = await stageRecordC();
  await patchRecordsToSpec();

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
