#!/usr/bin/env node
// PR 127a — Recovery Architecture backend smoke harness.
//
// 14 scenarios covering:
//   - Manual case create (auth + validation + happy path)
//   - State machine transitions (valid + invalid + terminal)
//   - Recovery Action lifecycle + evidence validation
//   - Auto-create on customer_rejected (via submitCustomerReviewV1)
//   - Second-rejection extends existing case (no duplicate)
//   - Auto-resolve on customer_accepted (terminal recovered)
//   - PacketVersionRef append on new mint with active case
//   - Audit chain coherence

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr127a";
const ADMIN_UID = "smoke-admin";
const FIELD_UID = "smoke-field";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function seedOrgAndMembers() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR127a Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${ADMIN_UID}`).set({ role: "admin", status: "active" });
  await db.doc(`orgs/${ORG_ID}/members/${FIELD_UID}`).set({ role: "field", status: "active" });
}

async function seedIncident(incidentId, opts = {}) {
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set({
    orgId: ORG_ID,
    incidentId,
    title: opts.title || "Smoke test record",
    customer: opts.customer || "Comcast Restoration",
    archetype: opts.archetype || "fiber_splice_verification",
    status: opts.status || "in_progress",
    requirements: {
      templateKey: "fiber_splice_verification__comcast-restoration",
      templateVersion: 7,
      customerLabel: "Comcast Restoration",
      archetype: "fiber_splice_verification",
      requiredProof: ["Splice photo"],
      requiredProofDescriptions: ["Wide shot"],
      optionalProof: [],
      acceptanceCriteria: [],
      acceptanceChecks: [
        { type: "requires_supervisor_approval", tier: "required", label: "QA signoff" },
      ],
    },
    readinessCache: { ready: true, label: "Ready", checks: [] },
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`incidents/${incidentId}/jobs/job-1`).set({
    id: "job-1", status: "approved", reviewStatus: "approved",
  });
}

async function seedEvidence(incidentId, evidenceId, opts = {}) {
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}/evidence_locker/${evidenceId}`).set({
    filename: opts.filename || `${evidenceId}.jpg`,
    caption: opts.caption || "Evidence",
    capturedAt: FieldValue.serverTimestamp(),
  });
}

async function postJson(name, body) {
  const res = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "smoke-harness/1.0" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: res.status, body: json || text };
}

async function readCase(caseId) {
  const snap = await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function findCaseByIncident(incidentId) {
  const snap = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", incidentId)
    .limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function readAuditForCase(caseId) {
  const snap = await db.collection(`orgs/${ORG_ID}/recovery_audit`)
    .where("caseId", "==", caseId)
    .get();
  return snap.docs.map((d) => d.data().type);
}

// ── Scenarios ──────────────────────────────────────────────────────

async function s1_manualCreate_happyPath() {
  const name = "1) Manual case create as admin → 200; case opens in `open`; revenue + audit written";
  const incidentId = "inc-s1-manual";
  await seedIncident(incidentId);

  // PR 127a2: body.priority is silently ignored — priority is derived
  // on every read. Persisted value defaults to "medium". This test
  // verifies the create+persist path (revenue + audit), not priority.
  const res = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
    revenueAtRisk: { amount: 12500, type: "estimated" },
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  const caseId = res.body.caseId;
  const c = await readCase(caseId);
  if (!c) return { name, pass: false, detail: "case doc missing" };
  if (c.status !== "open") return { name, pass: false, detail: `status=${c.status}` };
  if (c.revenueAtRisk?.amount !== 12500) return { name, pass: false, detail: `amount=${c.revenueAtRisk?.amount}` };
  if (c.revenueAtRisk?.type !== "estimated") return { name, pass: false, detail: `type=${c.revenueAtRisk?.type}` };
  const audit = await readAuditForCase(caseId);
  if (!audit.includes("case_opened")) return { name, pass: false, detail: `audit missing case_opened: ${audit}` };
  return { name, pass: true, detail: `case ${caseId} opened; revenue $12500 estimated; priority is read-derived (not asserted on persisted doc)`, caseId };
}

async function s2_manualCreate_deniedForField() {
  const name = "2) Manual case create as field role → 403";
  const incidentId = "inc-s2-denied";
  await seedIncident(incidentId);
  const res = await postJson("createRecoveryCaseV1", {
    actorUid: FIELD_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  if (res.status !== 403) return { name, pass: false, detail: `expected 403; got ${res.status}` };
  return { name, pass: true, detail: "403 permission-denied for field role" };
}

async function s3_create_invalidEnums() {
  const name = "3) Invalid cause / source / revenue type → 400 each; invalid priority silently ignored (PR 127a2)";
  const incidentId = "inc-s3-invalid";
  await seedIncident(incidentId);

  // PR 127a2: body.priority is silently ignored. "EXTREME" no longer
  // produces a 400 — instead the case is created with the persisted
  // default. We verify the silent-ignore path AND keep coverage for
  // the other three invalid-enum gates.
  const rPriorityIgnored = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "EXTREME",
  });
  if (rPriorityIgnored.status !== 200) {
    return { name, pass: false, detail: `priority should be silently ignored but got ${rPriorityIgnored.status}` };
  }

  const r2 = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
    cause: { primary: "bogus_cause" },
  });
  if (r2.status !== 400 || r2.body?.error !== "invalid_cause_primary") return { name, pass: false, detail: `cause: ${r2.status} ${r2.body?.error}` };

  const r3 = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "compliance_audit",
  });
  if (r3.status !== 400 || r3.body?.error !== "invalid_source") return { name, pass: false, detail: `source: ${r3.status} ${r3.body?.error}` };

  const r4 = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
    revenueAtRisk: { amount: 100, type: "guessed" },
  });
  if (r4.status !== 400 || r4.body?.error !== "invalid_revenue_type") return { name, pass: false, detail: `revType: ${r4.status} ${r4.body?.error}` };

  return { name, pass: true, detail: "invalid cause/source/revenueType → 400; invalid priority silently ignored as designed" };
}

async function s4_update_validTransition() {
  const name = "4) Update case open → triaged via setting cause.primary; in_progress next";
  const incidentId = "inc-s4-update";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "medium",
  });
  const caseId = createRes.body.caseId;

  // Setting primary cause should auto-transition open → triaged.
  const r1 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof", operatorNotes: "Splice photo missing" },
  });
  if (r1.status !== 200) return { name, pass: false, detail: `update1: ${r1.status} ${JSON.stringify(r1.body).slice(0,150)}` };
  let c = await readCase(caseId);
  if (c.status !== "triaged") return { name, pass: false, detail: `expected triaged; got ${c.status}` };
  if (c.cause?.primary !== "missing_required_proof") return { name, pass: false, detail: `cause not set` };

  // Then triaged → in_progress (explicit status set).
  const r2 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "in_progress",
  });
  if (r2.status !== 200) return { name, pass: false, detail: `update2: ${r2.status}` };
  c = await readCase(caseId);
  if (c.status !== "in_progress") return { name, pass: false, detail: `expected in_progress; got ${c.status}` };

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("case_triaged")) return { name, pass: false, detail: `no case_triaged audit: ${audit}` };
  if (!audit.includes("case_status_changed")) return { name, pass: false, detail: `no case_status_changed audit` };
  return { name, pass: true, detail: `open → triaged (auto, on cause) → in_progress; audits coherent` };
}

async function s5_update_invalidTransition() {
  const name = "5) Update with invalid transition (open → recovered direct) → 409";
  const incidentId = "inc-s5-invalid-trans";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = createRes.body.caseId;
  const r = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "recovered",
    resolution: { outcome: "recovered" },
  });
  if (r.status !== 409 || r.body?.error !== "invalid_transition") {
    return { name, pass: false, detail: `${r.status} ${JSON.stringify(r.body).slice(0,150)}` };
  }
  return { name, pass: true, detail: "409 invalid_transition for open → recovered" };
}

async function s6_resolveCase_terminal() {
  const name = "6) Resolve to recovered (with resolution) → terminal; revenue_recovered audit fires";
  const incidentId = "inc-s6-recovered";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "medium",
    revenueAtRisk: { amount: 5000, type: "actual" },
  });
  const caseId = createRes.body.caseId;
  // Walk through valid transitions: open → triaged → in_progress → recovered
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "internal_qc_caught" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  const r = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "recovered",
    resolution: { outcome: "recovered", notes: "Fixed and re-accepted." },
  });
  if (r.status !== 200) return { name, pass: false, detail: `resolve failed: ${r.status} ${JSON.stringify(r.body).slice(0,150)}` };
  const c = await readCase(caseId);
  if (c.status !== "recovered") return { name, pass: false, detail: `final status=${c.status}` };
  if (!c.resolution) return { name, pass: false, detail: "resolution missing" };
  if (c.resolution.outcome !== "recovered") return { name, pass: false, detail: `outcome=${c.resolution.outcome}` };
  const audit = await readAuditForCase(caseId);
  if (!audit.includes("case_resolved")) return { name, pass: false, detail: `no case_resolved: ${audit}` };
  if (!audit.includes("revenue_recovered")) return { name, pass: false, detail: `no revenue_recovered: ${audit}` };
  return { name, pass: true, detail: `resolved to recovered; revenue_recovered audit fired` };
}

async function s7_partialRecovery_validation() {
  const name = "7) partial_recovery requires 0 < finalAmount < revenueAtRisk.amount; rejected otherwise";
  const incidentId = "inc-s7-partial";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "medium",
    revenueAtRisk: { amount: 10000, type: "actual" },
  });
  const caseId = createRes.body.caseId;
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "scope_dispute" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });

  // finalAmount >= baseline → 400
  const r1 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "partial_recovery",
    resolution: { outcome: "partial_recovery", finalAmount: 10000 },
  });
  if (r1.status !== 400 || r1.body?.error !== "final_amount_not_less_than_baseline") {
    return { name, pass: false, detail: `>= baseline: ${r1.status} ${r1.body?.error}` };
  }

  // finalAmount = 0 → 400
  const r2 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "partial_recovery",
    resolution: { outcome: "partial_recovery", finalAmount: 0 },
  });
  if (r2.status !== 400 || r2.body?.error !== "invalid_final_amount") {
    return { name, pass: false, detail: `=0: ${r2.status} ${r2.body?.error}` };
  }

  // Valid finalAmount → 200
  const r3 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "partial_recovery",
    resolution: { outcome: "partial_recovery", finalAmount: 6500, notes: "Customer accepted 65% under dispute" },
  });
  if (r3.status !== 200) return { name, pass: false, detail: `valid: ${r3.status} ${JSON.stringify(r3.body).slice(0,150)}` };
  const c = await readCase(caseId);
  if (c.status !== "partial_recovery") return { name, pass: false, detail: `final status=${c.status}` };
  if (c.resolution?.finalAmount !== 6500) return { name, pass: false, detail: `finalAmount=${c.resolution?.finalAmount}` };

  return { name, pass: true, detail: `partial_recovery validation enforces 0 < finalAmount < baseline; final $6500 / $10000 captured` };
}

async function s8_terminalCasePreserved() {
  const name = "8) Already-terminal case cannot transition out";
  const incidentId = "inc-s8-terminal";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
    revenueAtRisk: { amount: 1000, type: "estimated" },
  });
  const caseId = createRes.body.caseId;
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, cause: { primary: "internal_qc_caught" },
  });
  await postJson("updateRecoveryCaseV1", { actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "abandoned",
    resolution: { outcome: "abandoned", notes: "Written off" } });

  const r = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  if (r.status !== 409 || r.body?.error !== "invalid_transition") {
    return { name, pass: false, detail: `${r.status} ${r.body?.error}` };
  }
  return { name, pass: true, detail: "abandoned → in_progress rejected as expected" };
}

async function s9_addRecoveryAction() {
  const name = "9) addRecoveryActionV1 creates action; audit row written; action lives at /actions/";
  const incidentId = "inc-s9-action";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = createRes.body.caseId;

  const r = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "documentation_fix",
    title: "Update narrative for splice slot",
    description: "Operator notes incorrectly say East riser; should be West",
    assignee: ADMIN_UID, assigneeRole: "supervisor",
  });
  if (r.status !== 200) return { name, pass: false, detail: `${r.status} ${JSON.stringify(r.body).slice(0,150)}` };
  const actionId = r.body.actionId;
  const actionSnap = await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions/${actionId}`).get();
  if (!actionSnap.exists) return { name, pass: false, detail: "action doc missing" };
  const a = actionSnap.data();
  if (a.type !== "documentation_fix") return { name, pass: false, detail: `type=${a.type}` };
  if (a.status !== "open") return { name, pass: false, detail: `status=${a.status}` };
  if (a.assigneeRole !== "supervisor") return { name, pass: false, detail: `assigneeRole=${a.assigneeRole}` };

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("action_created")) return { name, pass: false, detail: `no action_created audit: ${audit}` };
  return { name, pass: true, detail: `action ${actionId} created; assigned to supervisor; audit row written` };
}

async function s10_actionEvidenceValidation() {
  const name = "10) addRecoveryActionV1 evidence validation: invalid ids → 400; valid ids → action created with evidence";
  const incidentId = "inc-s10-evidence";
  await seedIncident(incidentId);
  await seedEvidence(incidentId, "ev_real_1");
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = createRes.body.caseId;

  // Invalid evidence id → 400
  const r1 = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof",
    title: "Recapture splice photo",
    evidence: [{ evidenceId: "ev_does_not_exist" }],
  });
  if (r1.status !== 400 || r1.body?.error !== "invalid_evidence") {
    return { name, pass: false, detail: `invalid path: ${r1.status} ${r1.body?.error}` };
  }

  // Valid evidence id → 200
  const r2 = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof",
    title: "Recapture splice photo",
    evidence: [{ evidenceId: "ev_real_1" }],
  });
  if (r2.status !== 200) return { name, pass: false, detail: `valid path: ${r2.status}` };
  const actionSnap = await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions/${r2.body.actionId}`).get();
  const evidence = actionSnap.data().evidence;
  if (!Array.isArray(evidence) || evidence.length !== 1 || evidence[0].evidenceId !== "ev_real_1") {
    return { name, pass: false, detail: `evidence not attached: ${JSON.stringify(evidence)}` };
  }
  return { name, pass: true, detail: `invalid evidence rejected; valid attached to action` };
}

async function s11_updateActionLifecycle() {
  const name = "11) Action status lifecycle: open → in_progress (startedAt stamped) → done (completedAt stamped); invalid status → 400";
  const incidentId = "inc-s11-action-lifecycle";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = createRes.body.caseId;
  const addRes = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "field_revisit", title: "Send tech back to site",
  });
  const actionId = addRes.body.actionId;

  const r1 = await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId,
    status: "in_progress",
  });
  if (r1.status !== 200) return { name, pass: false, detail: `in_progress: ${r1.status}` };
  let a = (await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions/${actionId}`).get()).data();
  if (!a.startedAt) return { name, pass: false, detail: "startedAt not stamped" };

  const r2 = await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId,
    status: "done", outcome: "Tech recaptured photo; uploaded",
  });
  if (r2.status !== 200) return { name, pass: false, detail: `done: ${r2.status}` };
  a = (await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions/${actionId}`).get()).data();
  if (!a.completedAt) return { name, pass: false, detail: "completedAt not stamped" };

  const r3 = await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId,
    status: "neverheardofit",
  });
  if (r3.status !== 400 || r3.body?.error !== "invalid_action_status") {
    return { name, pass: false, detail: `bad status: ${r3.status} ${r3.body?.error}` };
  }

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("action_completed")) return { name, pass: false, detail: `no action_completed audit: ${audit}` };
  return { name, pass: true, detail: `action lifecycle stamps timestamps; invalid status rejected; action_completed audit fired` };
}

async function s12_autoCreateOnReject() {
  const name = "12) Auto-create on customer_rejected: case + starter Recovery Action both auto-created";
  const incidentId = "inc-s12-auto-reject";
  await seedIncident(incidentId);

  // Mint link + reject (drives PR 127a inline auto-create via submitCustomerReviewV1).
  const mintRes = await postJson("createCustomerReviewLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
  });
  if (mintRes.status !== 200) return { name, pass: false, detail: `mint: ${mintRes.status}` };
  const token = mintRes.body.token;

  const rejRes = await postJson("submitCustomerReviewV1", {
    token, action: "reject", comment: "OTDR trace missing",
  });
  if (rejRes.status !== 200) return { name, pass: false, detail: `reject: ${rejRes.status}` };

  // Verify auto-created case exists.
  const c = await findCaseByIncident(incidentId);
  if (!c) return { name, pass: false, detail: "case not auto-created" };
  if (c.status !== "open") return { name, pass: false, detail: `case status=${c.status}` };
  if (c.rejection?.source !== "customer_rejected") return { name, pass: false, detail: `source=${c.rejection?.source}` };
  if (c.priority !== "medium") return { name, pass: false, detail: `priority=${c.priority}` };
  if (c.cause?.customerComment !== "OTDR trace missing") return { name, pass: false, detail: `comment not captured: ${c.cause?.customerComment}` };
  if (!Array.isArray(c.packetVersions) || c.packetVersions.length !== 1) return { name, pass: false, detail: `packetVersions=${c.packetVersions?.length}` };

  // Verify starter action.
  const actionsSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases/${c.id}/actions`).get();
  if (actionsSnap.empty) return { name, pass: false, detail: "no starter action" };
  const starter = actionsSnap.docs[0].data();
  if (starter.type !== "clarify_with_customer") return { name, pass: false, detail: `starter type=${starter.type}` };
  if (starter.status !== "open") return { name, pass: false, detail: `starter status=${starter.status}` };

  const audit = await readAuditForCase(c.id);
  if (!audit.includes("case_auto_opened_from_rejection")) return { name, pass: false, detail: `no auto_opened audit: ${audit}` };
  if (!audit.includes("action_created")) return { name, pass: false, detail: `no action_created audit: ${audit}` };

  return { name, pass: true, detail: `case + starter action auto-created from rejection; audit chain coherent` };
}

async function s13_secondRejectionExtendsCase() {
  const name = "13) Second rejection extends existing case (no duplicate); cycleCount=2; status reverts in_progress";
  const incidentId = "inc-s13-second-reject";
  await seedIncident(incidentId);

  // First reject — creates a case (auto)
  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "First rejection" });

  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  // Walk case to a re-mintable state: triage + in_progress
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });

  // Need to set incident.status back to in_progress so we can mint another link
  // (createCustomerReviewLinkV1 requires status=in_progress|closed). The
  // incident's status moved to customer_rejected during the first reject.
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).update({ status: "in_progress" });

  // Second mint — this should append PacketVersionRef to the active case + set case status to awaiting_customer
  const mint2 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  if (mint2.status !== 200) return { name, pass: false, detail: `mint2: ${mint2.status} ${JSON.stringify(mint2.body).slice(0,150)}` };
  if (mint2.body.linkedRecoveryCaseId !== caseId) return { name, pass: false, detail: `linkedRecoveryCaseId mismatch: ${mint2.body.linkedRecoveryCaseId} vs ${caseId}` };

  let c2 = await readCase(caseId);
  if (c2.status !== "awaiting_customer") return { name, pass: false, detail: `expected awaiting_customer; got ${c2.status}` };
  if (c2.packetVersions.length !== 2) return { name, pass: false, detail: `expected 2 packetVersions; got ${c2.packetVersions.length}` };

  // Second rejection — should extend (not create new); status reverts to in_progress
  const rej2 = await postJson("submitCustomerReviewV1", { token: mint2.body.token, action: "reject", comment: "Second rejection" });
  if (rej2.status !== 200) return { name, pass: false, detail: `rej2: ${rej2.status}` };

  // Verify no duplicate case
  const allCases = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", incidentId).get();
  if (allCases.size !== 1) return { name, pass: false, detail: `expected 1 case; got ${allCases.size}` };

  c2 = await readCase(caseId);
  if (c2.cycleCount !== 2) return { name, pass: false, detail: `cycleCount=${c2.cycleCount}` };
  if (c2.status !== "in_progress") return { name, pass: false, detail: `expected in_progress after 2nd reject; got ${c2.status}` };

  return { name, pass: true, detail: `single case absorbed 2 rejections; cycleCount=2; status reverted in_progress` };
}

async function s14_autoResolveOnAccept() {
  const name = "14) Auto-resolve on customer_accepted: case in awaiting_customer → recovered (terminal); revenue_recovered audit";
  const incidentId = "inc-s14-auto-resolve";
  await seedIncident(incidentId);

  // Reject first (auto-creates case)
  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "First reject" });

  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  // Operator sets revenue at risk + works the case
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
    revenueAtRisk: { amount: 18000, type: "actual" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });

  // Reset incident, mint second link → case → awaiting_customer
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).update({ status: "in_progress" });
  const mint2 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });

  let c = await readCase(caseId);
  if (c.status !== "awaiting_customer") return { name, pass: false, detail: `expected awaiting_customer; got ${c.status}` };

  // Customer accepts → auto-resolve
  const acceptRes = await postJson("submitCustomerReviewV1", {
    token: mint2.body.token, action: "accept", comment: "Resubmission accepted",
  });
  if (acceptRes.status !== 200) return { name, pass: false, detail: `accept: ${acceptRes.status}` };

  c = await readCase(caseId);
  if (c.status !== "recovered") return { name, pass: false, detail: `expected recovered; got ${c.status}` };
  if (c.resolution?.outcome !== "recovered") return { name, pass: false, detail: `outcome=${c.resolution?.outcome}` };
  if (c.resolution?.resolvedBy !== "customer") return { name, pass: false, detail: `resolvedBy=${c.resolution?.resolvedBy}` };

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("revenue_recovered")) return { name, pass: false, detail: `no revenue_recovered audit: ${audit}` };
  if (!audit.includes("case_resolved")) return { name, pass: false, detail: `no case_resolved audit: ${audit}` };

  return { name, pass: true, detail: `auto-resolved on customer accept; recovered terminal + revenue_recovered audit` };
}

async function s15_createWithCause_autoTriages() {
  const name = "15) PR 127a1: createRecoveryCaseV1 with cause.primary supplied → initial status=triaged + case_triaged audit; without cause → stays open";
  const incidentIdA = "inc-s15-with-cause";
  const incidentIdB = "inc-s15-no-cause";
  await seedIncident(incidentIdA);
  await seedIncident(incidentIdB);

  // With cause.primary → expect status=triaged + both case_opened AND case_triaged audits
  const rA = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incidentIdA,
    source: "internal_qc", priority: "high",
    cause: { primary: "missing_required_proof", operatorNotes: "Auto-triage on create" },
  });
  if (rA.status !== 200) return { name, pass: false, detail: `with cause: ${rA.status}` };
  if (rA.body.status !== "triaged") {
    return { name, pass: false, detail: `with cause: status=${rA.body.status} (expected triaged)` };
  }
  const cA = await readCase(rA.body.caseId);
  if (cA.status !== "triaged") return { name, pass: false, detail: `with cause doc: status=${cA.status}` };
  if (cA.cause?.primary !== "missing_required_proof") return { name, pass: false, detail: `cause not persisted` };

  const auditA = await readAuditForCase(rA.body.caseId);
  if (!auditA.includes("case_opened")) return { name, pass: false, detail: `with cause: no case_opened: ${auditA}` };
  if (!auditA.includes("case_triaged")) return { name, pass: false, detail: `with cause: no case_triaged: ${auditA}` };

  // Without cause.primary → expect status=open + only case_opened audit
  const rB = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incidentIdB,
    source: "internal_qc", priority: "low",
  });
  if (rB.status !== 200) return { name, pass: false, detail: `no cause: ${rB.status}` };
  if (rB.body.status !== "open") {
    return { name, pass: false, detail: `no cause: status=${rB.body.status} (expected open)` };
  }
  const cB = await readCase(rB.body.caseId);
  if (cB.status !== "open") return { name, pass: false, detail: `no cause doc: status=${cB.status}` };

  const auditB = await readAuditForCase(rB.body.caseId);
  if (!auditB.includes("case_opened")) return { name, pass: false, detail: `no cause: no case_opened: ${auditB}` };
  if (auditB.includes("case_triaged")) {
    return { name, pass: false, detail: `no cause: unexpected case_triaged: ${auditB}` };
  }

  return { name, pass: true, detail: `with cause → triaged + case_triaged audit; without cause → open + no triage audit` };
}

// ── PR 127a2 scenarios ─────────────────────────────────────────────

async function getJson(name, query) {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${FN_BASE}/${name}?${qs}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: res.status, body: json || text };
}

async function s16_listRecoveryCasesV1() {
  const name = "16) PR 127a2: listRecoveryCasesV1 returns cases with derived priority + aggregate totals";
  // Seed two cases with different revenue / aging profiles
  const incA = "inc-s16-list-A";
  const incB = "inc-s16-list-B";
  await seedIncident(incA);
  await seedIncident(incB);
  // Case A: $50k actual → expect "critical" derived
  await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incA,
    source: "internal_qc",
    cause: { primary: "scope_dispute" },
    revenueAtRisk: { amount: 50000, type: "actual" },
  });
  // Case B: unknown amount, 0 days → expect "low" derived
  await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incB,
    source: "internal_qc",
  });

  // Non-admin denied
  const denied = await getJson("listRecoveryCasesV1", { orgId: ORG_ID, actorUid: FIELD_UID });
  if (denied.status !== 403) return { name, pass: false, detail: `non-admin should 403; got ${denied.status}` };

  // Admin list
  const ok = await getJson("listRecoveryCasesV1", { orgId: ORG_ID, actorUid: ADMIN_UID });
  if (ok.status !== 200 || !ok.body?.ok) return { name, pass: false, detail: `${ok.status} ${JSON.stringify(ok.body).slice(0,200)}` };
  const cases = ok.body.cases || [];
  if (!Array.isArray(cases) || cases.length < 2) return { name, pass: false, detail: `expected ≥2 cases; got ${cases.length}` };

  const caseA = cases.find((c) => c.incidentId === incA);
  const caseB = cases.find((c) => c.incidentId === incB);
  if (!caseA || !caseB) return { name, pass: false, detail: `missing cases by incidentId` };

  if (caseA.priority !== "critical") return { name, pass: false, detail: `caseA derived priority=${caseA.priority} (expected critical for $50k)` };
  if (caseB.priority !== "low") return { name, pass: false, detail: `caseB derived priority=${caseB.priority} (expected low for unknown + 0 days)` };

  // Totals strip should aggregate non-terminal cases
  if (!ok.body.totals) return { name, pass: false, detail: "totals missing" };
  if (typeof ok.body.totals.openCases !== "number") return { name, pass: false, detail: `openCases not numeric` };
  if (typeof ok.body.totals.openRevenue !== "number") return { name, pass: false, detail: `openRevenue not numeric` };
  if (ok.body.totals.openRevenue < 50000) return { name, pass: false, detail: `openRevenue too low: ${ok.body.totals.openRevenue}` };

  return { name, pass: true, detail: `list returned ${cases.length} cases; derived priority correct; totals aggregated ($${ok.body.totals.openRevenue})` };
}

async function s17_getRecoveryCaseV1() {
  const name = "17) PR 127a2: getRecoveryCaseV1 returns full case detail + actions + audit; derived priority";
  const incidentId = "inc-s17-detail";
  await seedIncident(incidentId);

  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
    cause: { primary: "missing_required_proof" },
    revenueAtRisk: { amount: 20000, type: "estimated" },
  });
  const caseId = createRes.body.caseId;

  // Add two actions
  await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof", title: "Recapture splice photo",
  });
  await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "documentation_fix", title: "Update narrative",
  });

  // Non-admin denied
  const denied = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: FIELD_UID });
  if (denied.status !== 403) return { name, pass: false, detail: `non-admin should 403; got ${denied.status}` };

  // Unknown case → 404
  const unknown = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId: "nonexistent", actorUid: ADMIN_UID });
  if (unknown.status !== 404) return { name, pass: false, detail: `unknown caseId should 404; got ${unknown.status}` };

  // Happy path
  const ok = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (ok.status !== 200 || !ok.body?.ok) return { name, pass: false, detail: `${ok.status} ${JSON.stringify(ok.body).slice(0,200)}` };

  const c = ok.body.case;
  if (!c) return { name, pass: false, detail: "case detail missing" };
  // $20k estimated, 0 days → high (per threshold table)
  if (c.priority !== "high") return { name, pass: false, detail: `derived priority=${c.priority} (expected high for $20k)` };
  if (c.cause?.primary !== "missing_required_proof") return { name, pass: false, detail: `cause not surfaced` };

  if (!Array.isArray(ok.body.actions) || ok.body.actions.length !== 2) {
    return { name, pass: false, detail: `actions=${ok.body.actions?.length} (expected 2)` };
  }
  if (!Array.isArray(ok.body.audit) || ok.body.audit.length < 3) {
    return { name, pass: false, detail: `audit=${ok.body.audit?.length} (expected ≥3: case_opened, case_triaged, action_created × 2)` };
  }

  // Audit should be newest-first
  if (ok.body.audit.length >= 2) {
    const ts0 = new Date(ok.body.audit[0].createdAt || 0).getTime();
    const ts1 = new Date(ok.body.audit[1].createdAt || 0).getTime();
    if (ts0 < ts1) return { name, pass: false, detail: `audit not sorted desc: [0]=${ts0} < [1]=${ts1}` };
  }

  return { name, pass: true, detail: `detail returned with derived priority=high, ${ok.body.actions.length} actions, ${ok.body.audit.length} audit rows (newest first)` };
}

async function s18_priorityDeriverThresholds() {
  const name = "18) PR 127a2: derivePriority threshold matrix correctness";
  const { derivePriority } = await import("/Users/kesserumini/peakops/my-app/functions_clean/_recoveryPriority.js");

  const cases = [
    // [amount, days, type, expected]
    [50000, 0, "actual", "critical"],     // amount threshold
    [49999, 29, "actual", "high"],         // just under both critical bands
    [20000, 0, "actual", "high"],          // high amount
    [5000, 0, "estimated", "medium"],      // medium amount
    [100, 0, "actual", "low"],             // low amount
    [0, 30, "unknown", "critical"],        // unknown amount but old enough
    [99999, 30, "unknown", "critical"],    // unknown ignores amount
    [99999, 0, "unknown", "low"],          // unknown + fresh
    [3000, 14, "actual", "high"],          // aging wins (high) over amount (low)
    [25000, 7, "actual", "high"],          // amount wins (high) over aging (medium)
  ];

  for (const [amount, days, type, expected] of cases) {
    const got = derivePriority({ amount, daysOpen: days, amountType: type });
    if (got !== expected) {
      return { name, pass: false, detail: `${amount}/${days}d/${type} → got "${got}" (expected "${expected}")` };
    }
  }
  return { name, pass: true, detail: `all ${cases.length} threshold combinations correct` };
}

async function s20_denormJobTitleAndLocation() {
  const name = "20) PR 127c-a: listRecoveryCasesV1 + getRecoveryCaseV1 denorm jobTitle + jobLocation from incident";
  const incidentId = "inc-s20-denorm";
  // Seed with a specific title + location so we can assert exactly.
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set({
    orgId: ORG_ID,
    incidentId,
    title: "PR 127c-a · Denorm smoke",
    location: "9999 Denorm Way, Smokeville",
    customer: "Comcast Restoration",
    archetype: "fiber_splice_verification",
    status: "in_progress",
    requirements: {
      templateKey: "fiber_splice_verification__comcast-restoration",
      templateVersion: 7,
      requiredProof: ["X"],
      requiredProofDescriptions: [""],
    },
    readinessCache: { ready: true, label: "Ready", checks: [] },
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`incidents/${incidentId}/jobs/job-1`).set({
    id: "job-1", status: "approved", reviewStatus: "approved",
  });

  // Create case
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
    cause: { primary: "internal_qc_caught" },
  });
  if (createRes.status !== 200) return { name, pass: false, detail: `create: ${createRes.status}` };
  const caseId = createRes.body.caseId;

  // List should include the denormed fields
  const listRes = await getJson("listRecoveryCasesV1", { orgId: ORG_ID, actorUid: ADMIN_UID });
  if (listRes.status !== 200) return { name, pass: false, detail: `list: ${listRes.status}` };
  const fromList = (listRes.body.cases || []).find((c) => c.caseId === caseId);
  if (!fromList) return { name, pass: false, detail: "case not in list" };
  if (fromList.jobTitle !== "PR 127c-a · Denorm smoke") return { name, pass: false, detail: `list.jobTitle=${fromList.jobTitle}` };
  if (fromList.jobLocation !== "9999 Denorm Way, Smokeville") return { name, pass: false, detail: `list.jobLocation=${fromList.jobLocation}` };

  // Detail should also include them
  const getRes = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (getRes.status !== 200) return { name, pass: false, detail: `get: ${getRes.status}` };
  if (getRes.body.case.jobTitle !== "PR 127c-a · Denorm smoke") return { name, pass: false, detail: `detail.jobTitle=${getRes.body.case.jobTitle}` };
  if (getRes.body.case.jobLocation !== "9999 Denorm Way, Smokeville") return { name, pass: false, detail: `detail.jobLocation=${getRes.body.case.jobLocation}` };

  return { name, pass: true, detail: `jobTitle + jobLocation denormed correctly on both list + detail` };
}

async function s19_actionType_provideTestResults() {
  const name = "19) PR 127a3: addRecoveryActionV1 accepts the new 'provide_test_results' action type";
  const incidentId = "inc-s19-provide-test-results";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
  });
  const caseId = createRes.body.caseId;

  // Confirm new type accepted
  const r = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "provide_test_results",
    title: "Submit OTDR trace + loss measurements",
    description: "Customer requested test data for the splice work.",
    assigneeRole: "field_lead",
  });
  if (r.status !== 200 || !r.body?.ok) return { name, pass: false, detail: `${r.status} ${JSON.stringify(r.body).slice(0,200)}` };
  if (r.body.type !== "provide_test_results") return { name, pass: false, detail: `type=${r.body.type}` };

  // Confirm bogus type still rejected (regression check)
  const bogus = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "totally_bogus", title: "Should fail",
  });
  if (bogus.status !== 400 || bogus.body?.error !== "invalid_action_type") {
    return { name, pass: false, detail: `bogus type should 400; got ${bogus.status} ${bogus.body?.error}` };
  }

  return { name, pass: true, detail: `provide_test_results accepted; bogus types still rejected` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + members");
  await seedOrgAndMembers();

  const scenarios = [
    s1_manualCreate_happyPath,
    s2_manualCreate_deniedForField,
    s3_create_invalidEnums,
    s4_update_validTransition,
    s5_update_invalidTransition,
    s6_resolveCase_terminal,
    s7_partialRecovery_validation,
    s8_terminalCasePreserved,
    s9_addRecoveryAction,
    s10_actionEvidenceValidation,
    s11_updateActionLifecycle,
    s12_autoCreateOnReject,
    s13_secondRejectionExtendsCase,
    s14_autoResolveOnAccept,
    // PR 127a1 — auto-triage on create with cause
    s15_createWithCause_autoTriages,
    // PR 127a2 — list + get + derived priority
    s16_listRecoveryCasesV1,
    s17_getRecoveryCaseV1,
    s18_priorityDeriverThresholds,
    // PR 127a3 — new action type
    s19_actionType_provideTestResults,
    // PR 127c-a — denorm jobTitle + jobLocation
    s20_denormJobTitleAndLocation,
  ];

  const results = [];
  for (const fn of scenarios) {
    try {
      const r = await fn();
      results.push(r);
      console.log(`${r.pass ? "✓" : "✗"} ${r.name} — ${r.detail}`);
    } catch (e) {
      const r = { name: fn.name, pass: false, detail: `THREW ${e?.message || e}` };
      results.push(r);
      console.log(`✗ ${r.name} — ${r.detail}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log("──────────────────────────────");
  console.log(`${passed === results.length ? "PASS" : "FAIL"}: ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("[smoke] unhandled:", e); process.exit(2); });
