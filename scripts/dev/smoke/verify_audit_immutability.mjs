#!/usr/bin/env node
// PEAKOPS_AUDIT_IMMUTABILITY_V1 (2026-06-24) — live verification.
//
// Drives the deployed firestore.rules audit-immutability rule against
// real audit docs in production by:
//
//   1. Provisioning a throwaway org via createOrgV1 (Admin SDK,
//      bypasses rules — confirms server-side writes still work).
//      createOrgV1 itself writes a row to orgs/{orgId}/audit during
//      its atomic batch, so we have a real audit doc to mutate.
//   2. Minting a USER ID token for the org's admin (NOT a service
//      account). This is the same auth surface a browser client uses.
//   3. Hitting the Firestore REST API with the user's Bearer token,
//      mimicking what a malicious admin acting from the client side
//      could attempt.
//   4. Asserting PATCH (update), DELETE, and POST (create) all
//      return 403 PERMISSION_DENIED.
//   5. Confirming server-side create still works (the row created
//      by createOrgV1 demonstrates this).

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const FOUNDER_SMOKE_UID = "audit-immutability-verify-founder";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const saJson = JSON.parse(fs.readFileSync("/Users/kesserumini/peakops/my-app/.secrets/sa.json", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(saJson), projectId: PROJECT });
const db = admin.firestore();

function getApiKey() {
  const out = execSync(`firebase apps:sdkconfig WEB 1:1006996232574:web:99de916d6cc57d3fac3b2f --project ${PROJECT}`, { encoding: "utf8" });
  return JSON.parse(out.match(/\{[\s\S]*\}/)[0]).apiKey;
}

async function mintUserIdToken(uid, claims = {}) {
  try { await admin.auth().getUser(uid); } catch { await admin.auth().createUser({ uid, disabled: false }); }
  const customToken = await admin.auth().createCustomToken(uid, claims);
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${getApiKey()}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(`token: ${JSON.stringify(j).slice(0, 200)}`);
  return j.idToken;
}

async function callFn(fn, body, idToken) {
  const r = await fetch(`${FN}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Firestore REST helpers — these talk to the SAME endpoint a JS
// client SDK would hit, with the SAME bearer token. Rules apply.
async function clientUpdateAuditDoc(orgId, auditId, idToken) {
  const url = `${FIRESTORE_REST_BASE}/orgs/${orgId}/audit/${auditId}?updateMask.fieldPaths=tamperedBy`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      fields: { tamperedBy: { stringValue: "rogue-admin-client" } },
    }),
  });
  return { status: r.status, body: await r.text() };
}

async function clientDeleteAuditDoc(orgId, auditId, idToken) {
  const url = `${FIRESTORE_REST_BASE}/orgs/${orgId}/audit/${auditId}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${idToken}` },
  });
  return { status: r.status, body: await r.text() };
}

async function clientCreateAuditDoc(orgId, idToken) {
  const id = `client_forged_${Date.now()}`;
  const url = `${FIRESTORE_REST_BASE}/orgs/${orgId}/audit?documentId=${id}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      fields: {
        id: { stringValue: id },
        type: { stringValue: "FORGED_BY_CLIENT" },
        forgedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  return { status: r.status, body: await r.text() };
}

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  🟢 ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  🔴 ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const tag = randomBytes(2).toString("hex");
const ORG_NAME = `Audit Immutability Verify ${tag}`;
const ADMIN_EMAIL = `audit-verify-admin-${tag}@verify.example.com`;
const cleanup = { orgId: null, uids: new Set([FOUNDER_SMOKE_UID]) };

console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  PEAKOPS_AUDIT_IMMUTABILITY_V1 — live verification`);
console.log(`  Target: ${FIRESTORE_REST_BASE.replace("https://", "")}`);
console.log(`══════════════════════════════════════════════════════════════════\n`);

try {
  // ── Step 1: server-side provision (Admin SDK bypasses rules) ──
  const founderToken = await mintUserIdToken(FOUNDER_SMOKE_UID, { peakopsInternalAdmin: true });
  const create = await callFn("createOrgV1", {
    orgName: ORG_NAME, industry: "telecom",
    ownerEmail: ADMIN_EMAIL, ownerName: "Audit Verify Admin", timezone: "UTC",
  }, founderToken);
  if (create.body.ok !== true) throw new Error(`createOrgV1: ${JSON.stringify(create.body)}`);
  cleanup.orgId = create.body.orgId;
  cleanup.uids.add(create.body.ownerUid);
  ok("Step 1 — Admin SDK still creates audit rows (server-side bypasses rules)",
    true, `orgId=${cleanup.orgId}`);

  // ── Step 2: confirm the createOrgV1 audit row landed ──────────
  const auditSnap = await db.collection(`orgs/${cleanup.orgId}/audit`).limit(5).get();
  ok("Step 2 — createOrgV1 wrote an audit row server-side",
    !auditSnap.empty, `${auditSnap.size} audit doc(s) present`);
  if (auditSnap.empty) throw new Error("no audit docs to mutate");
  const targetAuditId = auditSnap.docs[0].id;
  const targetType = auditSnap.docs[0].data().type || "(unknown)";
  console.log(`     target audit doc: orgs/${cleanup.orgId}/audit/${targetAuditId} (type=${targetType})`);

  // ── Step 3: mint user ID token (NOT a service account) ────────
  const adminUserToken = await mintUserIdToken(create.body.ownerUid);
  ok("Step 3 — minted user ID token for the org's admin (client-equivalent auth)", true);

  // ── Step 4: client-side UPDATE attempt → expect 403 ───────────
  const upd = await clientUpdateAuditDoc(cleanup.orgId, targetAuditId, adminUserToken);
  const updMsg = String(upd.body).match(/"message":\s*"([^"]+)"/)?.[1] || upd.body.slice(0, 120);
  ok("Step 4 — client PATCH on existing audit doc → 403 PERMISSION_DENIED",
    upd.status === 403, `status=${upd.status} message="${updMsg}"`);

  // ── Step 5: client-side DELETE attempt → expect 403 ───────────
  const del = await clientDeleteAuditDoc(cleanup.orgId, targetAuditId, adminUserToken);
  const delMsg = String(del.body).match(/"message":\s*"([^"]+)"/)?.[1] || del.body.slice(0, 120);
  ok("Step 5 — client DELETE on existing audit doc → 403 PERMISSION_DENIED",
    del.status === 403, `status=${del.status} message="${delMsg}"`);

  // ── Step 6: client-side CREATE attempt → expect 403 ───────────
  const cre = await clientCreateAuditDoc(cleanup.orgId, adminUserToken);
  const creMsg = String(cre.body).match(/"message":\s*"([^"]+)"/)?.[1] || cre.body.slice(0, 120);
  ok("Step 6 — client POST (create) on audit subcollection → 403 PERMISSION_DENIED",
    cre.status === 403, `status=${cre.status} message="${creMsg}"`);

  // ── Step 7: confirm target doc still exists (DELETE didn't sneak through) ──
  const reSnap = await db.doc(`orgs/${cleanup.orgId}/audit/${targetAuditId}`).get();
  ok("Step 7 — target audit doc is still present (DELETE was actually denied, not silently honored)",
    reSnap.exists);

  // ── Step 8: confirm target doc was not mutated ────────────────
  const targetData = reSnap.data() || {};
  ok("Step 8 — target audit doc has no tamperedBy field (UPDATE was actually denied)",
    targetData.tamperedBy === undefined,
    targetData.tamperedBy ? `LEAKED: tamperedBy=${targetData.tamperedBy}` : `(field absent)`);

} catch (e) {
  console.error(`\n  ✗ Verification aborted: ${e.message}`);
  failed++;
} finally {
  console.log(`\n── Cleanup ──`);
  try {
    if (cleanup.orgId) {
      for (const sub of ["members", "audit", "templates", "billing", "config", "customer_review_audit", "recovery_audit"]) {
        const snap = await db.collection(`orgs/${cleanup.orgId}/${sub}`).get().catch(() => null);
        if (snap && !snap.empty) { const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit(); }
      }
      await db.doc(`orgs/${cleanup.orgId}`).delete().catch(() => {});
    }
    for (const uid of cleanup.uids) { try { await admin.auth().deleteUser(uid); } catch {} }
    try { const u = await admin.auth().getUserByEmail(ADMIN_EMAIL); await admin.auth().deleteUser(u.uid); } catch {}
    console.log(`  ✓ cleanup complete`);
  } catch (e) { console.warn(`  ⚠ cleanup partial: ${e?.message}`); }
}

console.log(`\n${"═".repeat(66)}`);
if (failed === 0) { console.log(`🟢 audit-immutability live verification — all assertions pass`); process.exit(0); }
else { console.log(`🔴 audit-immutability live verification — ${failed} failure(s)`); process.exit(1); }
