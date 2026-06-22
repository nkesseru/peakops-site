// PEAKOPS_CREATE_ORG_V1 + PEAKOPS_INVITE_ORG_MEMBER_V1 — drift guard
// Chunk 3B-1: Founder-CLI Replacement, 2026-06-22
//
// Pure-file inspection. Asserts that:
//   - Both new callables exist in functions_clean/ and carry their
//     markers.
//   - Both are registered in functions_clean/index.js so deploys ship
//     them.
//   - Both use the existing _customerSlug / _authz / _actor helpers
//     (not reinventing).
//   - Both call admin.auth().setCustomUserClaims (the actual claims
//     mint) AND admin.auth().generatePasswordResetLink (the magic
//     link path).
//   - The activate-customer-org CLI is registered, syntactically
//     valid, and references both callables by name.
//
// A future refactor that strips any of these surfaces fails this
// test before it ships.

import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const REPO = "/Users/kesserumini/peakops/my-app";

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

console.log("=== createOrgV1.js ===");
{
  const path = `${REPO}/functions_clean/createOrgV1.js`;
  if (!fs.existsSync(path)) { fail(`source not found: ${path}`); }
  else {
    const src = fs.readFileSync(path, "utf8");
    if (!/PEAKOPS_CREATE_ORG_V1/.test(src)) fail("missing PEAKOPS_CREATE_ORG_V1 marker");
    else pass("PEAKOPS_CREATE_ORG_V1 marker present");
    if (!/exports\.createOrgV1\s*=\s*onRequest/.test(src)) fail("export shape is not onRequest");
    else pass("exports.createOrgV1 = onRequest(...)");
    if (!/require\("\.\/_customerSlug"\)/.test(src)) fail("does not use _customerSlug helper");
    else pass("uses toCustomerSlug for orgId derivation");
    if (!/setCustomUserClaims\(/.test(src)) fail("does not call setCustomUserClaims");
    else pass("mints custom claims via setCustomUserClaims");
    if (!/generatePasswordResetLink\(/.test(src)) fail("does not call generatePasswordResetLink");
    else pass("generates first-login magic link via generatePasswordResetLink");
    if (!/peakopsInternalAdmin/.test(src)) fail("does not gate on peakopsInternalAdmin claim");
    else pass("gates on peakopsInternalAdmin claim (founder-only for now)");
    if (!/already:\s*true/.test(src)) fail("does not return already:true for idempotent re-calls");
    else pass("idempotent: returns already:true if org exists");
    if (!/orgs\/\$\{orgId\}\/members\/\$\{ownerUid\}/.test(src)) fail("does not write member doc at orgs/{orgId}/members/{ownerUid}");
    else pass("writes owner member doc at canonical path");
    if (!/type:\s*"ORG_CREATED"/.test(src)) fail("does not emit ORG_CREATED audit event");
    else pass("emits ORG_CREATED audit row");
  }
}

console.log("\n=== inviteOrgMemberV1.js ===");
{
  const path = `${REPO}/functions_clean/inviteOrgMemberV1.js`;
  if (!fs.existsSync(path)) { fail(`source not found: ${path}`); }
  else {
    const src = fs.readFileSync(path, "utf8");
    if (!/PEAKOPS_INVITE_ORG_MEMBER_V1/.test(src)) fail("missing PEAKOPS_INVITE_ORG_MEMBER_V1 marker");
    else pass("PEAKOPS_INVITE_ORG_MEMBER_V1 marker present");
    if (!/exports\.inviteOrgMemberV1\s*=\s*onRequest/.test(src)) fail("export shape is not onRequest");
    else pass("exports.inviteOrgMemberV1 = onRequest(...)");
    if (!/require\("\.\/_authz"\)/.test(src)) fail("does not import _authz");
    else pass("imports _authz for role gating");
    if (!/ROLES_ADMIN_ONLY/.test(src)) fail("does not reference ROLES_ADMIN_ONLY allow-list");
    else pass("references ROLES_ADMIN_ONLY allow-list");
    if (!/setCustomUserClaims\(/.test(src)) fail("does not call setCustomUserClaims");
    else pass("mints custom claims via setCustomUserClaims");
    if (!/generatePasswordResetLink\(/.test(src)) fail("does not generate magic link");
    else pass("generates magic link via generatePasswordResetLink");
    if (!/orgIds/.test(src)) fail("does not reference orgIds claim");
    else pass("manages orgIds claim (multi-org membership)");
    if (!/role_conflict/.test(src)) fail("does not handle role_conflict for existing members");
    else pass("returns role_conflict if existing member has different role");
    if (!/owner_role_not_invitable/.test(src)) fail("does not reject role='owner' (ownership is set by createOrgV1)");
    else pass("rejects role='owner' invitations");
    if (!/type:\s*"MEMBER_INVITED"/.test(src)) fail("does not emit MEMBER_INVITED audit event");
    else pass("emits MEMBER_INVITED audit row");
  }
}

console.log("\n=== index.js registration ===");
{
  const path = `${REPO}/functions_clean/index.js`;
  const src = fs.readFileSync(path, "utf8");
  if (!/safeExport\("createOrgV1",\s*"\.\/createOrgV1"\)/.test(src)) fail("createOrgV1 not registered in index.js");
  else pass("createOrgV1 registered in index.js");
  if (!/safeExport\("inviteOrgMemberV1",\s*"\.\/inviteOrgMemberV1"\)/.test(src)) fail("inviteOrgMemberV1 not registered in index.js");
  else pass("inviteOrgMemberV1 registered in index.js");
}

console.log("\n=== Modules require cleanly (catches missing helpers / typos) ===");
try {
  // Note: we can't actually load the onRequest-wrapped exports without
  // the Cloud Functions runtime, but we CAN require the module — which
  // will pull in every helper at module load and surface broken paths.
  require(`${REPO}/functions_clean/createOrgV1.js`);
  pass("functions_clean/createOrgV1.js requires cleanly");
} catch (e) {
  fail(`functions_clean/createOrgV1.js require failed: ${e?.message}`);
}
try {
  require(`${REPO}/functions_clean/inviteOrgMemberV1.js`);
  pass("functions_clean/inviteOrgMemberV1.js requires cleanly");
} catch (e) {
  fail(`functions_clean/inviteOrgMemberV1.js require failed: ${e?.message}`);
}

console.log("\n=== scripts/activateCustomerOrg.cjs ===");
{
  const path = `${REPO}/scripts/activateCustomerOrg.cjs`;
  if (!fs.existsSync(path)) { fail("activateCustomerOrg.cjs not present"); }
  else {
    const src = fs.readFileSync(path, "utf8");
    if (!/PEAKOPS_ACTIVATE_CUSTOMER_ORG_V1/.test(src)) fail("missing marker");
    else pass("PEAKOPS_ACTIVATE_CUSTOMER_ORG_V1 marker present");
    if (!/\/createOrgV1/.test(src)) fail("does not call /createOrgV1");
    else pass("calls /createOrgV1 endpoint");
    if (!/\/inviteOrgMemberV1/.test(src)) fail("does not call /inviteOrgMemberV1");
    else pass("calls /inviteOrgMemberV1 endpoint");
    if (!/--apply/.test(src)) fail("missing --apply flag (dry-run-by-default behavior)");
    else pass("default DRY-RUN, --apply required to execute");
    if (!/FIREBASE_ID_TOKEN/.test(src)) fail("does not require FIREBASE_ID_TOKEN env var");
    else pass("requires FIREBASE_ID_TOKEN env var for admin auth");
    if (!/printEmailTemplate/.test(src)) fail("does not print an email template");
    else pass("prints copy-paste email template for CS person");
  }
}

if (failed) {
  console.error(`\n❌ chunk3b1 drift guard: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ chunk3b1 (createOrgV1 + inviteOrgMemberV1 + activate script) wired correctly");
