#!/usr/bin/env node
// PR 134A.2 live verification — confirms /api/onboarding-status now
// surfaces the script-activation signals (bootstrappedBy,
// bootstrappedAt, scriptActivated) that OnboardingClient depends on
// to render OnboardingActivatedNotice instead of the 7-step wizard.
//
// Does NOT render pixels. Runs the API contract against
// https://app.peakops.app and confirms the new fields are present
// and correctly derived for a fresh CS-activated org.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const APP_URL = "https://app.peakops.app";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const FOUNDER_SMOKE_UID = "pr134a2-verify-founder";

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
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.idToken;
}

async function callFn(fn, body, idToken) {
  const r = await fetch(`${FN}/${fn}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  🟢 ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  🔴 ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const tag = randomBytes(2).toString("hex");
const ORG_NAME = `PR134A2 Verify ${tag}`;
const cleanup = { orgId: null, uids: new Set([FOUNDER_SMOKE_UID]) };

console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  PR 134A.2 — live verification (script-activation detection)`);
console.log(`  Target: ${APP_URL}/api/onboarding-status`);
console.log(`══════════════════════════════════════════════════════════════════\n`);

try {
  const founderToken = await mintToken(FOUNDER_SMOKE_UID, { peakopsInternalAdmin: true });
  const create = await callFn("createOrgV1", {
    orgName: ORG_NAME, industry: "telecom",
    ownerEmail: `pr134a2-admin-${tag}@verify.example.com`,
    ownerName: "PR134A2 Admin", timezone: "America/New_York",
  }, founderToken);
  if (create.body.ok !== true) throw new Error(`createOrgV1: ${JSON.stringify(create.body)}`);
  cleanup.orgId = create.body.orgId;
  cleanup.uids.add(create.body.ownerUid);

  const adminToken = await mintToken(create.body.ownerUid);
  const apiRes = await fetch(`${APP_URL}/api/onboarding-status?orgId=${encodeURIComponent(cleanup.orgId)}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const json = await apiRes.json();

  ok("status === 200", apiRes.status === 200, `status=${apiRes.status}`);
  ok("response.ok === true", json.ok === true);
  ok("kind === \"customer\"", json.kind === "customer", `kind=${json.kind}`);
  ok("bootstrappedBy populated", typeof json.bootstrappedBy === "string" && json.bootstrappedBy.length > 0, `bootstrappedBy=${json.bootstrappedBy?.slice(0, 24)}`);
  ok("bootstrappedAt present (ISO timestamp)", typeof json.bootstrappedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(json.bootstrappedAt), `bootstrappedAt=${json.bootstrappedAt}`);
  ok("scriptActivated === true", json.scriptActivated === true, `scriptActivated=${json.scriptActivated}`);
  ok("starterTemplate present (activation conjunction needs it)", json.starterTemplate != null);
  ok("OnboardingClient would render OnboardingActivatedNotice for this org",
    json.scriptActivated === true && json.starterTemplate && json.kind === "customer");
} catch (e) {
  console.error(`\n  ✗ Verification aborted: ${e.message}`);
  failed++;
} finally {
  console.log(`\n── Cleanup ──`);
  try {
    if (cleanup.orgId) {
      for (const sub of ["members", "audit", "templates", "billing", "config"]) {
        const snap = await db.collection(`orgs/${cleanup.orgId}/${sub}`).get().catch(() => null);
        if (snap && !snap.empty) { const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit(); }
      }
      await db.doc(`orgs/${cleanup.orgId}`).delete().catch(() => {});
    }
    for (const uid of cleanup.uids) { try { await admin.auth().deleteUser(uid); } catch {} }
    try { const u = await admin.auth().getUserByEmail(`pr134a2-admin-${tag}@verify.example.com`); await admin.auth().deleteUser(u.uid); } catch {}
    console.log(`  ✓ cleanup complete`);
  } catch (e) { console.warn(`  ⚠ cleanup partial: ${e?.message}`); }
}

console.log(`\n${"═".repeat(66)}`);
if (failed === 0) { console.log(`🟢 PR 134A.2 live verification — all assertions pass`); process.exit(0); }
else { console.log(`🔴 PR 134A.2 live verification — ${failed} failure(s)`); process.exit(1); }
