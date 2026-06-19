#!/usr/bin/env node
// Stages a fresh alpha incident through demo steps 1-9 of the
// PR 133 Recovery dry-run. STOPS just before customer accepts so
// the resubmission review token is live for the operator to click
// through in a browser.
//
// Output: one block of demo-ready URLs + IDs that the operator can
// open in sequence.
//
// IMPORTANT: this is a STAGE-ONLY script. It does NOT consume the
// resubmission token — the user must click /review/{token} in a
// browser and click Accept to complete steps 10-14 by hand.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const sha256 = (s) => createHash("sha256").update(String(s||""), "utf8").digest("hex");
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const ORG = "peakops-internal-alpha";
const OWNER_UID = "dMHgyxL2queI83frr2OVdCVSrzy1";
const ADMIN_UID = "qTZahBZ59UTHj0CGNSdjF8ivyhX2";
const CUSTOMER_EMAIL = "nick+demo@pioneercomclean.com";

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

async function post(fn, body) {
  const r = await fetch(`${FN_BASE}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}
async function get(fn, qs) {
  const r = await fetch(`${FN_BASE}/${fn}?${new URLSearchParams(qs).toString()}`);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}
function need(label, res) {
  if (res.status < 200 || res.status >= 300 || (res.body && res.body.ok === false)) {
    console.error(`FAIL ${label}: status=${res.status} body=${JSON.stringify(res.body).slice(0,400)}`);
    process.exit(1);
  }
}

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

async function main() {
  console.log("Staging demo incident on", `${PROJECT}/${ORG}`);
  console.log("─".repeat(70));

  // ── Create the incident with demo-friendly metadata ────────────
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const incidentId = `demo_${stamp}_${Math.random().toString(36).slice(2,6)}`;
  process.stdout.write("[1/9] createIncidentV1 ... ");
  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: "Fiber splice — 24th Ave N corridor outage",
    status: "open",
    archetype: "fiber",
    filingTypesRequired: ["DIRS"],
    location: "1424 24th Ave N, Seattle WA",
    customer: "Northgate Mutual Telecom",
    priority: "high",
    notes: "Customer-reported outage; splice cabinet vandalism suspected.",
  });
  need("createIncident", r);
  console.log(`incidentId=${incidentId}`);

  // ── Job → arrive → evidence → complete → submit → approve → close
  process.stdout.write("[2/9] createJobV1 + session + arrive ... ");
  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: "Splice cabinet inspection — segment 3",
  });
  need("createJob", r);
  const jobId = r.body.job?.jobId || r.body.jobId;
  r = await post("startFieldSessionV1", { orgId: ORG, incidentId, actorUid: OWNER_UID, techUserId: OWNER_UID });
  need("startFieldSession", r);
  const sessionId = r.body.sessionId;
  r = await post("markArrivedV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    gps: { lat: 47.6906, lng: -122.3447, accuracyM: 6 },
  });
  need("markArrived", r);
  console.log(`jobId=${jobId} sessionId=${sessionId}`);

  process.stdout.write("[3/9] evidence upload + addEvidence ... ");
  r = await post("createEvidenceUploadUrlV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    fileName: "splice_cabinet_v1.png", contentType: "image/png",
  });
  need("createEvidenceUploadUrl", r);
  const { uploadUrl, uploadMethod, storagePath, bucket } = r.body;
  await fetch(uploadUrl, { method: uploadMethod, headers: { "content-type": "image/png" }, body: PNG_1x1 });
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  r = await post("addEvidenceV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID, jobId,
    bucket, storagePath,
    fileName: "splice_cabinet_v1.png",
    originalName: "splice_cabinet_v1.png",
    contentType: "image/png", sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "DAMAGE", labels: ["DAMAGE"],
    gps: { lat: 47.6906, lng: -122.3447, accuracyM: 6 },
  });
  need("addEvidence", r);
  console.log("ok");

  process.stdout.write("[4/9] markJobComplete + submit + review + approve + close ... ");
  for (const [fn, body] of [
    ["markJobCompleteV1",  { orgId: ORG, incidentId, jobId, actorUid: OWNER_UID, sessionId }],
    ["submitFieldSessionV1", { orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID }],
    ["updateJobStatusV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID, status: "review" }],
    ["approveJobV1",       { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID }],
    ["closeIncidentV1",    { orgId: ORG, incidentId, actorUid: ADMIN_UID }],
  ]) {
    const rr = await post(fn, body); need(fn, rr);
  }
  console.log("ok");

  process.stdout.write("[5/9] exportIncidentPacketV1 (v1) ... ");
  r = await post("exportIncidentPacketV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID });
  need("export(v1)", r);
  const incAfterExport1 = (await db.doc(`orgs/${ORG}/incidents/${incidentId}`).get()).data() || {};
  console.log(`packet v${incAfterExport1.packetMeta?.packetVersion}`);

  process.stdout.write("[6/9] createCustomerReviewLinkV1 (initial) ... ");
  r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
    customerEmail: CUSTOMER_EMAIL,
  });
  need("createCustomerReviewLink", r);
  const tokenA = r.body.token;
  console.log(`token=${tokenA.slice(0,16)}…`);

  // ── Customer rejects → auto-create recovery case ───────────────
  process.stdout.write("[7/9] submitCustomerReviewV1 reject (auto-creates case) ... ");
  r = await post("submitCustomerReviewV1", {
    token: tokenA, action: "reject",
    comment: "We need clear OTDR test results for segment 3 plus a wider shot of the cabinet exterior. Photos provided are too close-range to verify the splice context.",
  });
  need("submitCustomerReview(reject)", r);
  await new Promise(res => setTimeout(res, 2000));
  const cases = await db.collection(`orgs/${ORG}/recovery_cases`).where("incidentId", "==", incidentId).limit(1).get();
  if (cases.empty) { console.error("no case auto-created"); process.exit(1); }
  const caseId = cases.docs[0].id;
  console.log(`caseId=${caseId}`);

  // ── Add + complete recovery actions ────────────────────────────
  process.stdout.write("[8/9] addRecoveryActionV1 + complete all actions ... ");
  r = await post("addRecoveryActionV1", {
    orgId: ORG, actorUid: ADMIN_UID, caseId,
    type: "provide_test_results",
    title: "Reattach OTDR traces for segment 3",
    description: "Customer-requested. Capture splice loss budget + reflectance per segment 3.",
    assignee: ADMIN_UID, assigneeRole: "field_lead",
  });
  need("addRecoveryAction", r);
  const actionId = r.body.actionId || r.body.action?.actionId || r.body.action?.id;

  // Also add a wider exterior photo evidence to make the "fix" tangible
  r = await post("createEvidenceUploadUrlV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    fileName: "splice_cabinet_exterior_v2.png", contentType: "image/png",
  });
  need("createEvidenceUploadUrl(v2)", r);
  const upV2 = r.body;
  await fetch(upV2.uploadUrl, { method: upV2.uploadMethod, headers: { "content-type": "image/png" }, body: PNG_1x1 });
  r = await post("addEvidenceV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID, jobId,
    bucket: upV2.bucket, storagePath: upV2.storagePath,
    fileName: "splice_cabinet_exterior_v2.png",
    originalName: "splice_cabinet_exterior_v2.png",
    contentType: "image/png", sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "REPAIR_DONE", labels: ["WIDE_SHOT"],
    gps: { lat: 47.6906, lng: -122.3447, accuracyM: 6 },
  });
  // ↑ may 409 because incident is now in customer_rejected — that's fine for demo, evidence isn't load-bearing.
  // Continue regardless.

  // Close every open action (starter + our added).
  const actions = await db.collection(`orgs/${ORG}/recovery_cases/${caseId}/actions`).get();
  for (const adoc of actions.docs) {
    const a = adoc.data() || {};
    if (a.status === "done" || a.status === "skipped") continue;
    const rr = await post("completeRecoveryFieldWorkV1", {
      orgId: ORG, incidentId, actionId: adoc.id, actorUid: ADMIN_UID,
      status: "done",
      outcome: a.type === "provide_test_results"
        ? "OTDR traces captured & attached; segment 3 loss budget within spec."
        : "Reviewed customer feedback; next steps captured.",
    });
    need(`completeRecoveryFieldWork(${adoc.id})`, rr);
  }
  await new Promise(res => setTimeout(res, 1500));
  const caseAfter = (await db.doc(`orgs/${ORG}/recovery_cases/${caseId}`).get()).data() || {};
  console.log(`case→${caseAfter.status}`);

  // ── Regenerate packet → mint resubmission link (don't consume) ─
  process.stdout.write("[9/9] exportIncidentPacketV1 v2 + mintResubmissionLinkV1 ... ");
  r = await post("exportIncidentPacketV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID });
  need("export(v2)", r);
  const incAfterExport2 = (await db.doc(`orgs/${ORG}/incidents/${incidentId}`).get()).data() || {};
  const packetV2 = incAfterExport2.packetMeta?.packetVersion;

  r = await post("mintResubmissionLinkV1", {
    orgId: ORG, actorUid: ADMIN_UID, caseId,
    changeSummary: "Reattached OTDR traces for segment 3 and added wide-angle exterior shot.",
  });
  need("mintResubmissionLink", r);
  const tokenR = r.body.token;
  console.log(`packet v${packetV2}  resub token=${tokenR.slice(0,16)}…`);

  // ── Output: demo URLs ──────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log("DEMO INCIDENT STAGED — READY FOR DRY-RUN");
  console.log("═".repeat(70));
  console.log(`incidentId    : ${incidentId}`);
  console.log(`caseId        : ${caseId}`);
  console.log(`packet v1     : (rejected by customer)`);
  console.log(`packet v2     : current (about to be sent for re-review)`);
  console.log(`resub token   : ${tokenR}`);
  console.log("");
  console.log("─── CLICK ORDER (open these in this sequence) ────────────────");
  console.log("");
  console.log("Step 1-4: clean incident, packet, validation logs");
  console.log(`  https://app.peakops.app/incidents/${incidentId}/summary?orgId=${ORG}`);
  console.log("  (open one terminal alongside to show passive validation logs)");
  console.log("  → log query:");
  console.log(`    gcloud logging read 'resource.type="cloud_run_revision" AND textPayload=~"compliance_check" AND textPayload=~"${incidentId}"' --project peakops-pilot --freshness=1h`);
  console.log("");
  console.log("Step 5-8: recovery queue + case");
  console.log(`  https://app.peakops.app/recovery?orgId=${ORG}`);
  console.log(`  https://app.peakops.app/recovery/${caseId}?orgId=${ORG}`);
  console.log("");
  console.log("Step 9-11: minted resubmission link (operator already minted)");
  console.log(`  → operator URL above shows the minted-link result`);
  console.log(`  → customer URL (you click this in incognito to act as the customer):`);
  console.log(`     https://app.peakops.app/review/${tokenR}`);
  console.log("");
  console.log("Step 12: in customer browser, click Accept (with any comment).");
  console.log("Step 13: re-load operator summary; Customer Acceptance panel should show UP TO DATE v2.");
  console.log(`  https://app.peakops.app/incidents/${incidentId}/summary?orgId=${ORG}`);
  console.log("Step 14: recovery dashboard reflects recovered.");
  console.log(`  https://app.peakops.app/recovery/${caseId}?orgId=${ORG}`);
  console.log("");
}

main().catch((e) => { console.error("unexpected:", e?.stack || e); process.exit(2); });
