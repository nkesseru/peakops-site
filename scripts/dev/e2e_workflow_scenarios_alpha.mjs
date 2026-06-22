#!/usr/bin/env node
// PEAKOPS_E2E_WORKFLOW_SCENARIOS_V1 — Chunk 2: Workflow Completion
// Author: 2026-06-22
//
// Drives three end-to-end customer workflows against the live
// peakops-pilot project, peakops-internal-alpha org. Each scenario
// builds a fresh incident, walks it through the full lifecycle, and
// asserts every transition lands cleanly.
//
//   Scenario A: open → field work → review → accept (happy path)
//   Scenario B: open → field work → review → reject → rework → resubmit → accept
//   Scenario C: review delivery failure surface — verify mint endpoint
//               surfaces blocked-jobs error visibly
//
// Output: per-scenario pass/fail summary + structured assertions.
// Exit 0 on all green; non-zero on any failure.
//
// Idempotent re-runs are NOT a goal — every run creates fresh incidents
// with timestamped IDs so historical runs don't collide. Use the demo
// hygiene filter (lib/incidents/demoHygiene.ts) to keep these out of
// operator queues.

import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const ORG = "peakops-internal-alpha";
const OWNER_UID = "dMHgyxL2queI83frr2OVdCVSrzy1";
const ADMIN_UID = "qTZahBZ59UTHj0CGNSdjF8ivyhX2";

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

function ok(s) { return `\x1b[32m${s}\x1b[0m`; }
function bad(s) { return `\x1b[31m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const runId = `e2e_chunk2_${stamp}_${randomBytes(2).toString("hex")}`;

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

async function get(url) {
  const r = await fetch(url);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}

function expect(label, condition, detail) {
  if (condition) {
    console.log(`  ${ok("✓")} ${label}` + (detail ? dim(`  (${detail})`) : ""));
    return true;
  }
  console.log(`  ${bad("✗")} ${label}` + (detail ? `  ${bad(detail)}` : ""));
  return false;
}

let failures = 0;
function check(label, condition, detail) {
  if (!expect(label, condition, detail)) failures++;
}

async function uploadOneEvidence(incidentId, sessionId, jobId, fileName, label) {
  let r = await post("createEvidenceUploadUrlV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    fileName, contentType: "image/png",
  });
  if (r.body.ok !== true) { throw new Error(`createEvidenceUploadUrlV1 failed: ${JSON.stringify(r.body)}`); }
  const { uploadUrl, uploadMethod, storagePath, bucket } = r.body;
  const put = await fetch(uploadUrl, {
    method: uploadMethod,
    headers: { "content-type": "image/png" },
    body: PNG_1x1,
  });
  if (!put.ok) { throw new Error(`GCS PUT ${fileName} → ${put.status}`); }
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  r = await post("addEvidenceV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID, jobId,
    bucket, storagePath, fileName, originalName: fileName,
    contentType: "image/png", sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "DAMAGE", labels: [label],
    gps: { lat: 45.5152, lng: -122.6784, accuracyM: 6 },
  });
  if (r.body.ok !== true) { throw new Error(`addEvidenceV1 failed: ${JSON.stringify(r.body)}`); }
}

async function buildIncidentToReviewReady({ incidentId, title }) {
  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title, status: "open",
    archetype: "fiber_splice_verification",
    filingTypesRequired: [],   // chunk1-calibrated — non-DIRS for clean run
    location: "E2E test yard",
    customer: "E2E Telecom",
    priority: "normal",
    notes: "Chunk 2 workflow scenario test.",
  });
  if (r.body.ok !== true) throw new Error(`createIncidentV1: ${JSON.stringify(r.body)}`);

  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: "E2E test job",
  });
  if (r.body.ok !== true) throw new Error(`createJobV1: ${JSON.stringify(r.body)}`);
  const jobId = r.body.job?.jobId || r.body.jobId;

  r = await post("startFieldSessionV1", { orgId: ORG, incidentId, actorUid: OWNER_UID, techUserId: OWNER_UID });
  if (r.body.ok !== true) throw new Error(`startFieldSessionV1: ${JSON.stringify(r.body)}`);
  const sessionId = r.body.sessionId;

  r = await post("markArrivedV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    gps: { lat: 45.5152, lng: -122.6784, accuracyM: 6 },
  });
  if (r.body.ok !== true) throw new Error(`markArrivedV1: ${JSON.stringify(r.body)}`);

  await uploadOneEvidence(incidentId, sessionId, jobId, "before.png", "BEFORE");
  await uploadOneEvidence(incidentId, sessionId, jobId, "during.png", "DURING");

  // Walk the job through complete → review → approved.
  for (const [fn, body] of [
    ["markJobCompleteV1", { orgId: ORG, incidentId, jobId, actorUid: OWNER_UID, sessionId }],
    ["submitFieldSessionV1", { orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID }],
    ["updateJobStatusV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID, status: "review" }],
    ["approveJobV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID }],
    ["closeIncidentV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID }],
    ["exportIncidentPacketV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID }],
  ]) {
    const rr = await post(fn, body);
    if (rr.body.ok !== true && rr.body.already !== true) {
      throw new Error(`${fn} failed: ${JSON.stringify(rr.body)}`);
    }
  }

  // closeIncident transitions to CLOSED. But the mint endpoint
  // accepts in_progress OR closed (PR 126c retroactive path). The
  // simpler test path: leave as closed and mint a retroactive review
  // link. Both source paths exercise the same downstream surface.
  return { jobId, sessionId };
}

// ───────────────────────────────────────────────────────────────────
async function scenarioA() {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(" SCENARIO A — happy path: open → review → accept");
  console.log("══════════════════════════════════════════════════════════");
  const incidentId = `${runId}_A`;
  console.log(dim(`  incidentId = ${incidentId}`));

  await buildIncidentToReviewReady({ incidentId, title: "Chunk 2 scenario A" });

  let r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
    customerEmail: "test+a@example.com",
  });
  check("createCustomerReviewLinkV1 returns ok:true", r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  if (r.body.ok !== true) return;
  const token = r.body.token;
  check("token is returned cleartext (one time)", typeof token === "string" && token.startsWith("peakops_rv_"));

  // Customer GETs the dossier.
  let resp = await get(`${FN}/getCustomerReviewV1?token=${encodeURIComponent(token)}`);
  check("getCustomerReviewV1 → 200 dossier", resp.status === 200 && resp.body?.ok === true);

  // Customer accepts.
  resp = await post("submitCustomerReviewV1", { token, action: "accept" });
  check("submitCustomerReviewV1 accept → 200", resp.status === 200 && resp.body?.ok === true);

  // Verify incident status transitioned to customer_accepted.
  await new Promise(r => setTimeout(r, 1000));
  const incSnap = await db.doc(`orgs/${ORG}/incidents/${incidentId}`).get();
  const finalStatus = incSnap.data()?.status;
  check("incident.status === 'customer_accepted'", finalStatus === "customer_accepted", `actual=${finalStatus}`);

  // Verify notification was fanned out (look for a customer_accepted notification doc
  // landing under the creator's uid).
  const notifsSnap = await db.collection("users").doc(OWNER_UID).collection("notifications")
    .where("incidentId", "==", incidentId).limit(10).get();
  const haveAccepted = notifsSnap.docs.some((d) => (d.data() || {}).type === "customer_accepted");
  check("customer_accepted notification doc landed in creator's feed", haveAccepted, `feed count=${notifsSnap.size}`);
}

async function scenarioB() {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(" SCENARIO B — rejection → rework → resubmit → accept");
  console.log("══════════════════════════════════════════════════════════");
  const incidentId = `${runId}_B`;
  console.log(dim(`  incidentId = ${incidentId}`));

  await buildIncidentToReviewReady({ incidentId, title: "Chunk 2 scenario B" });

  let r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
    customerEmail: "test+b@example.com",
  });
  check("first-mint createCustomerReviewLinkV1 → ok", r.body.ok === true);
  if (r.body.ok !== true) return;
  const tokenA = r.body.token;

  // Customer REJECTS.
  r = await post("submitCustomerReviewV1", {
    token: tokenA,
    action: "reject",
    comment: "Please add the OTDR trace before we can sign off.",
  });
  check("first-mint reject → 200", r.body.ok === true);

  await new Promise(res => setTimeout(res, 1500));

  const incAfterReject = (await db.doc(`orgs/${ORG}/incidents/${incidentId}`).get()).data();
  check("incident.status === 'customer_rejected'", incAfterReject?.status === "customer_rejected", `actual=${incAfterReject?.status}`);

  // Recovery case auto-created.
  const casesSnap = await db.collection(`orgs/${ORG}/recovery_cases`).where("incidentId", "==", incidentId).limit(1).get();
  check("recovery case auto-created", !casesSnap.empty, `cases=${casesSnap.size}`);
  if (casesSnap.empty) return;
  const caseId = casesSnap.docs[0].id;

  // recovery_case_opened notification fired.
  const notifs = await db.collection("users").doc(ADMIN_UID).collection("notifications")
    .where("incidentId", "==", incidentId).limit(20).get();
  const haveRecoveryNotif = notifs.docs.some((d) => (d.data() || {}).type === "recovery_case_opened");
  check("recovery_case_opened notification in admin feed", haveRecoveryNotif, `total=${notifs.size}`);

  // Transition recovery case READY_TO_RESUBMIT so mintResubmissionLinkV1 accepts.
  // First, advance status open → in_progress → ready_to_resubmit. Use updateRecoveryCaseV1.
  await post("updateRecoveryCaseV1", {
    orgId: ORG, caseId, actorUid: ADMIN_UID,
    targetStatus: "in_progress",
  });
  await post("updateRecoveryCaseV1", {
    orgId: ORG, caseId, actorUid: ADMIN_UID,
    targetStatus: "ready_to_resubmit",
  });

  // Mint resubmission link.
  r = await post("mintResubmissionLinkV1", {
    orgId: ORG, caseId, actorUid: ADMIN_UID,
    customerEmail: "test+b@example.com",
    changeSummary: "Added OTDR trace per customer request",
  });
  check("mintResubmissionLinkV1 → ok", r.body.ok === true, JSON.stringify(r.body).slice(0, 150));
  if (r.body.ok !== true) return;
  const tokenB = r.body.token;

  // Customer accepts on resubmission.
  r = await post("submitCustomerReviewV1", { token: tokenB, action: "accept" });
  check("resubmission accept → 200", r.body.ok === true);

  await new Promise(res => setTimeout(res, 1500));
  const incFinal = (await db.doc(`orgs/${ORG}/incidents/${incidentId}`).get()).data();
  check("incident.status === 'customer_accepted' after resubmit", incFinal?.status === "customer_accepted", `actual=${incFinal?.status}`);

  const caseFinal = (await db.doc(`orgs/${ORG}/recovery_cases/${caseId}`).get()).data();
  check("recovery_case.status === 'recovered' (auto-resolved)", caseFinal?.status === "recovered", `actual=${caseFinal?.status}`);
}

async function scenarioC() {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(" SCENARIO C — review delivery failure surface");
  console.log("══════════════════════════════════════════════════════════");
  const incidentId = `${runId}_C`;
  console.log(dim(`  incidentId = ${incidentId}`));

  // Build the incident WITHOUT approving the job. Mint should surface
  // blocked-jobs error so the operator knows what went wrong.
  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: "Chunk 2 scenario C",
    status: "open",
    archetype: "fiber_splice_verification",
    filingTypesRequired: [],
    location: "E2E test yard",
    customer: "E2E Telecom",
    priority: "normal",
  });
  if (r.body.ok !== true) return;

  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: "Unapproved job",
  });
  if (r.body.ok !== true) return;

  // Push to in_progress so mint sees a valid source state, but don't approve any job.
  const ref = db.doc(`orgs/${ORG}/incidents/${incidentId}`);
  await ref.set({ status: "in_progress" }, { merge: true });

  r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId, actorUid: ADMIN_UID,
  });

  check("mint rejects unapproved-jobs incident with structured error", r.body.ok === false, `status=${r.status}`);
  check("error code is operator-actionable", r.body.error && /not_approved|invalid_status/.test(r.body.error), `error=${r.body.error}`);
  check("response surfaces the failure visibly (not silent 500)", r.status >= 400 && r.status < 500, `status=${r.status}`);
}

// ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(dim(`Run ID: ${runId}`));
  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
  } catch (e) {
    console.error(bad(`UNCAUGHT: ${e?.stack || e?.message || e}`));
    failures++;
  }

  console.log("\n══════════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log(ok(`✓ ALL CHUNK 2 SCENARIOS PASS`));
  } else {
    console.log(bad(`✗ ${failures} FAILURE(S)`));
  }
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(failures > 0 ? 1 : 0);
})();
