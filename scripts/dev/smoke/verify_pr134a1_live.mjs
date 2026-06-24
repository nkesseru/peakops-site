#!/usr/bin/env node
// PR 134A.1 live verification — exercises the deployed welcome-card
// data path on app.peakops.app with a fresh throwaway org.
//
// This script does NOT render the UI (no Playwright runner in this
// repo). It instead drives the data layer the WelcomeFirstRun
// component depends on, end-to-end, against the live Next.js route
// + the live Cloud Functions:
//
//   1. Provision a fresh org via createOrgV1 + 2 invites (mirrors
//      the Butler dry-run Phase 1 shape)
//   2. Mint an admin ID token for that org
//   3. GET https://app.peakops.app/api/onboarding-status?orgId=...
//   4. Assert the response payload matches what WelcomeFirstRun
//      expects (org name, starter template counts, teammate roster,
//      hasIncidents=false)
//   5. Negative path: foreign-org request → 403
//   6. Auto-hide path: createIncidentV1, re-call API,
//      assert hasIncidents=true (the card disappears at this point)
//   7. Cleanup (org + Auth users)

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const APP_URL = "https://app.peakops.app";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const FOUNDER_SMOKE_UID = "pr134a1-verify-founder";

const SA_PATH = "/Users/kesserumini/peakops/my-app/.secrets/sa.json";
const saJson = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(saJson), projectId: PROJECT });
const db = admin.firestore();

function getApiKey() {
  const out = execSync(`firebase apps:sdkconfig WEB 1:1006996232574:web:99de916d6cc57d3fac3b2f --project ${PROJECT}`, { encoding: "utf8" });
  return JSON.parse(out.match(/\{[\s\S]*\}/)[0]).apiKey;
}

async function mintToken(uid, claims = {}) {
  try { await admin.auth().getUser(uid); }
  catch { await admin.auth().createUser({ uid, disabled: false }); }
  const customToken = await admin.auth().createCustomToken(uid, claims);
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${getApiKey()}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(`token exchange: ${JSON.stringify(j).slice(0,200)}`);
  return j.idToken;
}

async function callFn(fn, body, idToken) {
  const r = await fetch(`${FN}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t; } })() };
}

async function callApi(path, idToken) {
  const r = await fetch(`${APP_URL}${path}`, {
    headers: { authorization: `Bearer ${idToken}` },
  });
  const t = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t; } })() };
}

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  🟢 ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  🔴 ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const tag = randomBytes(2).toString("hex");
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const ORG_NAME = `PR134A1 Verify ${tag}`;
const ADMIN_EMAIL = `pr134a1-admin-${tag}@verify.example.com`;
const SUP_EMAIL = `pr134a1-sup-${tag}@verify.example.com`;
const FIELD_EMAIL = `pr134a1-field-${tag}@verify.example.com`;

console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  PR 134A.1 — live verification`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  Target:  ${APP_URL}/api/onboarding-status`);
console.log(`  Tag:     ${tag}`);
console.log(`  Org:     ${ORG_NAME}`);
console.log(``);

const cleanup = { orgId: null, uids: new Set([FOUNDER_SMOKE_UID]), incidentIds: new Set() };

try {
  // ── Step 1: provision ──────────────────────────────────────────
  const founderToken = await mintToken(FOUNDER_SMOKE_UID, { peakopsInternalAdmin: true });
  const createRes = await callFn("createOrgV1", {
    orgName: ORG_NAME,
    industry: "telecom",
    ownerEmail: ADMIN_EMAIL,
    ownerName: "PR134A1 Admin",
    timezone: "America/New_York",
  }, founderToken);
  if (createRes.body.ok !== true) throw new Error(`createOrgV1: ${JSON.stringify(createRes.body)}`);
  cleanup.orgId = createRes.body.orgId;
  cleanup.uids.add(createRes.body.ownerUid);
  ok("Step 1 — provision: createOrgV1", true, `orgId=${cleanup.orgId}`);

  // ── Step 2: invite teammates ───────────────────────────────────
  const supRes = await callFn("inviteOrgMemberV1", { orgId: cleanup.orgId, email: SUP_EMAIL, role: "supervisor", displayName: "PR134A1 Sup" }, founderToken);
  if (supRes.body.ok !== true) throw new Error(`invite sup: ${JSON.stringify(supRes.body)}`);
  cleanup.uids.add(supRes.body.uid);
  const fieldRes = await callFn("inviteOrgMemberV1", { orgId: cleanup.orgId, email: FIELD_EMAIL, role: "field", displayName: "PR134A1 Field" }, founderToken);
  if (fieldRes.body.ok !== true) throw new Error(`invite field: ${JSON.stringify(fieldRes.body)}`);
  cleanup.uids.add(fieldRes.body.uid);
  ok("Step 2 — invited 2 teammates", true);

  // ── Step 3: mint admin token + call live API ───────────────────
  const adminToken = await mintToken(createRes.body.ownerUid);
  const apiRes = await callApi(`/api/onboarding-status?orgId=${encodeURIComponent(cleanup.orgId)}`, adminToken);
  ok("Step 3 — /api/onboarding-status responded 200", apiRes.status === 200, `status=${apiRes.status}`);
  ok("Step 3 — response.ok === true", apiRes.body.ok === true, JSON.stringify(apiRes.body).slice(0, 120));
  ok("Step 3 — orgName matches", apiRes.body.orgName === ORG_NAME, `got "${apiRes.body.orgName}"`);
  ok("Step 3 — industry === telecom", apiRes.body.industry === "telecom");
  ok("Step 3 — members.length === 3 (owner + 2 invites)", Array.isArray(apiRes.body.members) && apiRes.body.members.length === 3, `members.length=${apiRes.body.members?.length}`);
  ok("Step 3 — teammateCount === 2", apiRes.body.teammateCount === 2, `teammateCount=${apiRes.body.teammateCount}`);
  ok("Step 3 — starterTemplate present", apiRes.body.starterTemplate != null);
  ok("Step 3 — starterTemplate.requiredProofCount > 0", (apiRes.body.starterTemplate?.requiredProofCount || 0) > 0, `requiredProofCount=${apiRes.body.starterTemplate?.requiredProofCount}`);
  ok("Step 3 — starterTemplate.acceptanceCheckCount > 0", (apiRes.body.starterTemplate?.acceptanceCheckCount || 0) > 0, `acceptanceCheckCount=${apiRes.body.starterTemplate?.acceptanceCheckCount}`);
  ok("Step 3 — hasIncidents === false (welcome card SHOULD render)", apiRes.body.hasIncidents === false);

  // ── Step 4: negative cross-org access ──────────────────────────
  const foreignToken = await mintToken("pr134a1-verify-foreigner");
  cleanup.uids.add("pr134a1-verify-foreigner");
  const negRes = await callApi(`/api/onboarding-status?orgId=${encodeURIComponent(cleanup.orgId)}`, foreignToken);
  ok("Step 4 — cross-org access refused 403", negRes.status === 403, `status=${negRes.status} body=${JSON.stringify(negRes.body).slice(0,80)}`);

  // ── Step 5: auto-hide gate ─────────────────────────────────────
  const incidentId = `pr134a1_verify_${tag}_${stamp}`;
  cleanup.incidentIds.add(incidentId);
  const incRes = await callFn("createIncidentV1", {
    orgId: cleanup.orgId, actorUid: createRes.body.ownerUid, incidentId,
    title: "Verify auto-hide gate", status: "open", archetype: "fiber_splice_verification",
    filingTypesRequired: ["DIRS"], location: "Test location", customer: "Test customer", priority: "normal",
    notes: "Created to test welcome-card auto-hide gate.",
  }, adminToken);
  ok("Step 5a — created first incident", incRes.body.ok === true, JSON.stringify(incRes.body).slice(0, 120));

  // Brief pause so the Firestore consistency window covers the listIncidents read.
  await new Promise(r => setTimeout(r, 1500));
  const apiRes2 = await callApi(`/api/onboarding-status?orgId=${encodeURIComponent(cleanup.orgId)}`, adminToken);
  ok("Step 5b — hasIncidents flipped to true after first incident", apiRes2.body.hasIncidents === true, `hasIncidents=${apiRes2.body.hasIncidents}`);
  ok("Step 5c — welcome card would now auto-hide on /dashboard", apiRes2.body.hasIncidents === true);

} catch (e) {
  console.error(`\n  ✗ Verification aborted: ${e.message}`);
  failed++;
} finally {
  // ── Cleanup ────────────────────────────────────────────────────
  console.log(`\n── Cleanup ──`);
  try {
    for (const id of cleanup.incidentIds) {
      await db.doc(`orgs/${cleanup.orgId}/incidents/${id}`).delete().catch(() => {});
      await db.doc(`incidents/${id}`).delete().catch(() => {});
    }
    if (cleanup.orgId) {
      for (const sub of ["members", "audit", "templates", "billing", "config", "incidents"]) {
        const snap = await db.collection(`orgs/${cleanup.orgId}/${sub}`).get().catch(() => null);
        if (snap && !snap.empty) {
          const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit();
        }
      }
      await db.doc(`orgs/${cleanup.orgId}`).delete().catch(() => {});
    }
    for (const uid of cleanup.uids) {
      try { await admin.auth().deleteUser(uid); } catch {}
    }
    for (const email of [ADMIN_EMAIL, SUP_EMAIL, FIELD_EMAIL]) {
      try { const u = await admin.auth().getUserByEmail(email); await admin.auth().deleteUser(u.uid); } catch {}
    }
    console.log(`  ✓ cleanup complete`);
  } catch (e) { console.warn(`  ⚠ cleanup partial: ${e?.message}`); }
}

console.log(`\n${"═".repeat(66)}`);
if (failed === 0) {
  console.log(`🟢 PR 134A.1 live verification — all assertions pass`);
  process.exit(0);
} else {
  console.log(`🔴 PR 134A.1 live verification — ${failed} failure(s)`);
  process.exit(1);
}
