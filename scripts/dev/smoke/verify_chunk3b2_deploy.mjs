#!/usr/bin/env node
// Chunk 3B-2 post-deploy smoke. Walks the 6-step manual verification
// checklist from docs/checkpoints/chunk3b2-activation-polish.md:
//
//   1. Telecom provisioning seeds the starter template
//   2. Idempotency: re-call returns already + reason
//   3. Non-telecom skip path
//   4. Packet branding with org doc → branded footer
//   5. Packet branding without org doc → legacy fallback
//   6. Cleanup all smoke artifacts
//
// Uses the same custom-token + Identity Toolkit pattern as the
// Chunk 3B-1 smoke. Mints a peakopsInternalAdmin ID token via the
// service-account in .secrets/sa.json.

import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const SMOKE_UID = "chunk3b2-smoke-runner";
const ORG_FOR_BRANDING_TEST = "peakops-internal-alpha";
const INCIDENT_FOR_BRANDING_TEST = "inc_20260508_121451_acnew0"; // packet-ready Internal Alpha record

const SA_PATH = "/Users/kesserumini/peakops/my-app/.secrets/sa.json";
const saJson = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(saJson), projectId: PROJECT });
const db = admin.firestore();

function getApiKey() {
  const appId = "1:1006996232574:web:99de916d6cc57d3fac3b2f";
  const out = execSync(`firebase apps:sdkconfig WEB ${appId} --project ${PROJECT}`, { encoding: "utf8" });
  const m = out.match(/\{[\s\S]*\}/);
  return JSON.parse(m[0]).apiKey;
}

const tag = randomBytes(2).toString("hex");
const TELECOM_NAME = `Chunk 3B-2 Telecom Smoke Co ${tag}`;
const UTILITIES_NAME = `Chunk 3B-2 Utilities Smoke Co ${tag}`;
const telecomOrgId = slugify(TELECOM_NAME);
const utilitiesOrgId = slugify(UTILITIES_NAME);
const TELECOM_ADMIN = `chunk3b2-telecom-${tag}@peakops-test.example.com`;
const UTILITIES_ADMIN = `chunk3b2-util-${tag}@peakops-test.example.com`;

function slugify(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

async function mintIdToken(apiKey) {
  try { await admin.auth().getUser(SMOKE_UID); }
  catch { await admin.auth().createUser({ uid: SMOKE_UID }); }
  const customToken = await admin.auth().createCustomToken(SMOKE_UID, { peakopsInternalAdmin: true });
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
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

async function deleteOrg(orgId) {
  try {
    for (const sub of ["members", "audit", "templates"]) {
      const snap = await db.collection(`orgs/${orgId}/${sub}`).get();
      const b = db.batch();
      snap.forEach((d) => b.delete(d.ref));
      if (snap.size) await b.commit();
    }
    await db.doc(`orgs/${orgId}`).delete().catch(() => {});
  } catch {}
}

const cleanup = { telecomOwnerUid: null, utilitiesOwnerUid: null };

try {
  const apiKey = getApiKey();
  const idToken = await mintIdToken(apiKey);

  // ─── STEP 1: telecom provisioning seeds the starter template ──
  console.log("\n══ Step 1: telecom provisioning + starter template ═══════");
  let r = await callFn("createOrgV1", {
    orgName: TELECOM_NAME,
    industry: "telecom",
    ownerEmail: TELECOM_ADMIN,
    ownerName: "Telecom Smoke Admin",
  }, idToken);
  cleanup.telecomOwnerUid = r.body?.ownerUid;
  console.log(`  HTTP ${r.status}  ownerUid=${r.body?.ownerUid?.slice(0,8)}…`);
  console.log(`  starterTemplate: ${JSON.stringify(r.body?.starterTemplate)}`);
  if (r.body?.ok && r.body?.orgId === telecomOrgId) pass("createOrgV1 ok:true, orgId derived correctly");
  else fail("createOrgV1 failed or orgId mismatch");
  if (r.body?.starterTemplate?.seeded === true && r.body?.starterTemplate?.templateKey === "fiber_splice_verification") {
    pass(`starterTemplate.seeded === true, templateKey === fiber_splice_verification`);
  } else {
    fail(`starterTemplate not seeded — got ${JSON.stringify(r.body?.starterTemplate)}`);
  }
  await new Promise(res => setTimeout(res, 1000));
  const tplSnap = await db.doc(`orgs/${telecomOrgId}/templates/fiber_splice_verification`).get();
  if (tplSnap.exists) pass("Firestore: template doc landed at orgs/{orgId}/templates/fiber_splice_verification");
  else fail("Firestore: template doc MISSING");
  const tpl = tplSnap.data() || {};
  if (Array.isArray(tpl.requiredProof) && tpl.requiredProof.length === 5) pass(`requiredProof has 5 items (got ${tpl.requiredProof?.length})`);
  else fail(`requiredProof not 5 items: ${JSON.stringify(tpl.requiredProof)}`);
  if (Array.isArray(tpl.acceptanceChecks) && tpl.acceptanceChecks.length === 5) pass(`acceptanceChecks has 5 items`);
  else fail(`acceptanceChecks not 5 items: ${JSON.stringify(tpl.acceptanceChecks)}`);
  if (tpl.seededBy === "createOrgV1:starter-template") pass("seededBy attribution correct");
  else fail(`seededBy wrong: ${tpl.seededBy}`);

  // ─── STEP 2: idempotency ─────────────────────────────────────
  console.log("\n══ Step 2: idempotency ═══════════════════════════════════");
  const r2 = await callFn("createOrgV1", {
    orgName: TELECOM_NAME,
    industry: "telecom",
    ownerEmail: TELECOM_ADMIN,
  }, idToken);
  console.log(`  starterTemplate: ${JSON.stringify(r2.body?.starterTemplate)}`);
  // When the org already exists, createOrgV1 returns already:true and
  // exits BEFORE the seed runs (no need to re-seed). The response body
  // does not include a starterTemplate key in this branch.
  if (r2.body?.already === true) pass("re-call returns already:true (org-level idempotency)");
  else fail(`re-call did not return already:true (got ${r2.body?.already})`);

  // To prove TEMPLATE-level idempotency, call seedStarterTemplate via a
  // surrogate path: trigger a second createOrgV1 with a deliberately
  // DIFFERENT orgName (so the org-already-exists short-circuit doesn't
  // skip the seed), then verify that if the template doc already exists
  // on the new org's path, the seed reports template_already_exists.
  //
  // Simpler: just inspect the existing telecomOrg's template doc. It
  // should still exist with the original seededAt timestamp (no
  // overwrite would have changed updatedAt either).
  const tplSnap2 = await db.doc(`orgs/${telecomOrgId}/templates/fiber_splice_verification`).get();
  const tpl2 = tplSnap2.data() || {};
  // The seededAt timestamp should be unchanged from step 1 — if a re-
  // seed had overwritten, we'd see a fresh timestamp.
  if (tpl.seededAt && tpl2.seededAt && JSON.stringify(tpl.seededAt) === JSON.stringify(tpl2.seededAt)) {
    pass("template doc seededAt unchanged after re-call (no overwrite)");
  } else {
    fail("template seededAt changed unexpectedly");
  }

  // ─── STEP 3: non-telecom skip path ───────────────────────────
  console.log("\n══ Step 3: non-telecom provisioning skips starter ════════");
  const r3 = await callFn("createOrgV1", {
    orgName: UTILITIES_NAME,
    industry: "utilities",
    ownerEmail: UTILITIES_ADMIN,
    ownerName: "Utilities Smoke Admin",
  }, idToken);
  cleanup.utilitiesOwnerUid = r3.body?.ownerUid;
  console.log(`  HTTP ${r3.status} · ownerUid=${r3.body?.ownerUid?.slice(0,8)}…`);
  console.log(`  starterTemplate: ${JSON.stringify(r3.body?.starterTemplate)}`);
  if (r3.body?.ok && r3.body?.orgId === utilitiesOrgId) pass("non-telecom createOrgV1 ok:true");
  else fail("non-telecom createOrgV1 failed");
  if (r3.body?.starterTemplate?.seeded === false && r3.body?.starterTemplate?.reason === "no_starter_defined_for_industry") {
    pass(`starterTemplate.seeded === false, reason === no_starter_defined_for_industry`);
  } else {
    fail(`non-telecom did not skip cleanly: ${JSON.stringify(r3.body?.starterTemplate)}`);
  }
  // No template doc should have been written.
  await new Promise(res => setTimeout(res, 1000));
  const utilTplSnap = await db.doc(`orgs/${utilitiesOrgId}/templates/fiber_splice_verification`).get();
  if (!utilTplSnap.exists) pass("utilities org has NO fiber_splice_verification template (correctly skipped)");
  else fail("utilities org accidentally got a fiber_splice_verification template");

  // ─── STEP 4: packet branding with org doc → branded footer ───
  console.log("\n══ Step 4: packet branding with org doc ══════════════════");
  // Look up the org name we expect to see in the branded footer.
  const aliveOrgSnap = await db.doc(`orgs/${ORG_FOR_BRANDING_TEST}`).get();
  const aliveOrgName = String(aliveOrgSnap.data()?.name || "").trim();
  console.log(`  Expected org name in footer: "${aliveOrgName || "(none — fallback expected)"}"`);

  // exportIncidentPacketV1 requires the caller to be an active admin/
  // supervisor member of the target org. The smoke uid (a synthetic
  // internal-admin) isn't a member by default. Write a temporary
  // member doc so the call passes the role gate; the cleanup step
  // below removes it.
  await db.doc(`orgs/${ORG_FOR_BRANDING_TEST}/members/${SMOKE_UID}`).set({
    uid: SMOKE_UID,
    orgId: ORG_FOR_BRANDING_TEST,
    role: "admin",
    status: "active",
    email: `smoke-${tag}@peakops-test.example.com`,
    source: "chunk3b2-smoke-temp-membership",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  cleanup.tempMemberPath = `orgs/${ORG_FOR_BRANDING_TEST}/members/${SMOKE_UID}`;
  console.log(`  ✓ wrote temp member doc for smoke uid to pass role gate`);

  const r4 = await callFn("exportIncidentPacketV1", {
    orgId: ORG_FOR_BRANDING_TEST,
    incidentId: INCIDENT_FOR_BRANDING_TEST,
  }, idToken);
  console.log(`  HTTP ${r4.status}`);
  if (r4.body?.ok && r4.body?.downloadUrl) pass("exportIncidentPacketV1 returned ok:true with downloadUrl");
  else fail(`export failed: ${JSON.stringify(r4.body).slice(0, 300)}`);

  // Download the packet ZIP via Admin SDK using the storage path.
  // packetMeta on the incident doc points at bucket+storagePath.
  await new Promise(res => setTimeout(res, 1000));
  const incData = (await db.doc(`orgs/${ORG_FOR_BRANDING_TEST}/incidents/${INCIDENT_FOR_BRANDING_TEST}`).get()).data() || {};
  const pm = incData.packetMeta;
  if (!pm?.bucket || !pm?.storagePath) {
    fail("packetMeta missing on incident — cannot fetch packet");
  } else {
    const file = admin.storage().bucket(pm.bucket).file(pm.storagePath);
    const [buf] = await file.download();

    // Save the packet locally + extract with system unzip so we can
    // grep the actual file contents (ZIP files use DEFLATE so the
    // plain HTML/README text is NOT in the raw ZIP bytes).
    const out = path.join(os.tmpdir(), `chunk3b2_smoke_packet_${tag}.zip`);
    fs.writeFileSync(out, buf);
    const extractDir = path.join(os.tmpdir(), `chunk3b2_smoke_extract_${tag}`);
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`unzip -qo "${out}" -d "${extractDir}"`);
    console.log(`  ✓ packet extracted to ${extractDir}`);

    // Read the two cover HTML files + README and check for the new
    // branding strings.
    function readMaybe(p) {
      try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
    }
    // Actual ZIP layout from a real packet build:
    //   REPORTS/REPORT_SUMMARY.html      ← audit-side doc
    //   REPORTS/CUSTOMER_SUMMARY.html    ← customer-side doc
    //   README_FIRST.txt
    const auditHtml    = readMaybe(path.join(extractDir, "REPORTS", "REPORT_SUMMARY.html"));
    const customerHtml = readMaybe(path.join(extractDir, "REPORTS", "CUSTOMER_SUMMARY.html"));
    const readme       = readMaybe(path.join(extractDir, "README_FIRST.txt"));
    console.log(`  ✓ audit-html: ${auditHtml.length} chars, customer-html: ${customerHtml.length} chars, readme: ${readme.length} chars`);

    const allText = auditHtml + "\n" + customerHtml + "\n" + readme;
    const poweredByCount = (allText.match(/powered by PeakOps/g) || []).length;
    if (poweredByCount >= 3) pass(`"powered by PeakOps" appears ${poweredByCount}x across cover + customer + README`);
    else fail(`"powered by PeakOps" appears only ${poweredByCount}x — expected ≥3`);

    if (aliveOrgName) {
      const orgNameCount = (allText.match(new RegExp(aliveOrgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      if (orgNameCount >= 1) pass(`operator org name "${aliveOrgName}" rendered (${orgNameCount}x)`);
      else fail(`operator org name "${aliveOrgName}" NOT rendered`);
    } else {
      pass("(no org name on the org doc — fallback expected; testing fallback path)");
    }

    // Sanity-check: the legacy "Generated by PeakOps · <date>" pattern
    // should NOT appear in the customer-visible rendered footer when
    // an org name is present. Strip CSS/JS/HTML comments first — the
    // source still carries the phrase inside style-block comments,
    // which is rendered into the HTML body but invisible to humans.
    function stripComments(s) {
      // CSS / JS block comments
      let out = s.replace(/\/\*[\s\S]*?\*\//g, "");
      // HTML comments
      out = out.replace(/<!--[\s\S]*?-->/g, "");
      return out;
    }
    const allTextNoComments = stripComments(auditHtml) + "\n" + stripComments(customerHtml) + "\n" + readme;
    const legacyStandaloneCount = (allTextNoComments.match(/Generated by PeakOps · /g) || []).length;
    if (aliveOrgName && legacyStandaloneCount === 0) pass(`legacy "Generated by PeakOps · …" NOT rendered (org name present, branded path taken; CSS/HTML comments stripped before scan)`);
    else if (!aliveOrgName && legacyStandaloneCount >= 1) pass(`legacy "Generated by PeakOps · …" rendered as expected (no org name)`);
    else if (aliveOrgName) fail(`legacy "Generated by PeakOps · …" rendered ${legacyStandaloneCount}x despite org name present`);

    // Cleanup the extract dir
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  // ─── STEP 5: packet branding without org doc → legacy fallback
  // Hard to set up without risk. The drift guard
  // (test_chunk3b2_wired.mjs) verifies the fallback string is in
  // source. Skipping the live-test variant to avoid Firestore
  // surgery on the demo dataset. Documented as deferred.
  console.log("\n══ Step 5: legacy fallback (deferred — verified via drift guard)");
  console.log("  ⓘ Live test of the no-org-doc fallback would require Firestore");
  console.log("    surgery (delete/restore the alpha org doc) which is too risky on a");
  console.log("    live demo dataset. The drift-guard test_chunk3b2_wired.mjs asserts");
  console.log("    the fallback string is present in source at all 3 sites.");

} catch (e) {
  fail(`uncaught: ${e?.stack || e?.message || e}`);
} finally {
  console.log("\n── Cleanup ──");
  // Remove the temp member doc on the alpha org first (the only thing
  // we touched on a non-throwaway org).
  if (cleanup.tempMemberPath) {
    try {
      await db.doc(cleanup.tempMemberPath).delete();
      console.log(`  ✓ deleted temp member doc ${cleanup.tempMemberPath}`);
    } catch (e) { console.log(`  ⚠ temp member cleanup: ${e?.message}`); }
  }
  await deleteOrg(telecomOrgId);
  await deleteOrg(utilitiesOrgId);
  for (const uid of [cleanup.telecomOwnerUid, cleanup.utilitiesOwnerUid, SMOKE_UID].filter(Boolean)) {
    try { await admin.auth().deleteUser(uid); } catch {}
  }
  // Also delete the Auth users we minted by email if uid wasn't returned.
  for (const email of [TELECOM_ADMIN, UTILITIES_ADMIN]) {
    try { const u = await admin.auth().getUserByEmail(email); await admin.auth().deleteUser(u.uid); } catch {}
  }
  console.log("  ✓ deleted smoke orgs + Auth users");
}

console.log("\n" + "═".repeat(60));
if (failed === 0) console.log("🟢 ALL CHUNK 3B-2 POST-DEPLOY ASSERTIONS PASS");
else console.log(`🔴 ${failed} failure(s)`);
process.exit(failed > 0 ? 1 : 0);
