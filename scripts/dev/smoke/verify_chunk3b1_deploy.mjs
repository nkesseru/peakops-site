#!/usr/bin/env node
// Chunk 3B-1 post-deploy smoke. Pulls the Firebase Web API key at
// runtime via `firebase apps:sdkconfig` so the key is not embedded
// in source. Mints a Firebase ID token with peakopsInternalAdmin via
// service-account custom-token + Identity Toolkit exchange, then
// drives createOrgV1 + inviteOrgMemberV1 + cleanup.

import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const SMOKE_UID = "chunk3b1-smoke-runner";

const SA_PATH = "/Users/kesserumini/peakops/my-app/.secrets/sa.json";
const saJson = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(saJson), projectId: PROJECT });
const db = admin.firestore();

// Pull API key at runtime from Firebase CLI — keeps it out of source.
function getApiKey() {
  // Use the first WEB app on the project. firebase apps:sdkconfig returns
  // a JSON-ish blob with an apiKey field.
  const appId = "1:1006996232574:web:99de916d6cc57d3fac3b2f"; // PeakOps-app
  const out = execSync(`firebase apps:sdkconfig WEB ${appId} --project ${PROJECT}`, { encoding: "utf8" });
  // Strip the leading status lines + extract the JSON object.
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("could not parse firebase apps:sdkconfig output");
  return JSON.parse(m[0]).apiKey;
}

const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const tag = randomBytes(2).toString("hex");
const SMOKE_ORG_NAME = `Chunk 3B-1 Smoke Co ${stamp}-${tag}`;
const expectedOrgId = SMOKE_ORG_NAME.toLowerCase()
  .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  .replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
const ADMIN_EMAIL = `chunk3b1-smoke-admin-${tag}@peakops-test.example.com`;
const TEAMMATE_EMAIL = `chunk3b1-smoke-field-${tag}@peakops-test.example.com`;

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

async function mintIdToken(apiKey) {
  console.log("\n── Minting ID token with peakopsInternalAdmin claim ──");
  try { await admin.auth().getUser(SMOKE_UID); }
  catch { await admin.auth().createUser({ uid: SMOKE_UID, disabled: false }); }
  const customToken = await admin.auth().createCustomToken(SMOKE_UID, {
    peakopsInternalAdmin: true,
  });
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(`token exchange failed: ${JSON.stringify(j).slice(0, 200)}`);
  console.log(`  ✓ ID token minted (${j.idToken.length} chars)`);
  return j.idToken;
}

async function callFn(fn, body, idToken) {
  const r = await fetch(`${FN_BASE}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  return { status: r.status, body: parsed || text };
}

async function cleanup({ orgId, adminUid, teammateUid }) {
  console.log("\n── Cleanup ──");
  try {
    for (const s of ["members", "audit"]) {
      const snap = await db.collection(`orgs/${orgId}/${s}`).get();
      const batch = db.batch();
      snap.forEach((d) => batch.delete(d.ref));
      if (snap.size) await batch.commit();
    }
    await db.doc(`orgs/${orgId}`).delete().catch(() => {});
    console.log(`  ✓ Firestore: deleted orgs/${orgId} + subs`);
  } catch (e) { console.log(`  ⚠ Firestore cleanup: ${e?.message}`); }
  for (const uid of [adminUid, teammateUid, SMOKE_UID].filter(Boolean)) {
    try { await admin.auth().deleteUser(uid); console.log(`  ✓ Auth: deleted ${uid}`); }
    catch (e) { console.log(`  ⚠ Auth delete ${uid}: ${e?.message}`); }
  }
}

let createResult = null;
let inviteResult = null;

try {
  const apiKey = getApiKey();
  const idToken = await mintIdToken(apiKey);

  console.log("\n══ Step 1: createOrgV1 ═════════════════════════════");
  createResult = await callFn("createOrgV1", {
    orgName: SMOKE_ORG_NAME, industry: "telecom",
    ownerEmail: ADMIN_EMAIL, ownerName: "Smoke Admin",
    timezone: "America/Los_Angeles",
  }, idToken);
  console.log(`  HTTP ${createResult.status} · body keys: [${Object.keys(createResult.body || {}).join(", ")}]`);
  if (createResult.status === 200 && createResult.body.ok) pass("createOrgV1 ok:true");
  else fail(`createOrgV1: HTTP ${createResult.status}`);
  if (createResult.body.orgId === expectedOrgId) pass(`orgId = ${expectedOrgId}`);
  else fail(`orgId mismatch: ${createResult.body.orgId}`);
  if (createResult.body.ownerUid) pass("ownerUid returned");
  else fail("no ownerUid");
  if (createResult.body.firstLoginUrl && createResult.body.firstLoginUrl.includes("oobCode")) pass("firstLoginUrl populated with oobCode");
  else fail(`firstLoginUrl missing/malformed: ${createResult.body.firstLoginUrl}`);
  if (createResult.body.authUserCreated === true) pass("authUserCreated:true");
  else fail(`authUserCreated should be true — got ${createResult.body.authUserCreated}`);

  await new Promise(r => setTimeout(r, 1000));
  const orgSnap = await db.doc(`orgs/${expectedOrgId}`).get();
  if (orgSnap.exists) pass(`Firestore: orgs/${expectedOrgId}`);
  else fail(`Firestore org missing`);
  const orgData = orgSnap.data() || {};
  if (orgData.kind === "customer" && orgData.status === "active") pass("org kind=customer status=active");
  else fail(`org fields wrong: ${JSON.stringify(orgData).slice(0,100)}`);
  const memberSnap = await db.doc(`orgs/${expectedOrgId}/members/${createResult.body.ownerUid}`).get();
  if (memberSnap.exists && memberSnap.data().role === "owner") pass("owner member role=owner");
  else fail("owner member missing/wrong");

  const adminUser = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const claims = adminUser.customClaims || {};
  if (Array.isArray(claims.orgIds) && claims.orgIds.includes(expectedOrgId)) pass("claims.orgIds contains org");
  else fail(`claims.orgIds: ${JSON.stringify(claims.orgIds)}`);
  if (claims.role === "owner") pass("claims.role=owner");
  else fail(`claims.role=${claims.role}`);

  console.log("\n══ Step 2: idempotency ═════════════════════════════");
  const r2 = await callFn("createOrgV1", { orgName: SMOKE_ORG_NAME, industry: "telecom", ownerEmail: ADMIN_EMAIL }, idToken);
  if (r2.status === 200 && r2.body.already === true) pass("re-call returns already:true");
  else fail(`re-call: already=${r2.body.already}`);

  console.log("\n══ Step 3: inviteOrgMemberV1 ═══════════════════════");
  inviteResult = await callFn("inviteOrgMemberV1", {
    orgId: expectedOrgId, email: TEAMMATE_EMAIL, role: "field",
  }, idToken);
  console.log(`  HTTP ${inviteResult.status} · body keys: [${Object.keys(inviteResult.body || {}).join(", ")}]`);
  if (inviteResult.status === 200 && inviteResult.body.ok) pass("inviteOrgMemberV1 ok:true");
  else fail(`inviteOrgMemberV1: HTTP ${inviteResult.status}`);
  if (inviteResult.body.magicLink && inviteResult.body.magicLink.includes("oobCode")) pass("magicLink populated with oobCode");
  else fail(`magicLink missing/malformed: ${inviteResult.body.magicLink}`);

  await new Promise(r => setTimeout(r, 1000));
  const teammateMember = await db.doc(`orgs/${expectedOrgId}/members/${inviteResult.body.uid}`).get();
  if (teammateMember.exists && teammateMember.data().role === "field") pass("teammate member role=field");
  else fail("teammate member missing/wrong");
  const teammateUser = await admin.auth().getUser(inviteResult.body.uid);
  const teammateClaims = teammateUser.customClaims || {};
  if (Array.isArray(teammateClaims.orgIds) && teammateClaims.orgIds.includes(expectedOrgId)) pass("teammate orgIds contains org");
  else fail("teammate orgIds missing org");

  console.log("\n══ Step 4: invite idempotency ══════════════════════");
  const r4 = await callFn("inviteOrgMemberV1", { orgId: expectedOrgId, email: TEAMMATE_EMAIL, role: "field" }, idToken);
  if (r4.body.already === true) pass("re-invite already:true");
  else fail(`re-invite already=${r4.body.already}`);

} catch (e) {
  fail(`uncaught: ${e?.stack || e?.message || e}`);
} finally {
  await cleanup({ orgId: expectedOrgId, adminUid: createResult?.body?.ownerUid, teammateUid: inviteResult?.body?.uid });
}

console.log("\n" + "═".repeat(60));
if (failed === 0) console.log("🟢 ALL CHUNK 3B-1 POST-DEPLOY ASSERTIONS PASS (15/15)");
else console.log(`🔴 ${failed} failure(s)`);
process.exit(failed > 0 ? 1 : 0);
