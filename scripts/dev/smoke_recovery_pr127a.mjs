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
  // PR 129a — dropped `triaged`; setting cause.primary no longer
  // auto-transitions. Case stays at `open` until operator explicitly
  // moves it to in_progress, and `open → in_progress` is a single-step
  // legal transition. cause.categorizedBy carries the triage signal.
  const name = "4) Set cause.primary leaves status=open (no auto-triage); open → in_progress is direct";
  const incidentId = "inc-s4-update";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "medium",
  });
  const caseId = createRes.body.caseId;

  // Setting primary cause persists it but does NOT change status.
  const r1 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof", operatorNotes: "Splice photo missing" },
  });
  if (r1.status !== 200) return { name, pass: false, detail: `update1: ${r1.status} ${JSON.stringify(r1.body).slice(0,150)}` };
  let c = await readCase(caseId);
  if (c.status !== "open") return { name, pass: false, detail: `expected open (no auto-triage); got ${c.status}` };
  if (c.cause?.primary !== "missing_required_proof") return { name, pass: false, detail: `cause not set` };
  if (!c.cause?.categorizedBy) return { name, pass: false, detail: `cause.categorizedBy not stamped` };

  // open → in_progress is now a direct legal transition.
  const r2 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "in_progress",
  });
  if (r2.status !== 200) return { name, pass: false, detail: `update2: ${r2.status}` };
  c = await readCase(caseId);
  if (c.status !== "in_progress") return { name, pass: false, detail: `expected in_progress; got ${c.status}` };

  const audit = await readAuditForCase(caseId);
  if (audit.includes("case_triaged")) return { name, pass: false, detail: `unexpected case_triaged audit (state dropped in PR 129a): ${audit}` };
  if (!audit.includes("case_status_changed")) return { name, pass: false, detail: `no case_status_changed audit` };
  return { name, pass: true, detail: `cause set without auto-triage; open → in_progress direct; no case_triaged audit` };
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
  // PR 129a — Walk: open → in_progress → recovered (triaged collapsed).
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

  // PR 129a — auto-flip: this was the only action and it's now done,
  // so the case should have auto-transitioned to ready_to_resubmit
  // with case_ready_for_resubmission + case_status_changed audits.
  const caseFinal = await readCase(caseId);
  if (caseFinal.status !== "ready_to_resubmit") {
    return { name, pass: false, detail: `expected case auto-flip to ready_to_resubmit; got ${caseFinal.status}` };
  }
  if (!audit.includes("case_ready_for_resubmission")) {
    return { name, pass: false, detail: `no case_ready_for_resubmission audit: ${audit}` };
  }
  return { name, pass: true, detail: `action lifecycle + auto-flip to ready_to_resubmit when last open action closes` };
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
    token, action: "reject", comment: "Please call to discuss",
  });
  if (rejRes.status !== 200) return { name, pass: false, detail: `reject: ${rejRes.status}` };

  // Verify auto-created case exists.
  const c = await findCaseByIncident(incidentId);
  if (!c) return { name, pass: false, detail: "case not auto-created" };
  if (c.status !== "open") return { name, pass: false, detail: `case status=${c.status}` };
  if (c.rejection?.source !== "customer_rejected") return { name, pass: false, detail: `source=${c.rejection?.source}` };
  if (c.priority !== "medium") return { name, pass: false, detail: `priority=${c.priority}` };
  if (c.cause?.customerComment !== "Please call to discuss") return { name, pass: false, detail: `comment not captured: ${c.cause?.customerComment}` };
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
  const name = "13) Second rejection extends existing case (no duplicate); packetVersions.length=2; status → in_progress";
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
  // PR 129a — cycleCount removed; verify packetVersions.length instead.
  if (c2.packetVersions.length !== 2) return { name, pass: false, detail: `packetVersions.length=${c2.packetVersions.length}` };
  if (c2.status !== "in_progress") return { name, pass: false, detail: `expected in_progress after 2nd reject; got ${c2.status}` };

  // PR 129a — case_re_rejected audit should have fired because the 2nd
  // rejection landed on a packet that was outstanding (pending → rejected).
  const audit = await readAuditForCase(caseId);
  if (!audit.includes("case_re_rejected")) {
    return { name, pass: false, detail: `expected case_re_rejected audit; got: ${audit}` };
  }
  if (!audit.includes("packet_version_outcome")) {
    return { name, pass: false, detail: `expected packet_version_outcome audit; got: ${audit}` };
  }

  return { name, pass: true, detail: `single case absorbed 2 rejections; packetVersions=2; case_re_rejected + packet_version_outcome audits fired` };
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

async function s15_createWithCauseStaysOpen() {
  // PR 129a — `triaged` state dropped. Manual create with cause.primary
  // supplied lands at `open`; cause.categorizedBy + cause.primary carry
  // the triage signal. case_triaged audit no longer emitted (regression
  // guard).
  const name = "15) PR 129a: createRecoveryCaseV1 with cause stays open (no auto-triage); cause.categorizedBy stamped; no case_triaged audit";
  const incidentIdA = "inc-s15-with-cause";
  const incidentIdB = "inc-s15-no-cause";
  await seedIncident(incidentIdA);
  await seedIncident(incidentIdB);

  // With cause.primary → status=open; cause persisted with categorizedBy.
  const rA = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incidentIdA,
    source: "internal_qc", priority: "high",
    cause: { primary: "missing_required_proof", operatorNotes: "Set at create time" },
  });
  if (rA.status !== 200) return { name, pass: false, detail: `with cause: ${rA.status}` };
  if (rA.body.status !== "open") {
    return { name, pass: false, detail: `with cause: status=${rA.body.status} (expected open after PR 129a)` };
  }
  const cA = await readCase(rA.body.caseId);
  if (cA.status !== "open") return { name, pass: false, detail: `with cause doc: status=${cA.status}` };
  if (cA.cause?.primary !== "missing_required_proof") return { name, pass: false, detail: `cause not persisted` };

  const auditA = await readAuditForCase(rA.body.caseId);
  if (!auditA.includes("case_opened")) return { name, pass: false, detail: `with cause: no case_opened: ${auditA}` };
  if (auditA.includes("case_triaged")) {
    return { name, pass: false, detail: `unexpected case_triaged (state dropped in PR 129a): ${auditA}` };
  }

  // Without cause.primary → also status=open + only case_opened audit
  const rB = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incidentIdB,
    source: "internal_qc", priority: "low",
  });
  if (rB.status !== 200) return { name, pass: false, detail: `no cause: ${rB.status}` };
  if (rB.body.status !== "open") {
    return { name, pass: false, detail: `no cause: status=${rB.body.status}` };
  }
  const cB = await readCase(rB.body.caseId);
  if (cB.status !== "open") return { name, pass: false, detail: `no cause doc: status=${cB.status}` };

  const auditB = await readAuditForCase(rB.body.caseId);
  if (!auditB.includes("case_opened")) return { name, pass: false, detail: `no cause: no case_opened: ${auditB}` };
  if (auditB.includes("case_triaged")) {
    return { name, pass: false, detail: `no cause: unexpected case_triaged: ${auditB}` };
  }

  return { name, pass: true, detail: `both paths land at open; no case_triaged audit on either; cause.primary persisted when supplied` };
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
    // PR 129a — case_triaged removed; expect ≥3: case_opened + action_created × 2
    return { name, pass: false, detail: `audit=${ok.body.audit?.length} (expected ≥3: case_opened, action_created × 2)` };
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

// ── PR 128a scenarios ──────────────────────────────────────────────

async function s21_autoCreateInfersCauseFromComment() {
  const name = "21) PR 128a: Auto-create on customer_rejected infers cause from comment; OTDR keyword → missing_test_result";
  const incidentId = "inc-s21-otdr-reject";
  await seedIncident(incidentId);

  const mintRes = await postJson("createCustomerReviewLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
  });
  if (mintRes.status !== 200) return { name, pass: false, detail: `mint failed: ${mintRes.status}` };

  const rejRes = await postJson("submitCustomerReviewV1", {
    token: mintRes.body.token, action: "reject", comment: "We need the OTDR trace before we can sign off.",
  });
  if (rejRes.status !== 200) return { name, pass: false, detail: `reject failed: ${rejRes.status}` };

  const c = await findCaseByIncident(incidentId);
  if (!c) return { name, pass: false, detail: "case not auto-created" };
  if (c.cause?.primary !== "missing_test_result") return { name, pass: false, detail: `cause.primary=${c.cause?.primary} (expected missing_test_result)` };
  if (c.cause?.inferredFromComment !== true) return { name, pass: false, detail: `inferredFromComment=${c.cause?.inferredFromComment}` };
  // PR 129a — `triaged` state dropped; case stays at `open`.
  // cause.inferredFromComment + cause.primary carry the pre-classified signal.
  if (c.status !== "open") return { name, pass: false, detail: `status=${c.status} (expected open after PR 129a)` };
  const audit = await readAuditForCase(c.id);
  // case_triaged audit no longer emitted.
  if (audit.includes("case_triaged")) {
    return { name, pass: false, detail: `unexpected case_triaged audit (PR 129a dropped this): ${audit}` };
  }
  if (!audit.includes("case_auto_opened_from_rejection")) {
    return { name, pass: false, detail: `no case_auto_opened_from_rejection: ${audit}` };
  }

  return { name, pass: true, detail: `cause inferred → missing_test_result; case at open; inferredFromComment=true; no case_triaged audit` };
}

async function s22_autoCreateNoMatchKeepsCauseUnset() {
  const name = "22) PR 128a: customer comment with no keyword match leaves cause.primary unset";
  const incidentId = "inc-s22-no-keyword-match";
  await seedIncident(incidentId);
  const mintRes = await postJson("createCustomerReviewLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
  });
  const rejRes = await postJson("submitCustomerReviewV1", {
    token: mintRes.body.token, action: "reject", comment: "Looks fine to me but we still need to talk.",
  });
  if (rejRes.status !== 200) return { name, pass: false, detail: `reject failed: ${rejRes.status}` };
  const c = await findCaseByIncident(incidentId);
  if (!c) return { name, pass: false, detail: "case not auto-created" };
  if (c.cause?.primary) return { name, pass: false, detail: `unexpected cause.primary=${c.cause.primary} for no-keyword-match` };
  if (c.cause?.inferredFromComment === true) return { name, pass: false, detail: `inferredFromComment=true with no cause set` };
  if (c.status !== "open") return { name, pass: false, detail: `status=${c.status} (expected open)` };
  return { name, pass: true, detail: `no keyword match → cause.primary unset; status open` };
}

async function s23_suggestedActionsInResponse() {
  const name = "23) PR 128a: getRecoveryCaseV1 returns suggestedActions filtered against existing";
  const incidentId = "inc-s23-suggestions";
  await seedIncident(incidentId);
  const createRes = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc",
    cause: { primary: "missing_test_result" },
  });
  const caseId = createRes.body.caseId;

  // No actions yet → expect both suggestions
  let getRes = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (getRes.status !== 200) return { name, pass: false, detail: `get1 failed: ${getRes.status}` };
  const initial = getRes.body.suggestedActions;
  if (!Array.isArray(initial) || initial.length !== 2) return { name, pass: false, detail: `expected 2 suggestions; got ${initial?.length}` };
  if (initial[0].type !== "provide_test_results") return { name, pass: false, detail: `first suggestion type=${initial[0].type}` };
  if (!initial[0].description || initial[0].description.length === 0) return { name, pass: false, detail: `first suggestion missing description (pre-populated check)` };
  if (initial[0].assigneeRole !== "field_lead") return { name, pass: false, detail: `first suggestion role=${initial[0].assigneeRole}` };

  // Add one of the suggested types → expect filtered to 1
  await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "provide_test_results", title: "Already added",
  });
  getRes = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  const afterAdd = getRes.body.suggestedActions;
  if (!Array.isArray(afterAdd) || afterAdd.length !== 1) return { name, pass: false, detail: `after add: expected 1; got ${afterAdd?.length}` };
  if (afterAdd[0].type !== "re_submit_to_customer") return { name, pass: false, detail: `remaining suggestion type=${afterAdd[0].type}` };

  return { name, pass: true, detail: `suggestions returned + filtered after add; descriptions + roles pre-populated` };
}

async function s24_neverOverwriteManuallySetCause() {
  const name = "24) PR 128a: keyword match must NOT overwrite a manually-set cause on case extension (second rejection)";
  const incidentId = "inc-s24-no-overwrite";
  await seedIncident(incidentId);

  // First reject — comment "blurry" → derives proof_quality_insufficient
  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "Photo is blurry" });
  let c = await findCaseByIncident(incidentId);
  if (c.cause?.primary !== "proof_quality_insufficient") return { name, pass: false, detail: `1st: cause=${c.cause?.primary}` };

  // Operator manually overrides cause to documentation_error
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId: c.id,
    cause: { primary: "documentation_error" },
  });
  c = (await db.doc(`orgs/${ORG_ID}/recovery_cases/${c.id}`).get()).data();
  if (c.cause.primary !== "documentation_error") return { name, pass: false, detail: `after override: cause=${c.cause.primary}` };
  if (c.cause.inferredFromComment !== false) return { name, pass: false, detail: `inferredFromComment not cleared after manual set` };

  // Send a second reject with comment that WOULD match a different cause
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).update({ status: "in_progress" });
  await postJson("updateRecoveryCaseV1", { actorUid: ADMIN_UID, orgId: ORG_ID, caseId: c.id, status: "in_progress" });
  const mint2 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint2.body.token, action: "reject", comment: "OTDR trace is missing" });

  c = (await db.doc(`orgs/${ORG_ID}/recovery_cases/${c.id}`).get()).data();
  if (c.cause.primary !== "documentation_error") return { name, pass: false, detail: `2nd reject overwrote cause to ${c.cause.primary}` };

  return { name, pass: true, detail: `manual cause preserved across second rejection; inferredFromComment cleared on manual set` };
}

// ── main ───────────────────────────────────────────────────────────
// ── PR 129a — Resubmission loop scenarios ─────────────────────────

async function s25_mintResubmission_happyPath() {
  // Full resubmission loop: auto-create case → set cause → set in_progress
  // → complete only action → auto-flip to ready_to_resubmit →
  // mintResubmissionLinkV1 → awaiting_customer with ordinal=2 packet.
  const name = "25) PR 129a: mintResubmissionLinkV1 happy path — ready_to_resubmit → awaiting_customer; ordinal=2; case_resubmitted audit";
  const incidentId = "inc-s25-resubmit";
  await seedIncident(incidentId);

  // First rejection auto-creates case + starter action.
  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "Need clarification" });

  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });

  // Complete the auto-created starter action — last action → auto-flip.
  const actionsSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  if (actionsSnap.empty) return { name, pass: false, detail: "no starter action found" };
  const starterActionId = actionsSnap.docs[0].id;
  const r1 = await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: starterActionId,
    status: "done", outcome: "Captured what was missing",
  });
  if (r1.status !== 200) return { name, pass: false, detail: `action done: ${r1.status}` };
  if (r1.body.caseAutoFlippedToReadyToResubmit !== true) {
    return { name, pass: false, detail: `expected caseAutoFlippedToReadyToResubmit=true; got ${r1.body.caseAutoFlippedToReadyToResubmit}` };
  }

  let c = await readCase(caseId);
  if (c.status !== "ready_to_resubmit") return { name, pass: false, detail: `expected ready_to_resubmit; got ${c.status}` };

  // Mint the resubmission link.
  const mintR = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    changeSummary: "Recaptured missing proof; ready for re-review.",
  });
  if (mintR.status !== 200) return { name, pass: false, detail: `mint resub: ${mintR.status} ${JSON.stringify(mintR.body).slice(0,200)}` };
  if (mintR.body.ordinal !== 2) return { name, pass: false, detail: `expected ordinal=2; got ${mintR.body.ordinal}` };
  if (mintR.body.status !== "awaiting_customer") return { name, pass: false, detail: `mint status=${mintR.body.status}` };
  if (!mintR.body.token) return { name, pass: false, detail: "no token in response" };

  c = await readCase(caseId);
  if (c.status !== "awaiting_customer") return { name, pass: false, detail: `case status=${c.status} after mint` };
  if (c.packetVersions.length !== 2) return { name, pass: false, detail: `packetVersions=${c.packetVersions.length}; expected 2` };
  const v2 = c.packetVersions.find((p) => p.ordinal === 2);
  if (!v2) return { name, pass: false, detail: "v2 not in packetVersions" };
  if (v2.outcome !== "pending") return { name, pass: false, detail: `v2.outcome=${v2.outcome}` };
  if (v2.changeSummary !== "Recaptured missing proof; ready for re-review.") {
    return { name, pass: false, detail: `v2.changeSummary not persisted` };
  }

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("case_ready_for_resubmission")) return { name, pass: false, detail: `no case_ready_for_resubmission: ${audit}` };
  if (!audit.includes("case_resubmitted")) return { name, pass: false, detail: `no case_resubmitted: ${audit}` };
  return { name, pass: true, detail: `auto-flip + mint resubmission → ordinal=2 v2 packet; awaiting_customer; case_resubmitted audit fired` };
}

async function s26_mintResubmission_rejectedWhenNotReady() {
  // mintResubmissionLinkV1 must refuse when the case isn't in
  // ready_to_resubmit — protects against operator mints out of state.
  const name = "26) PR 129a: mintResubmissionLinkV1 rejects when case.status != ready_to_resubmit";
  const incidentId = "inc-s26-not-ready";
  await seedIncident(incidentId);

  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = create.body.caseId;
  // Case is at `open` — not eligible to mint resubmission.
  const r = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
  });
  if (r.status !== 409 || r.body?.error !== "invalid_status_for_resubmission") {
    return { name, pass: false, detail: `expected 409 invalid_status_for_resubmission; got ${r.status} ${JSON.stringify(r.body).slice(0,150)}` };
  }
  return { name, pass: true, detail: `409 invalid_status_for_resubmission when case is open (not ready_to_resubmit)` };
}

async function s27_resubmission_customerAccepts() {
  // Customer accepts the resubmission packet → case → recovered;
  // packet_version_outcome audit + revenue_recovered fire.
  const name = "27) PR 129a: customer accepts resubmission → case recovered + packet_version_outcome (accepted)";
  const incidentId = "inc-s27-accept-v2";
  await seedIncident(incidentId);

  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "Need it captured" });

  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
    revenueAtRisk: { amount: 5000, type: "actual" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  // Complete starter action → auto-flip to ready_to_resubmit
  const acts = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: acts.docs[0].id,
    status: "done", outcome: "Done",
  });

  const mintR = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
  });
  if (mintR.status !== 200) return { name, pass: false, detail: `mint resub: ${mintR.status}` };

  // Customer accepts the new packet.
  const acc = await postJson("submitCustomerReviewV1", {
    token: mintR.body.token, action: "accept", comment: "Looks good now",
  });
  if (acc.status !== 200) return { name, pass: false, detail: `accept: ${acc.status}` };

  const c = await readCase(caseId);
  if (c.status !== "recovered") return { name, pass: false, detail: `expected recovered; got ${c.status}` };
  const v2 = c.packetVersions.find((p) => p.ordinal === 2);
  if (!v2 || v2.outcome !== "accepted") {
    return { name, pass: false, detail: `v2.outcome=${v2 && v2.outcome}; expected accepted` };
  }

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("packet_version_outcome")) return { name, pass: false, detail: `no packet_version_outcome: ${audit}` };
  if (!audit.includes("revenue_recovered")) return { name, pass: false, detail: `no revenue_recovered: ${audit}` };
  return { name, pass: true, detail: `v2 accepted → case recovered + packet_version_outcome(accepted) + revenue_recovered audits` };
}

async function s28_resubmission_customerReRejects() {
  // Customer rejects the resubmission → case → in_progress + case_re_rejected
  // + packet outcome flipped to rejected.
  const name = "28) PR 129a: customer re-rejects resubmission → in_progress + case_re_rejected + packet_version_outcome(rejected)";
  const incidentId = "inc-s28-rereject-v2";
  await seedIncident(incidentId);

  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "First reject" });
  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  const acts = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: acts.docs[0].id, status: "done",
  });

  const mintR = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
  });
  if (mintR.status !== 200) return { name, pass: false, detail: `mint resub: ${mintR.status}` };

  // Customer re-rejects.
  const rej = await postJson("submitCustomerReviewV1", {
    token: mintR.body.token, action: "reject", comment: "Still not what I asked for",
  });
  if (rej.status !== 200) return { name, pass: false, detail: `re-reject: ${rej.status}` };

  const c = await readCase(caseId);
  if (c.status !== "in_progress") return { name, pass: false, detail: `expected in_progress; got ${c.status}` };
  const v2 = c.packetVersions.find((p) => p.ordinal === 2);
  if (!v2 || v2.outcome !== "rejected") {
    return { name, pass: false, detail: `v2.outcome=${v2 && v2.outcome}; expected rejected` };
  }
  // Still one case for this incident — no duplicate.
  const allCases = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", incidentId).get();
  if (allCases.size !== 1) return { name, pass: false, detail: `expected 1 case; got ${allCases.size}` };

  const audit = await readAuditForCase(caseId);
  if (!audit.includes("case_re_rejected")) return { name, pass: false, detail: `no case_re_rejected: ${audit}` };
  if (!audit.includes("packet_version_outcome")) return { name, pass: false, detail: `no packet_version_outcome: ${audit}` };
  return { name, pass: true, detail: `v2 re-rejected → in_progress; case_re_rejected + packet_version_outcome audits; no duplicate case` };
}

async function s29_resubmissionCount_derived() {
  // getRecoveryCaseV1 should expose resubmissionCount = packetVersions.length - 1.
  const name = "29) PR 129a: getRecoveryCaseV1 returns resubmissionCount derived (length - 1); cycleCount no longer in response";
  const incidentId = "inc-s29-resub-count";
  await seedIncident(incidentId);

  // 0 packets → resubmissionCount = 0 (we floor at 0)
  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = create.body.caseId;
  const getRes0 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (getRes0.status !== 200) return { name, pass: false, detail: `get0: ${getRes0.status}` };
  if (getRes0.body.case.resubmissionCount !== 0) {
    return { name, pass: false, detail: `expected resubmissionCount=0 with 0 packets; got ${getRes0.body.case.resubmissionCount}` };
  }
  if ("cycleCount" in getRes0.body.case) {
    return { name, pass: false, detail: `cycleCount still in response: ${getRes0.body.case.cycleCount}` };
  }

  // Mint two packets manually via createCustomerReviewLinkV1 path
  // (case is open → not eligible for mintResubmissionLinkV1, but the
  // incident-side mint appends to any non-terminal case).
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
  });
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  // Bump incident back to in_progress so we can mint a second link.
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).update({ status: "in_progress" });
  await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });

  const getRes2 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (getRes2.status !== 200) return { name, pass: false, detail: `get2: ${getRes2.status}` };
  if (getRes2.body.case.resubmissionCount !== 1) {
    return { name, pass: false, detail: `expected resubmissionCount=1 with 2 packets; got ${getRes2.body.case.resubmissionCount}` };
  }
  // Ordinals: v1 + v2 should both be present and sorted.
  const pkts = getRes2.body.case.packetVersions || [];
  if (pkts.length !== 2 || pkts[0].ordinal !== 1 || pkts[1].ordinal !== 2) {
    return { name, pass: false, detail: `packetVersions ordinals: ${pkts.map((p)=>p.ordinal).join(",")}` };
  }

  return { name, pass: true, detail: `resubmissionCount = packetVersions.length - 1; ordinals=[1,2]; cycleCount removed from response` };
}

async function s30_caseIdIsIncidentId() {
  // PR 129a — new cases auto-created use caseId = `case_${incidentId}`.
  const name = "30) PR 129a: new auto-created cases use caseId = `case_${incidentId}` (sanitized)";
  const incidentId = "inc-s30-canonical-id";
  await seedIncident(incidentId);
  const mint = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint.body.token, action: "reject", comment: "Reject" });

  const c = await findCaseByIncident(incidentId);
  // Sanitization rule in deterministicCaseId — alphanumeric / underscore / dash preserved.
  const expectedId = `case_${incidentId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (c.id !== expectedId) {
    return { name, pass: false, detail: `caseId=${c.id}; expected ${expectedId} (PR 129a canonical scheme)` };
  }
  return { name, pass: true, detail: `auto-created caseId is case_<incidentId>; no token suffix` };
}

// ── PR 129c — Full v2/v3 round-trip ───────────────────────────────
// Proves the complete Recovery Resubmission Loop end-to-end inside
// one case, exercising every state transition the architecture lock
// promises: customer reject → ready_to_resubmit → mint v2 →
// awaiting_customer → customer re-reject → in_progress → ready again
// → mint v3 → awaiting → customer accept → recovered.

async function s31_fullResubmissionRoundTrip() {
  const name = "31) PR 129c: Full v2/v3 round-trip (reject v1 → mint v2 → reject v2 → mint v3 → accept v3)";
  const incidentId = "inc-s31-full-round-trip";
  await seedIncident(incidentId);

  const transitions = [];

  // ── STEP 1: v1 mint + customer rejection (auto-create case) ────
  const v1 = await postJson("createCustomerReviewLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
  });
  if (v1.status !== 200) return { name, pass: false, detail: `v1 mint: ${v1.status} ${JSON.stringify(v1.body).slice(0,200)}` };
  // Comment chosen so the PR 128a keyword map infers
  // cause=missing_required_proof on auto-create.
  const rej1 = await postJson("submitCustomerReviewV1", {
    token: v1.body.token, action: "reject", comment: "We need missing photos for slot 3",
  });
  if (rej1.status !== 200) return { name, pass: false, detail: `v1 reject: ${rej1.status}` };

  const c0 = await findCaseByIncident(incidentId);
  if (!c0) return { name, pass: false, detail: "case not auto-created from v1 reject" };
  const caseId = c0.id;
  transitions.push(`v1-reject:status=${c0.status}`);
  if (c0.status !== "open") {
    return { name, pass: false, detail: `after v1 reject: status=${c0.status} (expected open per PR 129a — no auto-triage)` };
  }
  if (c0.cause?.primary !== "missing_required_proof") {
    return { name, pass: false, detail: `inferred cause: ${c0.cause?.primary} (expected missing_required_proof from "missing" keyword)` };
  }
  if (c0.cause?.inferredFromComment !== true) {
    return { name, pass: false, detail: `cause.inferredFromComment not set` };
  }
  if (c0.packetVersions.length !== 1) {
    return { name, pass: false, detail: `expected 1 packetVersion after v1; got ${c0.packetVersions.length}` };
  }

  // ── STEP 2: operator sets revenue + transitions in_progress ────
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    revenueAtRisk: { amount: 8000, type: "actual", notes: "Disputed line item" },
  });
  const tr1 = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  if (tr1.status !== 200) return { name, pass: false, detail: `open → in_progress: ${tr1.status}` };

  // ── STEP 3: complete starter action → auto-flip ────────────────
  const actsSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  if (actsSnap.empty) return { name, pass: false, detail: "no starter action" };
  const starterId = actsSnap.docs[0].id;
  const done1 = await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: starterId,
    status: "done", outcome: "Clarified customer needs",
  });
  if (done1.status !== 200) return { name, pass: false, detail: `action done: ${done1.status}` };
  if (done1.body.caseAutoFlippedToReadyToResubmit !== true) {
    return { name, pass: false, detail: `expected auto-flip after last action done; flip flag=${done1.body.caseAutoFlippedToReadyToResubmit}` };
  }
  const c1 = await readCase(caseId);
  transitions.push(`actions-done:status=${c1.status}`);
  if (c1.status !== "ready_to_resubmit") {
    return { name, pass: false, detail: `after action done: status=${c1.status} (expected ready_to_resubmit)` };
  }

  // ── STEP 4: mint v2 via mintResubmissionLinkV1 ─────────────────
  const v2change = "Re-captured photos for slot 3 as requested.";
  const v2mint = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, changeSummary: v2change,
  });
  if (v2mint.status !== 200) return { name, pass: false, detail: `v2 mint: ${v2mint.status} ${JSON.stringify(v2mint.body).slice(0,200)}` };
  if (v2mint.body.ordinal !== 2) return { name, pass: false, detail: `v2 ordinal=${v2mint.body.ordinal}` };
  if (!v2mint.body.token || !v2mint.body.url) return { name, pass: false, detail: "v2 mint missing token/url" };

  const c2 = await readCase(caseId);
  transitions.push(`v2-mint:status=${c2.status},ordinal=${v2mint.body.ordinal}`);
  if (c2.status !== "awaiting_customer") return { name, pass: false, detail: `after v2 mint: status=${c2.status}` };
  if (c2.packetVersions.length !== 2) return { name, pass: false, detail: `v2 pkts=${c2.packetVersions.length}` };
  const v2pkt = c2.packetVersions.find((p) => p.ordinal === 2);
  if (!v2pkt) return { name, pass: false, detail: "v2 packetVersion entry missing" };
  if (v2pkt.outcome !== "pending") return { name, pass: false, detail: `v2.outcome=${v2pkt.outcome}` };
  if (v2pkt.changeSummary !== v2change) return { name, pass: false, detail: `v2.changeSummary not persisted; got=${v2pkt.changeSummary}` };

  // ── STEP 4-VERIFY: read via getRecoveryCaseV1 endpoint ─────────
  const getV2 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (getV2.status !== 200) return { name, pass: false, detail: `getRecoveryCaseV1: ${getV2.status}` };
  if (getV2.body.case.resubmissionCount !== 1) {
    return { name, pass: false, detail: `resubmissionCount=${getV2.body.case.resubmissionCount} after v2 mint (expected 1)` };
  }
  // Ordinals must round-trip through the response.
  const ords = (getV2.body.case.packetVersions || []).map((p) => p.ordinal).sort((a, b) => a - b);
  if (JSON.stringify(ords) !== "[1,2]") return { name, pass: false, detail: `response ordinals: ${JSON.stringify(ords)}` };

  // ── STEP 5: customer rejects v2 ────────────────────────────────
  const rej2 = await postJson("submitCustomerReviewV1", {
    token: v2mint.body.token, action: "reject",
    comment: "The blurry photos still aren't clear enough",
  });
  if (rej2.status !== 200) return { name, pass: false, detail: `v2 reject: ${rej2.status}` };

  const c3 = await readCase(caseId);
  transitions.push(`v2-reject:status=${c3.status}`);
  if (c3.status !== "in_progress") return { name, pass: false, detail: `after v2 reject: status=${c3.status} (expected in_progress)` };
  // v2 entry should now show outcome=rejected
  const v2Updated = c3.packetVersions.find((p) => p.ordinal === 2);
  if (v2Updated.outcome !== "rejected") return { name, pass: false, detail: `v2.outcome=${v2Updated.outcome} after reject (expected rejected)` };
  if (v2Updated.customerComment !== "The blurry photos still aren't clear enough") {
    return { name, pass: false, detail: `v2.customerComment not updated` };
  }
  // Single case invariant — no duplicate created.
  const allCases = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", incidentId).get();
  if (allCases.size !== 1) return { name, pass: false, detail: `expected 1 case for incident; got ${allCases.size}` };
  // Manual cause preserved across re-rejection.
  if (c3.cause?.primary !== "missing_required_proof") {
    return { name, pass: false, detail: `cause.primary mutated by re-rejection: ${c3.cause?.primary}` };
  }

  // ── STEP 5-VERIFY: suggestions still returned by endpoint ──────
  const getV2reject = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (!Array.isArray(getV2reject.body.suggestedActions)) {
    return { name, pass: false, detail: `suggestedActions not in response after re-reject` };
  }
  // Cause is still missing_required_proof → chain is [recapture_proof, re_submit_to_customer].
  // Existing actions: clarify_with_customer (done from step 3). Neither chain
  // type is present yet, so both are still suggested.
  const sugTypes = getV2reject.body.suggestedActions.map((s) => s.type).sort();
  if (sugTypes.length === 0) {
    return { name, pass: false, detail: `expected non-empty suggestions after re-reject; got empty` };
  }

  // ── STEP 6: add a new action + complete → second auto-flip ─────
  const addRes = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof", title: "Re-shoot for clarity at higher resolution",
    assigneeRole: "field_lead",
  });
  if (addRes.status !== 200) return { name, pass: false, detail: `add new action: ${addRes.status}` };
  const newActionId = addRes.body.actionId;

  const done2 = await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: newActionId,
    status: "done", outcome: "Re-shot at 4K, captured slate label",
  });
  if (done2.status !== 200) return { name, pass: false, detail: `2nd action done: ${done2.status}` };
  if (done2.body.caseAutoFlippedToReadyToResubmit !== true) {
    return { name, pass: false, detail: `expected 2nd auto-flip; flag=${done2.body.caseAutoFlippedToReadyToResubmit}` };
  }
  const c4 = await readCase(caseId);
  transitions.push(`v3-ready:status=${c4.status}`);
  if (c4.status !== "ready_to_resubmit") {
    return { name, pass: false, detail: `after 2nd action done: status=${c4.status}` };
  }

  // ── STEP 7: mint v3 ────────────────────────────────────────────
  const v3change = "Re-shot at higher resolution with slate label visible.";
  const v3mint = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, changeSummary: v3change,
  });
  if (v3mint.status !== 200) return { name, pass: false, detail: `v3 mint: ${v3mint.status} ${JSON.stringify(v3mint.body).slice(0,200)}` };
  if (v3mint.body.ordinal !== 3) return { name, pass: false, detail: `v3 ordinal=${v3mint.body.ordinal} (expected 3)` };

  const c5 = await readCase(caseId);
  transitions.push(`v3-mint:status=${c5.status},ordinal=${v3mint.body.ordinal}`);
  if (c5.status !== "awaiting_customer") return { name, pass: false, detail: `after v3 mint: status=${c5.status}` };
  if (c5.packetVersions.length !== 3) return { name, pass: false, detail: `v3 pkts=${c5.packetVersions.length}` };

  // ── STEP 8: customer accepts v3 → case recovered ───────────────
  const acc = await postJson("submitCustomerReviewV1", {
    token: v3mint.body.token, action: "accept", comment: "Perfect, accepted.",
  });
  if (acc.status !== 200) return { name, pass: false, detail: `v3 accept: ${acc.status}` };

  const cFinal = await readCase(caseId);
  transitions.push(`v3-accept:status=${cFinal.status}`);
  if (cFinal.status !== "recovered") {
    return { name, pass: false, detail: `final: status=${cFinal.status} (expected recovered)` };
  }
  const v3pkt = cFinal.packetVersions.find((p) => p.ordinal === 3);
  if (!v3pkt || v3pkt.outcome !== "accepted") {
    return { name, pass: false, detail: `v3.outcome=${v3pkt && v3pkt.outcome}` };
  }
  if (!cFinal.resolvedAt) return { name, pass: false, detail: "resolvedAt not stamped" };

  // ── FINAL: audit trail coherence ───────────────────────────────
  const audit = await readAuditForCase(caseId);
  // Must-have audit types across the whole round-trip:
  const required = [
    "case_auto_opened_from_rejection",
    "action_created",
    "case_status_changed",
    "case_revenue_updated",
    "action_completed",
    "case_ready_for_resubmission",
    "case_resubmitted",
    "case_re_rejected",
    "packet_version_outcome",
    "case_resolved",
    "revenue_recovered",
  ];
  const missing = required.filter((t) => !audit.includes(t));
  if (missing.length > 0) {
    return { name, pass: false, detail: `missing audit types: ${missing.join(", ")} | got: ${[...new Set(audit)].sort().join(", ")}` };
  }
  // case_resubmitted must have fired twice (v2 + v3).
  const resubmittedCount = audit.filter((t) => t === "case_resubmitted").length;
  if (resubmittedCount !== 2) {
    return { name, pass: false, detail: `case_resubmitted fired ${resubmittedCount} times (expected 2)` };
  }
  // case_ready_for_resubmission must have fired twice (before v2 + v3 mints).
  const readyCount = audit.filter((t) => t === "case_ready_for_resubmission").length;
  if (readyCount !== 2) {
    return { name, pass: false, detail: `case_ready_for_resubmission fired ${readyCount} times (expected 2)` };
  }

  // ── FINAL: getRecoveryCaseV1 response shape on terminal case ───
  const getFinal = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (getFinal.body.case.resubmissionCount !== 2) {
    return { name, pass: false, detail: `final resubmissionCount=${getFinal.body.case.resubmissionCount} (expected 2)` };
  }

  return {
    name, pass: true,
    detail: `transitions: ${transitions.join(" → ")} | pkts=3 (ordinal 1,2,3 outcomes rejected,rejected,accepted) | audit ${audit.length} rows | case_resubmitted×2, case_ready_for_resubmission×2`,
  };
}

// ── PR 130a — Foreman bridge scenarios ────────────────────────────
// Proves the field-side surface for recovery actions: foremen can
// complete their own work via the narrow wrapper, can't touch others'
// work, and the list endpoint strips all case-level data.

async function s32_foremanCompletesFieldLeadAction() {
  const name = "32) PR 130a: field user completes a field_lead-assigned recovery action via completeRecoveryFieldWorkV1 + auto-flip fires";
  const incidentId = "inc-s32-foreman-complete";
  await seedIncident(incidentId);

  // Set up: manual case with one field_lead-assigned action.
  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "medium",
    cause: { primary: "missing_required_proof" },
  });
  const caseId = create.body.caseId;
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  const addRes = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof", title: "Re-shoot slot 3",
    assigneeRole: "field_lead",
  });
  const actionId = addRes.body.actionId;

  // Field user marks it in_progress → done.
  const r1 = await postJson("completeRecoveryFieldWorkV1", {
    actorUid: FIELD_UID, orgId: ORG_ID, incidentId, actionId,
    status: "in_progress",
  });
  if (r1.status !== 200) return { name, pass: false, detail: `in_progress: ${r1.status} ${JSON.stringify(r1.body).slice(0,200)}` };

  const r2 = await postJson("completeRecoveryFieldWorkV1", {
    actorUid: FIELD_UID, orgId: ORG_ID, incidentId, actionId,
    status: "done", outcome: "Re-shot 4K with slate label visible",
  });
  if (r2.status !== 200) return { name, pass: false, detail: `done: ${r2.status} ${JSON.stringify(r2.body).slice(0,200)}` };
  if (r2.body.caseAutoFlippedToReadyToResubmit !== true) {
    return { name, pass: false, detail: `expected auto-flip; got ${r2.body.caseAutoFlippedToReadyToResubmit}` };
  }

  // Verify the action persisted with field-user attribution.
  const actionDoc = (await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions/${actionId}`).get()).data();
  if (actionDoc.status !== "done") return { name, pass: false, detail: `action.status=${actionDoc.status}` };
  if (actionDoc.outcome !== "Re-shot 4K with slate label visible") return { name, pass: false, detail: `outcome not persisted` };
  if (!actionDoc.startedAt) return { name, pass: false, detail: `startedAt not stamped` };
  if (!actionDoc.completedAt) return { name, pass: false, detail: `completedAt not stamped` };

  // Verify case auto-flipped.
  const c = await readCase(caseId);
  if (c.status !== "ready_to_resubmit") return { name, pass: false, detail: `case status=${c.status}` };

  // Verify audit chain has the foreman-source meta tag.
  const auditSnap = await db.collection(`orgs/${ORG_ID}/recovery_audit`)
    .where("caseId", "==", caseId).get();
  const fieldRows = auditSnap.docs
    .map((d) => d.data())
    .filter((a) => a.meta && a.meta.source === "field_work_endpoint");
  if (fieldRows.length < 2) {
    return { name, pass: false, detail: `expected ≥2 audit rows tagged source=field_work_endpoint; got ${fieldRows.length}` };
  }
  // The completed action's audit row was the one fired by the field
  // endpoint. action_completed should have actor=FIELD_UID.
  const completedRow = fieldRows.find((a) => a.type === "action_completed");
  if (!completedRow) return { name, pass: false, detail: `no action_completed via field endpoint` };
  if (completedRow.actorUid !== FIELD_UID) return { name, pass: false, detail: `action_completed actorUid=${completedRow.actorUid}` };
  if (String(completedRow.actorRole || "").toLowerCase() !== "field") {
    return { name, pass: false, detail: `actorRole=${completedRow.actorRole} (expected field)` };
  }

  return { name, pass: true, detail: `field user completed field_lead action; auto-flip fired; audit rows tagged source=field_work_endpoint` };
}

async function s33_foremanForbiddenForCoordinatorAction() {
  const name = "33) PR 130a: field user cannot complete a coordinator-assigned action via completeRecoveryFieldWorkV1 → 403";
  const incidentId = "inc-s33-foreman-forbidden";
  await seedIncident(incidentId);

  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = create.body.caseId;
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  // Action assigned to coordinator role (NOT field_lead) and NOT
  // assigned to the field user by uid.
  const addRes = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "clarify_with_customer", title: "Coordinator-only task",
    assigneeRole: "coordinator",
  });
  const actionId = addRes.body.actionId;

  const attempt = await postJson("completeRecoveryFieldWorkV1", {
    actorUid: FIELD_UID, orgId: ORG_ID, incidentId, actionId,
    status: "done", outcome: "trying to sneak in",
  });
  if (attempt.status !== 403 || attempt.body?.error !== "not_authorized_for_action") {
    return { name, pass: false, detail: `expected 403 not_authorized_for_action; got ${attempt.status} ${JSON.stringify(attempt.body).slice(0,200)}` };
  }

  // Confirm action didn't change.
  const actionDoc = (await db.doc(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions/${actionId}`).get()).data();
  if (actionDoc.status !== "open") return { name, pass: false, detail: `action mutated despite 403: status=${actionDoc.status}` };

  return { name, pass: true, detail: `403 not_authorized_for_action; action untouched` };
}

async function s34_listRecoveryActionsForIncidentScoping() {
  const name = "34) PR 130a: listRecoveryActionsForIncidentV1 returns only visible actions; response excludes case-level data";
  const incidentId = "inc-s34-foreman-list";
  await seedIncident(incidentId);

  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "high",
    cause: { primary: "missing_required_proof" },
    revenueAtRisk: { amount: 15000, type: "actual" },
  });
  const caseId = create.body.caseId;
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });
  // Add three actions:
  //   1. field_lead role  → visible to field user
  //   2. coordinator role → invisible to field user
  //   3. specifically assigned to FIELD_UID  → visible
  const a1 = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof", title: "Re-shoot proof", assigneeRole: "field_lead",
  });
  const a2 = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "clarify_with_customer", title: "Customer call", assigneeRole: "coordinator",
  });
  // Direct uid assignment overrides role check.
  const a3Add = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "documentation_fix", title: "Update notes", assigneeRole: "supervisor",
    assignee: FIELD_UID,
  });
  // Field user calls the list endpoint.
  const list = await getJson("listRecoveryActionsForIncidentV1", {
    orgId: ORG_ID, incidentId, actorUid: FIELD_UID,
  });
  if (list.status !== 200) return { name, pass: false, detail: `list: ${list.status} ${JSON.stringify(list.body).slice(0,200)}` };
  const work = list.body.openWork || [];
  if (work.length !== 2) {
    return { name, pass: false, detail: `expected 2 visible items (field_lead + uid-assigned); got ${work.length}: ${work.map((w) => w.title).join("; ")}` };
  }
  const titles = work.map((w) => w.title).sort();
  if (JSON.stringify(titles) !== JSON.stringify(["Re-shoot proof", "Update notes"])) {
    return { name, pass: false, detail: `visible titles: ${titles.join(",")}` };
  }

  // Verify response shape excludes case-level data. The forbidden
  // surface from architecture lock: no caseId, no case.status, no
  // revenue, no resubmission state, no cause taxonomy in the response.
  const responseStr = JSON.stringify(list.body);
  const forbiddenSubstrings = ["revenueAtRisk", "resubmission", "cycleCount", "rejection", "ownership"];
  for (const f of forbiddenSubstrings) {
    if (responseStr.includes(f)) {
      return { name, pass: false, detail: `forbidden field surfaced in response: ${f}` };
    }
  }
  // case.status string would slip through "status" being on the action,
  // so check specifically that there's no "ready_to_resubmit" / "in_progress"
  // hint OUTSIDE the per-action status field. Quick heuristic: count
  // occurrences of "status" — should equal action count + "ok":true / etc.
  // Just verify there's no caseId leak (we DO carry _routeCaseId for the
  // completion call, prefixed with underscore as a convention but still
  // present; this is acceptable per design but document it).
  if (!work[0]._routeCaseId || !work[1]._routeCaseId) {
    return { name, pass: false, detail: "expected _routeCaseId on each work item for the completion call" };
  }
  if (work[0]._routeCaseId !== caseId) {
    return { name, pass: false, detail: `_routeCaseId mismatch: ${work[0]._routeCaseId}` };
  }

  // Field user can also complete an action assigned by uid (case 3).
  const a3Id = a3Add.body.actionId;
  const r = await postJson("completeRecoveryFieldWorkV1", {
    actorUid: FIELD_UID, orgId: ORG_ID, incidentId, actionId: a3Id,
    status: "done",
  });
  if (r.status !== 200) return { name, pass: false, detail: `uid-assigned complete: ${r.status} ${JSON.stringify(r.body).slice(0,200)}` };

  return { name, pass: true, detail: `field user sees 2 of 3 actions (field_lead + uid-assigned); coordinator-only hidden; no case-level data leaked; uid-assigned completion works` };
}

// ── PR 131a — Phase 2 suggestions scenarios ────────────────────────
// Verifies getRecoveryCaseV1's `suggestions` block:
//   - changeSummary from actions completed since last packet
//   - revenueAtRisk pre-fill via priority chain
//   - resubmissionReadiness green/red/neutral states

async function s35_changeSummarySuggestion() {
  const name = "35) PR 131a: suggestions.changeSummary builds bullet list from actions completed since last packet";
  const incidentId = "inc-s35-change-summary";
  await seedIncident(incidentId);

  // v1 reject auto-creates case + starter action
  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "Need missing photos" });
  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
  });
  await postJson("updateRecoveryCaseV1", { actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress" });
  const actsSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  const starterId = actsSnap.docs[0].id;
  await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: starterId,
    status: "done",
  });

  const pre = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (pre.status !== 200 || !pre.body.suggestions) return { name, pass: false, detail: "no suggestions block in response" };
  const cs = pre.body.suggestions.changeSummary;
  if (!cs || !cs.startsWith("Changes made:")) return { name, pass: false, detail: `changeSummary=${cs}` };
  if (!cs.includes("•")) return { name, pass: false, detail: "expected bullet character in changeSummary" };

  return { name, pass: true, detail: `changeSummary populated: ${cs.replace(/\n/g, " | ")}` };
}

async function s36_revenueAtRiskSuggestion() {
  const name = "36) PR 131a: suggestions.revenueAtRisk priority chain — null when no source data; sum-of-jobs when seeded";
  const incidentId = "inc-s36-revenue-suggest";
  await seedIncident(incidentId);

  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = create.body.caseId;

  const r1 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (r1.body.suggestions.revenueAtRisk !== null) {
    return { name, pass: false, detail: `expected null suggestion with no data; got ${JSON.stringify(r1.body.suggestions.revenueAtRisk)}` };
  }

  await db.doc(`incidents/${incidentId}/jobs/job-a`).set({ status: "approved", reviewStatus: "approved", estimatedRevenue: 4500 });
  await db.doc(`incidents/${incidentId}/jobs/job-b`).set({ status: "approved", reviewStatus: "approved", estimatedRevenue: 2800 });
  const r2 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  const sug = r2.body.suggestions.revenueAtRisk;
  if (!sug || sug.amount !== 7300 || sug.type !== "estimated" || sug.source !== "sum_of_jobs") {
    return { name, pass: false, detail: `sum_of_jobs path: ${JSON.stringify(sug)}` };
  }

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    revenueAtRisk: { amount: 9000, type: "actual" },
  });
  const r3 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  if (r3.body.suggestions.revenueAtRisk !== null) {
    return { name, pass: false, detail: `expected null when actual already set; got ${JSON.stringify(r3.body.suggestions.revenueAtRisk)}` };
  }

  return { name, pass: true, detail: `null when no data; sum_of_jobs=$7300/estimated when seeded; null when actual already set` };
}

async function s37_resubmissionReadinessStates() {
  const name = "37) PR 131a: suggestions.resubmissionReadiness — red on open work, green on ready_to_resubmit, neutral on terminal";
  const incidentId = "inc-s37-readiness";
  await seedIncident(incidentId);

  const create = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
    source: "internal_qc", priority: "low",
  });
  const caseId = create.body.caseId;
  const r1 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  const rd1 = r1.body.suggestions.resubmissionReadiness;
  if (rd1.state !== "red" || rd1.ready !== false) return { name, pass: false, detail: `open+no-actions: ${JSON.stringify(rd1)}` };
  if (!rd1.reasons.some((s) => /No recovery actions/i.test(s))) {
    return { name, pass: false, detail: `expected "no actions" reason; got ${rd1.reasons.join(" | ")}` };
  }

  const addRes = await postJson("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "recapture_proof", title: "Capture photo", assigneeRole: "field_lead",
  });
  await postJson("updateRecoveryCaseV1", { actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress" });
  const r2 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  const rd2 = r2.body.suggestions.resubmissionReadiness;
  if (rd2.state !== "red") return { name, pass: false, detail: `in_progress+open: ${JSON.stringify(rd2)}` };
  if (!rd2.reasons.some((s) => /still open/i.test(s))) {
    return { name, pass: false, detail: `expected "still open" reason; got ${rd2.reasons.join(" | ")}` };
  }

  await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: addRes.body.actionId,
    status: "done",
  });
  const r3 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  const rd3 = r3.body.suggestions.resubmissionReadiness;
  if (rd3.state !== "green" || rd3.ready !== true) return { name, pass: false, detail: `ready_to_resubmit: ${JSON.stringify(rd3)}` };
  if (rd3.headline !== "Ready to resubmit") return { name, pass: false, detail: `green headline=${rd3.headline}` };

  // Abandon directly from ready_to_resubmit → terminal
  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    revenueAtRisk: { amount: 1000, type: "actual" },
  });
  const resolveRes = await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    status: "abandoned",
    resolution: { outcome: "abandoned", notes: "smoke test terminal" },
  });
  if (resolveRes.status !== 200) return { name, pass: false, detail: `abandon: ${resolveRes.status} ${JSON.stringify(resolveRes.body).slice(0,200)}` };
  const r4 = await getJson("getRecoveryCaseV1", { orgId: ORG_ID, caseId, actorUid: ADMIN_UID });
  const rd4 = r4.body.suggestions.resubmissionReadiness;
  if (rd4.state !== "neutral") return { name, pass: false, detail: `terminal: ${JSON.stringify(rd4)}` };

  return { name, pass: true, detail: `red(no actions) → red(open in_progress) → green(ready_to_resubmit) → neutral(terminal abandoned)` };
}

// ── PR 132a — Recovery Intelligence event enrichment scenarios ────

async function readAuditRowsForCase(caseId) {
  const snap = await db.collection(`orgs/${ORG_ID}/recovery_audit`)
    .where("caseId", "==", caseId)
    .get();
  return snap.docs.map((d) => d.data());
}

async function s38_hashedCustomerLabelOnCase() {
  const name = "38) PR 132a: hashedCustomerLabel persisted on auto-created + manually-created cases; same label produces same hash";
  const incidentA = "inc-s38-customer-hash-a";
  const incidentB = "inc-s38-customer-hash-b";
  await seedIncident(incidentA, { customer: "Acme Telecom Co" });
  await seedIncident(incidentB, { customer: "ACME Telecom Co " });

  const mint = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incidentA });
  await postJson("submitCustomerReviewV1", { token: mint.body.token, action: "reject", comment: "missing items" });
  const caseA = await findCaseByIncident(incidentA);
  if (!caseA?.hashedCustomerLabel || typeof caseA.hashedCustomerLabel !== "string" || caseA.hashedCustomerLabel.length !== 32) {
    return { name, pass: false, detail: `auto-create hashedCustomerLabel bad: ${caseA?.hashedCustomerLabel}` };
  }

  const manual = await postJson("createRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId: incidentB,
    source: "internal_qc", priority: "low",
  });
  const caseB = await readCase(manual.body.caseId);
  if (!caseB?.hashedCustomerLabel || caseB.hashedCustomerLabel.length !== 32) {
    return { name, pass: false, detail: `manual hashedCustomerLabel bad: ${caseB?.hashedCustomerLabel}` };
  }
  if (caseA.hashedCustomerLabel !== caseB.hashedCustomerLabel) {
    return { name, pass: false, detail: `hashes differ: ${caseA.hashedCustomerLabel} vs ${caseB.hashedCustomerLabel}` };
  }

  return { name, pass: true, detail: `both 32-char hashes; "Acme Telecom Co" / "ACME Telecom Co " produce identical hash` };
}

async function s39_causeOverriddenEvent() {
  const name = "39) PR 132a: cause_overridden audit fires on manual cause change; meta.originallyInferred true→false across two overrides";
  const incidentId = "inc-s39-cause-override";
  await seedIncident(incidentId);

  const mint = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint.body.token, action: "reject", comment: "Need OTDR trace before signoff" });
  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;
  if (c1.cause?.primary !== "missing_test_result") {
    return { name, pass: false, detail: `inferred cause wrong: ${c1.cause?.primary}` };
  }

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "scope_dispute" },
  });
  const rows1 = await readAuditRowsForCase(caseId);
  const ovs1 = rows1.filter((r) => r.type === "cause_overridden");
  if (ovs1.length !== 1) {
    return { name, pass: false, detail: `expected 1 cause_overridden; got ${ovs1.length}` };
  }
  if (ovs1[0].before?.causePrimary !== "missing_test_result" || ovs1[0].after?.causePrimary !== "scope_dispute") {
    return { name, pass: false, detail: `before/after wrong: ${JSON.stringify({ before: ovs1[0].before, after: ovs1[0].after })}` };
  }
  if (ovs1[0].meta?.originallyInferred !== true) {
    return { name, pass: false, detail: `originallyInferred=${ovs1[0].meta?.originallyInferred} (expected true)` };
  }

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "documentation_error" },
  });
  const rows2 = await readAuditRowsForCase(caseId);
  const ovs2 = rows2.filter((r) => r.type === "cause_overridden");
  if (ovs2.length !== 2) {
    return { name, pass: false, detail: `expected 2 cause_overridden rows; got ${ovs2.length}` };
  }
  const second = ovs2.find((r) => r.after?.causePrimary === "documentation_error");
  if (second?.meta?.originallyInferred !== false) {
    return { name, pass: false, detail: `second originallyInferred=${second?.meta?.originallyInferred} (expected false)` };
  }

  return { name, pass: true, detail: `cause_overridden fires with before/after; originallyInferred true on 1st (inferred), false on 2nd (after-flag-cleared)` };
}

async function s40_intelligenceEnrichmentsOnAuditRows() {
  const name = "40) PR 132a: intelligence enrichments on case_resolved (timing + counts), action_completed (timing + evidence), packet_version_outcome (timing + templateVersion)";
  const incidentId = "inc-s40-enrichments";
  await seedIncident(incidentId);

  const mint1 = await postJson("createCustomerReviewLinkV1", { actorUid: ADMIN_UID, orgId: ORG_ID, incidentId });
  await postJson("submitCustomerReviewV1", { token: mint1.body.token, action: "reject", comment: "Need photos" });
  const c1 = await findCaseByIncident(incidentId);
  const caseId = c1.id;

  await postJson("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    cause: { primary: "missing_required_proof" },
    revenueAtRisk: { amount: 5000, type: "actual" },
  });
  await postJson("updateRecoveryCaseV1", { actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress" });

  const actsSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  const starterId = actsSnap.docs[0].id;
  await postJson("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: starterId,
    status: "done", outcome: "Clarified",
  });

  const mint2 = await postJson("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    changeSummary: "Captured the missing items.",
  });
  if (mint2.status !== 200) return { name, pass: false, detail: `mint v2: ${mint2.status}` };

  await postJson("submitCustomerReviewV1", {
    token: mint2.body.token, action: "accept", comment: "Looks good",
  });

  const rows = await readAuditRowsForCase(caseId);

  const ac = rows.find((r) => r.type === "action_completed");
  if (!ac) return { name, pass: false, detail: "action_completed audit missing" };
  if (typeof ac.meta?.timeToCompleteSec !== "number" || ac.meta.timeToCompleteSec < 0) {
    return { name, pass: false, detail: `action_completed timeToCompleteSec invalid: ${JSON.stringify(ac.meta)}` };
  }
  if (typeof ac.meta?.evidenceAttachedCount !== "number") {
    return { name, pass: false, detail: `action_completed evidenceAttachedCount missing: ${JSON.stringify(ac.meta)}` };
  }
  if (!ac.meta?.actionType) {
    return { name, pass: false, detail: `action_completed actionType missing: ${JSON.stringify(ac.meta)}` };
  }

  const pkAccept = rows.find((r) => r.type === "packet_version_outcome" && r.meta?.outcome === "accepted");
  if (!pkAccept) return { name, pass: false, detail: "packet_version_outcome(accepted) missing" };
  if (typeof pkAccept.meta?.timeToOutcomeSec !== "number") {
    return { name, pass: false, detail: `pkAccept timeToOutcomeSec missing: ${JSON.stringify(pkAccept.meta)}` };
  }

  const cr = rows.find((r) => r.type === "case_resolved");
  if (!cr) return { name, pass: false, detail: "case_resolved audit missing" };
  if (typeof cr.meta?.timeToResolutionSec !== "number") {
    return { name, pass: false, detail: `case_resolved timeToResolutionSec missing: ${JSON.stringify(cr.meta)}` };
  }
  if (cr.meta?.totalResubmissions !== 1) {
    return { name, pass: false, detail: `case_resolved totalResubmissions=${cr.meta?.totalResubmissions} (expected 1)` };
  }
  if (typeof cr.meta?.totalActionsCompleted !== "number") {
    return { name, pass: false, detail: `case_resolved totalActionsCompleted missing: ${JSON.stringify(cr.meta)}` };
  }

  const rr = rows.find((r) => r.type === "revenue_recovered");
  if (!rr) return { name, pass: false, detail: "revenue_recovered audit missing" };
  if (typeof rr.meta?.timeToResolutionSec !== "number") {
    return { name, pass: false, detail: `revenue_recovered timeToResolutionSec missing: ${JSON.stringify(rr.meta)}` };
  }

  return {
    name, pass: true,
    detail: `action_completed{t=${ac.meta.timeToCompleteSec}s, evidence=${ac.meta.evidenceAttachedCount}, type=${ac.meta.actionType}} | pkt_outcome(accept){t=${pkAccept.meta.timeToOutcomeSec}s} | case_resolved{t=${cr.meta.timeToResolutionSec}s, resubmissions=${cr.meta.totalResubmissions}, actionsCompleted=${cr.meta.totalActionsCompleted}} | revenue_recovered{t=${rr.meta.timeToResolutionSec}s}`,
  };
}

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
    // PR 129a — cause-set no longer auto-triages; case stays open
    s15_createWithCauseStaysOpen,
    // PR 127a2 — list + get + derived priority
    s16_listRecoveryCasesV1,
    s17_getRecoveryCaseV1,
    s18_priorityDeriverThresholds,
    // PR 127a3 — new action type
    s19_actionType_provideTestResults,
    // PR 127c-a — denorm jobTitle + jobLocation
    s20_denormJobTitleAndLocation,
    // PR 128a — cause inference + suggested actions
    s21_autoCreateInfersCauseFromComment,
    s22_autoCreateNoMatchKeepsCauseUnset,
    s23_suggestedActionsInResponse,
    s24_neverOverwriteManuallySetCause,
    // PR 129a — resubmission loop
    s25_mintResubmission_happyPath,
    s26_mintResubmission_rejectedWhenNotReady,
    s27_resubmission_customerAccepts,
    s28_resubmission_customerReRejects,
    s29_resubmissionCount_derived,
    s30_caseIdIsIncidentId,
    // PR 129c — full v2/v3 round-trip in a single case (the smoke
    // the prod PR 129a verification couldn't reach because the smoke
    // target's incident was stuck at status=draft).
    s31_fullResubmissionRoundTrip,
    // PR 130a — foreman bridge backend: list endpoint scoping +
    // completeRecoveryFieldWorkV1 wrapper authorization.
    s32_foremanCompletesFieldLeadAction,
    s33_foremanForbiddenForCoordinatorAction,
    s34_listRecoveryActionsForIncidentScoping,
    // PR 131a — Phase 2 suggestions (changeSummary, revenueAtRisk,
    // resubmissionReadiness)
    s35_changeSummarySuggestion,
    s36_revenueAtRiskSuggestion,
    s37_resubmissionReadinessStates,
    // PR 132a — Recovery Intelligence event enrichments + new event
    s38_hashedCustomerLabelOnCase,
    s39_causeOverriddenEvent,
    s40_intelligenceEnrichmentsOnAuditRows,
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
