#!/usr/bin/env node
// PR 134B — static drift guard for the auto-email integration.
//
// Catches the most common regressions:
//   1. _emailer.js loses graceful no-API-key degradation (would
//      crash createOrgV1 in local/CI environments)
//   2. _emailer.js stops returning the documented result shape
//      (caller-side audit + response status would go null)
//   3. createOrgV1 / inviteOrgMemberV1 drop the auto-email opt-in
//      flag, the audit-row write, or the response embed
//   4. activateCustomerOrg.cjs --auto-email flag stops threading
//      through to the call bodies
//   5. Welcome / invite templates lose placeholders the doc
//      contract (docs/customer-emails/01-welcome.md) references

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ PR 134B auto-email drift guard ════════════════════════════════════");

// ── 1. _emailer.js contract ───────────────────────────────────────
const emailerSrc = read(`${ROOT}/functions_clean/_emailer.js`);
ok("_emailer exports sendEmail", /module\.exports\s*=\s*\{[\s\S]*sendEmail/.test(emailerSrc));
ok("_emailer reads RESEND_API_KEY from env", /process\.env\.RESEND_API_KEY/.test(emailerSrc));
ok("_emailer reads EMAIL_FROM from env", /process\.env\.EMAIL_FROM/.test(emailerSrc));
ok("_emailer returns skipped=true when not configured",
   /skipped:\s*true[\s\S]{0,150}email_not_configured/.test(emailerSrc));
ok("_emailer posts to Resend endpoint",
   /api\.resend\.com\/emails/.test(emailerSrc));
ok("_emailer never throws on fetch failure (wraps in try/catch)",
   /try\s*\{[\s\S]{0,1500}\}\s*catch/.test(emailerSrc));
ok("_emailer returns deliveryId from response", /deliveryId/.test(emailerSrc));

// ── 2. _emailTemplates.js contract ────────────────────────────────
const tplSrc = read(`${ROOT}/functions_clean/_emailTemplates.js`);
ok("_emailTemplates exports welcomeOwnerEmail", /exports[\s\S]{0,200}welcomeOwnerEmail/.test(tplSrc));
ok("_emailTemplates exports inviteTeammateEmail", /exports[\s\S]{0,200}inviteTeammateEmail/.test(tplSrc));
// Doc contract: docs/customer-emails/01-welcome.md uses these
// placeholders. The inline JS templates must consume all of them
// (whether or not they're optional at call time).
const welcomeMd = read(`${ROOT}/docs/customer-emails/01-welcome.md`);
const placeholders = Array.from(welcomeMd.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1]);
const uniquePh = [...new Set(placeholders)];
// Doc placeholder → JS template parameter mapping. welcome.md
// contains both the welcome template (admin) and the invite template
// (teammate); both sets are represented here. `null` value means the
// placeholder is intentionally NOT carried into the JS template (we
// dropped customerSuccessTimezone from the inline templates as it
// added clutter without clear customer value).
const placeholderMapping = {
  customerFirstName: "ownerName",
  customerOrgName: "orgName",
  firstLoginUrl: "firstLoginUrl",
  orgId: "orgId",
  csName: "csName",
  csEmail: "csEmail",
  customerSuccessTimezone: null,
  teammateFirstName: "teammateName",
  magicLink: "magicLink",
  role: "role",
};
for (const ph of uniquePh) {
  const mapped = placeholderMapping[ph];
  if (mapped === null) continue;
  if (!mapped) {
    console.log(`  ⚠ doc placeholder ${ph} not mapped — extend placeholderMapping`);
    continue;
  }
  ok(`welcomeOwnerEmail consumes doc placeholder ${ph} → ${mapped}`,
     new RegExp(mapped).test(tplSrc));
}
ok("inviteTeammateEmail accepts magicLink", /magicLink/.test(tplSrc));
ok("inviteTeammateEmail accepts inviterName + role", /inviterName/.test(tplSrc) && /role/.test(tplSrc));
ok("templates have HTML escape helper",
   /function _esc/.test(tplSrc) && /replace\(\/&\/g/.test(tplSrc));

// ── 3. createOrgV1 wiring ─────────────────────────────────────────
const createOrgSrc = read(`${ROOT}/functions_clean/createOrgV1.js`);
ok("createOrgV1 imports sendEmail",
   /require\("\.\/_emailer"\)/.test(createOrgSrc));
ok("createOrgV1 imports welcomeOwnerEmail template",
   /welcomeOwnerEmail/.test(createOrgSrc) && /require\("\.\/_emailTemplates"\)/.test(createOrgSrc));
ok("createOrgV1 reads body.sendWelcomeEmail opt-in flag",
   /body\.sendWelcomeEmail\s*===\s*true/.test(createOrgSrc));
ok("createOrgV1 sends only AFTER batch.commit",
   // The send block follows the starterTemplate try/catch; that
   // block runs after `await batch.commit()`. Confirm the
   // PEAKOPS_AUTO_EMAIL_V1 marker is between the catch and the
   // final return statement.
   /batch\.commit[\s\S]{0,3000}PEAKOPS_AUTO_EMAIL_V1[\s\S]{0,2500}return j\(res, 200/.test(createOrgSrc));
ok("createOrgV1 writes welcome_email_attempted audit row",
   /welcome_email_attempted/.test(createOrgSrc));
ok("createOrgV1 returns welcomeEmail status in response",
   /welcomeEmail,\s*$/m.test(createOrgSrc) || /welcomeEmail:\s*welcomeEmail/.test(createOrgSrc));

// ── 4. inviteOrgMemberV1 wiring ───────────────────────────────────
const inviteSrc = read(`${ROOT}/functions_clean/inviteOrgMemberV1.js`);
ok("inviteOrgMemberV1 imports sendEmail", /require\("\.\/_emailer"\)/.test(inviteSrc));
ok("inviteOrgMemberV1 imports inviteTeammateEmail",
   /inviteTeammateEmail/.test(inviteSrc));
ok("inviteOrgMemberV1 reads body.sendInviteEmail opt-in flag",
   /body\.sendInviteEmail\s*===\s*true/.test(inviteSrc));
ok("inviteOrgMemberV1 sends AFTER batch.commit",
   /batch\.commit[\s\S]{0,3000}PEAKOPS_AUTO_EMAIL_V1[\s\S]{0,2500}return j\(res, 200/.test(inviteSrc));
ok("inviteOrgMemberV1 writes invite_email_attempted audit row",
   /invite_email_attempted/.test(inviteSrc));
ok("inviteOrgMemberV1 returns inviteEmail status in response",
   /inviteEmail,\s*$/m.test(inviteSrc) || /inviteEmail:\s*inviteEmail/.test(inviteSrc));

// ── 5. activateCustomerOrg.cjs threading ──────────────────────────
const scriptSrc = read(`${ROOT}/scripts/activateCustomerOrg.cjs`);
ok("activateCustomerOrg parses --auto-email flag", /a\s*===\s*"--auto-email"/.test(scriptSrc));
ok("activateCustomerOrg parses --cs-name / --cs-email / --inviter-name",
   /--cs-name=/.test(scriptSrc) && /--cs-email=/.test(scriptSrc) && /--inviter-name=/.test(scriptSrc));
ok("activateCustomerOrg threads sendWelcomeEmail when --auto-email",
   /args\.autoEmail\s*\?\s*\{\s*\n?\s*sendWelcomeEmail:\s*true/.test(scriptSrc));
ok("activateCustomerOrg threads sendInviteEmail when --auto-email",
   /args\.autoEmail\s*\?\s*\{\s*\n?\s*sendInviteEmail:\s*true/.test(scriptSrc));
ok("activateCustomerOrg surfaces welcomeEmail outcome to stdout",
   /Welcome email:[\s\S]{0,200}sent|Welcome email:[\s\S]{0,200}skipped|Welcome email:[\s\S]{0,200}FAILED/.test(scriptSrc));
ok("activateCustomerOrg surfaces inviteEmail outcome to stdout",
   /Invite email:[\s\S]{0,200}sent|Invite email:[\s\S]{0,200}skipped|Invite email:[\s\S]{0,200}FAILED/.test(scriptSrc));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 134B auto-email drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — auto-email surface drifted from PR 134B contract`);
  process.exit(1);
}
