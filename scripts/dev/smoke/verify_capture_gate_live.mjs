#!/usr/bin/env node
// PR 135A — live verification on app.peakops.app + peakops-pilot.
//
// Provisions a throwaway org, drives the capture-gate matrix at both
// gated callables (submitFieldSessionV1, markJobCompleteV1), and
// confirms the audit subcollection is populated correctly.
//
// Matrix per callable (4 cases × 2 callables = 8 cases + audit check):
//   A: field-role call, no override         → 412 capture_gate_blocked + missing[]
//   B: field-role override attempt          → 403 override_role_required
//   C: admin short reason                   → 400 override_reason_invalid
//   D: admin valid reason                   → 200 + audit row written
//   Audit: capture_gate_blocked + capture_gate_overridden both present
//
// Cleanup tears down the throwaway org + Auth users.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const FOUNDER_SMOKE_UID = "capture-gate-verify-founder";

const saJson = JSON.parse(fs.readFileSync("/Users/kesserumini/peakops/my-app/.secrets/sa.json", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(saJson), projectId: PROJECT });
const db = admin.firestore();

function getApiKey() {
  const out = execSync(`firebase apps:sdkconfig WEB 1:1006996232574:web:99de916d6cc57d3fac3b2f --project ${PROJECT}`, { encoding: "utf8" });
  return JSON.parse(out.match(/\{[\s\S]*\}/)[0]).apiKey;
}

async function mintToken(uid, claims = {}) {
  try { await admin.auth().getUser(uid); } catch { await admin.auth().createUser({ uid, disabled: false }); }
  const customToken = await admin.auth().createCustomToken(uid, claims);
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${getApiKey()}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.idToken;
}

async function callFn(fn, body, idToken) {
  const r = await fetch(`${FN}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  🟢 ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  🔴 ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=", "base64");
async function uploadOneEvidence({ orgId, incidentId, sessionId, jobId, fileName, label, fieldToken, actorUid }) {
  const r = await callFn("createEvidenceUploadUrlV1", {
    orgId, incidentId, sessionId, actorUid,
    fileName, contentType: "image/png",
  }, fieldToken);
  if (r.body.ok !== true) throw new Error(`createEvidenceUploadUrlV1: ${JSON.stringify(r.body)}`);
  const put = await fetch(r.body.uploadUrl, { method: r.body.uploadMethod, headers: { "content-type": "image/png" }, body: PNG_1x1 });
  if (!put.ok) throw new Error(`upload GCS: ${put.status}`);
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  const r2 = await callFn("addEvidenceV1", {
    orgId, incidentId, sessionId, actorUid, jobId,
    bucket: r.body.bucket, storagePath: r.body.storagePath,
    fileName, originalName: fileName, contentType: "image/png",
    sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "DAMAGE", labels: [label],
    gps: { lat: 47.6679, lng: -117.2389, accuracyM: 6 },
  }, fieldToken);
  if (r2.body.ok !== true) throw new Error(`addEvidenceV1: ${JSON.stringify(r2.body)}`);
}

const tag = randomBytes(2).toString("hex");
const ORG_NAME = `CaptureGate Verify ${tag}`;
const ADMIN_EMAIL = `cap-admin-${tag}@verify.example.com`;
const FIELD_EMAIL = `cap-field-${tag}@verify.example.com`;
const cleanup = { orgId: null, uids: new Set([FOUNDER_SMOKE_UID]), incidentIds: new Set() };

console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  PR 135A — capture-gate live verification`);
console.log(`══════════════════════════════════════════════════════════════════\n`);

try {
  const founderToken = await mintToken(FOUNDER_SMOKE_UID, { peakopsInternalAdmin: true });

  // Provision throwaway org (gets captureGate.mode=block by PR 135A default)
  const create = await callFn("createOrgV1", {
    orgName: ORG_NAME, industry: "telecom",
    ownerEmail: ADMIN_EMAIL, ownerName: "Capture-Gate Admin", timezone: "UTC",
  }, founderToken);
  if (create.body.ok !== true) throw new Error(`createOrgV1: ${JSON.stringify(create.body)}`);
  cleanup.orgId = create.body.orgId;
  cleanup.uids.add(create.body.ownerUid);

  // Confirm the seeded config doc landed
  const cfg = await db.doc(`orgs/${cleanup.orgId}/config/captureGate`).get();
  ok("createOrgV1 seeded config/captureGate doc",
    cfg.exists, `mode=${cfg.data()?.mode}`);
  ok("seeded mode is \"block\" by PR 135A default",
    cfg.data()?.mode === "block");

  // Invite field-role teammate
  const field = await callFn("inviteOrgMemberV1", {
    orgId: cleanup.orgId, email: FIELD_EMAIL, role: "field", displayName: "Capture-Gate Field",
  }, founderToken);
  if (field.body.ok !== true) throw new Error(`invite field: ${JSON.stringify(field.body)}`);
  cleanup.uids.add(field.body.uid);

  const adminToken = await mintToken(create.body.ownerUid);
  const fieldToken = await mintToken(field.body.uid);

  // Create an incident with under-captured evidence
  const incId = `cap_verify_${tag}_${Date.now()}`;
  cleanup.incidentIds.add(incId);
  let r = await callFn("createIncidentV1", {
    orgId: cleanup.orgId, actorUid: create.body.ownerUid, incidentId: incId,
    title: "Capture-gate verification", status: "open",
    archetype: "fiber_splice_verification",
    filingTypesRequired: ["DIRS"],
    location: "Test location", customer: "Test customer", priority: "normal",
    notes: "Intentionally under-evidenced for capture-gate verification.",
  }, adminToken);
  if (r.body.ok !== true) throw new Error(`createIncident: ${JSON.stringify(r.body)}`);

  r = await callFn("createJobV1", { orgId: cleanup.orgId, incidentId: incId, actorUid: create.body.ownerUid, title: "cap job" }, adminToken);
  const jobId = r.body.job?.jobId || r.body.jobId;

  r = await callFn("startFieldSessionV1", { orgId: cleanup.orgId, incidentId: incId, actorUid: field.body.uid, techUserId: field.body.uid }, fieldToken);
  const sessionId = r.body.sessionId;
  await callFn("markArrivedV1", { orgId: cleanup.orgId, incidentId: incId, sessionId, actorUid: field.body.uid, gps: { lat: 47.66, lng: -117.24, accuracyM: 6 } }, fieldToken);

  // Upload only 2 items — below template's minCount=4
  await uploadOneEvidence({ orgId: cleanup.orgId, incidentId: incId, sessionId, jobId, fileName: "w.png", label: "WIDE", fieldToken, actorUid: field.body.uid });
  await uploadOneEvidence({ orgId: cleanup.orgId, incidentId: incId, sessionId, jobId, fileName: "p.png", label: "PPE", fieldToken, actorUid: field.body.uid });

  // ─── submitFieldSessionV1 matrix ──────────────────────────────
  const subA = await callFn("submitFieldSessionV1", { orgId: cleanup.orgId, incidentId: incId, sessionId, actorUid: field.body.uid }, fieldToken);
  ok("submitFieldSessionV1 — field no-override → 412 capture_gate_blocked",
    subA.status === 412 && subA.body?.error === "capture_gate_blocked",
    `status=${subA.status} missing=${(subA.body?.missing || []).length}`);

  const subB = await callFn("submitFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incId, sessionId, actorUid: field.body.uid,
    acknowledgeCaptureGap: true, captureGapReason: "field role attempting bypass — should be denied",
  }, fieldToken);
  ok("submitFieldSessionV1 — field override → 403 override_role_required",
    subB.status === 403 && subB.body?.ackError === "override_role_required",
    `status=${subB.status} ack=${subB.body?.ackError}`);

  const subC = await callFn("submitFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incId, sessionId, actorUid: create.body.ownerUid,
    acknowledgeCaptureGap: true, captureGapReason: "short",
  }, adminToken);
  ok("submitFieldSessionV1 — admin short reason → 400 override_reason_invalid",
    subC.status === 400 && subC.body?.ackError === "override_reason_invalid",
    `status=${subC.status} ack=${subC.body?.ackError}`);

  const subD = await callFn("submitFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incId, sessionId, actorUid: create.body.ownerUid,
    acknowledgeCaptureGap: true, captureGapReason: "Capture-gate verification scenario — known incomplete by design.",
  }, adminToken);
  ok("submitFieldSessionV1 — admin valid override → 200",
    subD.status === 200 && subD.body?.ok === true,
    `status=${subD.status}`);

  // ─── markJobCompleteV1 matrix ─────────────────────────────────
  const cmpA = await callFn("markJobCompleteV1", { orgId: cleanup.orgId, incidentId: incId, jobId, actorUid: field.body.uid }, fieldToken);
  ok("markJobCompleteV1 — field no-override → 412 capture_gate_blocked",
    cmpA.status === 412 && cmpA.body?.error === "capture_gate_blocked",
    `status=${cmpA.status} missing=${(cmpA.body?.missing || []).length}`);

  const cmpB = await callFn("markJobCompleteV1", {
    orgId: cleanup.orgId, incidentId: incId, jobId, actorUid: field.body.uid,
    acknowledgeCaptureGap: true, captureGapReason: "field role attempting bypass — should be denied",
  }, fieldToken);
  ok("markJobCompleteV1 — field override → 403 override_role_required",
    cmpB.status === 403 && cmpB.body?.ackError === "override_role_required");

  const cmpC = await callFn("markJobCompleteV1", {
    orgId: cleanup.orgId, incidentId: incId, jobId, actorUid: create.body.ownerUid,
    acknowledgeCaptureGap: true, captureGapReason: "short",
  }, adminToken);
  ok("markJobCompleteV1 — admin short reason → 400 override_reason_invalid",
    cmpC.status === 400 && cmpC.body?.ackError === "override_reason_invalid");

  const cmpD = await callFn("markJobCompleteV1", {
    orgId: cleanup.orgId, incidentId: incId, jobId, actorUid: create.body.ownerUid,
    acknowledgeCaptureGap: true, captureGapReason: "Capture-gate verification scenario — known incomplete by design.",
  }, adminToken);
  ok("markJobCompleteV1 — admin valid override → 200",
    cmpD.status === 200 && cmpD.body?.ok === true);

  // ─── Audit verification ───────────────────────────────────────
  await new Promise(r => setTimeout(r, 1500));
  const auditSnap = await db.collection(`orgs/${cleanup.orgId}/audit`).where("incidentId", "==", incId).get();
  const types = auditSnap.docs.map(d => d.data().type);
  ok("audit subcollection has capture_gate_blocked rows",
    types.includes("capture_gate_blocked"), `types=[${[...new Set(types)].join(",")}]`);
  ok("audit subcollection has capture_gate_overridden rows",
    types.includes("capture_gate_overridden"));

} catch (e) {
  console.error(`\n  ✗ Verification aborted: ${e.message}`);
  failed++;
} finally {
  console.log(`\n── Cleanup ──`);
  try {
    for (const id of cleanup.incidentIds) {
      for (const sub of ["jobs", "evidence_locker", "timeline_events", "fieldSessions"]) {
        const snap = await db.collection(`incidents/${id}/${sub}`).get().catch(() => null);
        if (snap && !snap.empty) { const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit(); }
      }
      await db.doc(`incidents/${id}`).delete().catch(() => {});
      await db.doc(`orgs/${cleanup.orgId}/incidents/${id}`).delete().catch(() => {});
    }
    if (cleanup.orgId) {
      for (const sub of ["members", "audit", "templates", "billing", "config", "incidents"]) {
        const snap = await db.collection(`orgs/${cleanup.orgId}/${sub}`).get().catch(() => null);
        if (snap && !snap.empty) { const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit(); }
      }
      await db.doc(`orgs/${cleanup.orgId}`).delete().catch(() => {});
    }
    for (const uid of cleanup.uids) { try { await admin.auth().deleteUser(uid); } catch {} }
    for (const email of [ADMIN_EMAIL, FIELD_EMAIL]) {
      try { const u = await admin.auth().getUserByEmail(email); await admin.auth().deleteUser(u.uid); } catch {}
    }
    console.log(`  ✓ cleanup complete`);
  } catch (e) { console.warn(`  ⚠ cleanup partial: ${e?.message}`); }
}

console.log(`\n${"═".repeat(66)}`);
if (failed === 0) { console.log(`🟢 capture-gate live verification — all assertions pass`); process.exit(0); }
else { console.log(`🔴 capture-gate live verification — ${failed} failure(s)`); process.exit(1); }
