// PEAKOPS_CONTRACTOR_QA_BOOTSTRAP_V1 (2026-05-12) — Slice
// Infrastructure Contractor 1.0 QA.
//
// Sister of bootstrapInternalMuniOrg.cjs / bootstrapInternalUtilityOrg.cjs.
// Same shape, same safety guards, contractor-flavored payload.
// Bootstraps the peakops-internal-contractor QA org so Infrastructure
// Contractor Mode 1.0 can be QA'd in production without touching
// peakops-internal-alpha / -muni / -utility / demo-org.

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const ORG = String(getArg("org") || "peakops-internal-contractor").trim();
const ADMIN_EMAIL = String(getArg("admin") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!ADMIN_EMAIL) {
  console.error(
    "Usage: node scripts/bootstrapInternalContractorOrg.cjs --org=<orgId> --admin=<email> [--apply]",
  );
  process.exit(2);
}

const PROTECTED_ORGS = new Set([
  "peakops-internal-alpha",
  "peakops-internal-muni",
  "peakops-internal-utility",
  "demo-org",
]);
if (PROTECTED_ORGS.has(ORG)) {
  console.error(`[contractor-bootstrap] FATAL — refusing to write to protected org ${ORG}.`);
  process.exit(2);
}

const ORG_NAME = "PeakOps Internal Contractor";
const INDUSTRY = "contractor";
const INDUSTRY_PROFILE_VERSION = "v1.0";
const SELECTED_TEMPLATE = "job_closeout";
const OPS_FOCUS_SELECTED = [
  "proof_of_work",
  "job_closeout_documentation",
  "contractor_oversight",
  "safety_verification",
  "change_order_support",
  "site_condition_documentation",
  "client_handoff_records",
];

function loadServiceAccount() {
  const tryPaths = [
    process.env.PEAKOPS_SA_PATH,
    path.resolve(__dirname, "..", "service-account.json"),
  ].filter(Boolean);
  for (const p of tryPaths) {
    if (p && fs.existsSync(p)) {
      const sa = JSON.parse(fs.readFileSync(p, "utf8"));
      if (sa.private_key && sa.private_key.includes("\\n")) {
        sa.private_key = sa.private_key.replace(/\\n/g, "\n");
      }
      return sa;
    }
  }
  return null;
}

function ensureAdminApp() {
  if (admin.apps.length > 0) return admin.apps[0];
  const sa = loadServiceAccount();
  if (sa) {
    return admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id,
    });
  }
  return admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

(async () => {
  const app = ensureAdminApp();
  const projectId = (app.options && app.options.projectId) || "(unknown)";
  console.log(`[contractor-bootstrap] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[contractor-bootstrap] org=${ORG} admin=${ADMIN_EMAIL}`);

  const auth = admin.auth();
  const db = admin.firestore();

  let user;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
  } catch (e) {
    console.error(`[contractor-bootstrap] FAIL — cannot look up admin: ${e && e.message ? e.message : e}`);
    process.exit(3);
  }
  const ADMIN_UID = user.uid;
  console.log(`[contractor-bootstrap] admin UID=${ADMIN_UID}`);

  const claims = user.customClaims || {};
  const claimOrgIds = Array.isArray(claims.orgIds) ? claims.orgIds : [];
  const claimHasOrg = claimOrgIds.includes(ORG);
  console.log(`[contractor-bootstrap] admin claims.orgIds: [${claimOrgIds.join(", ")}]`);
  console.log(`[contractor-bootstrap] admin claims include ${ORG}: ${claimHasOrg}`);

  const orgRef = db.doc(`orgs/${ORG}`);
  const orgSnap = await orgRef.get();
  const existingOrg = orgSnap.exists ? (orgSnap.data() || {}) : null;
  const orgPlan = {
    name: ORG_NAME,
    industry: INDUSTRY,
    industryProfileVersion: INDUSTRY_PROFILE_VERSION,
    kind: "internal",
    orgType: "internal-qa",
    status: "active",
    timezone: "America/Los_Angeles",
    ownerUserId: ADMIN_UID,
    bootstrappedAt: admin.firestore.FieldValue.serverTimestamp(),
    bootstrappedBy: ADMIN_UID,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!existingOrg) {
    orgPlan.createdAt = admin.firestore.FieldValue.serverTimestamp();
    orgPlan.memberCount = 1;
    orgPlan.activeRelationshipCount = 0;
  }
  console.log(
    `[contractor-bootstrap] orgs/${ORG} ${existingOrg ? "exists — MERGE" : "missing — CREATE"}`,
  );

  const stateRef = db.doc(`orgs/${ORG}/onboarding/state`);
  const stateSnap = await stateRef.get();
  const existingState = stateSnap.exists ? (stateSnap.data() || {}) : null;
  const statePlan = {
    orgName: ORG_NAME,
    industry: INDUSTRY,
    industryProfileVersion: INDUSTRY_PROFILE_VERSION,
    timezone: "America/Los_Angeles",
    selectedTemplate: SELECTED_TEMPLATE,
    opsFocus: { selected: OPS_FOCUS_SELECTED, notes: "" },
    currentStep: "ready",
    completedSteps: ["welcome", "org", "industry", "ops_focus", "workflow", "team"],
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  console.log(
    `[contractor-bootstrap] orgs/${ORG}/onboarding/state ${existingState ? "exists — MERGE" : "missing — CREATE"}`,
  );

  const memberRef = db.doc(`orgs/${ORG}/members/${ADMIN_UID}`);
  const memberSnap = await memberRef.get();
  const existingMember = memberSnap.exists ? (memberSnap.data() || {}) : null;
  const memberPlan = {
    uid: ADMIN_UID,
    email: ADMIN_EMAIL,
    role: "admin",
    status: "active",
    orgId: ORG,
    source: "internal-qa-bootstrap",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!existingMember) {
    memberPlan.createdAt = admin.firestore.FieldValue.serverTimestamp();
    memberPlan.invitedAt = admin.firestore.FieldValue.serverTimestamp();
    memberPlan.joinedAt = admin.firestore.FieldValue.serverTimestamp();
    memberPlan.invitedBy = ADMIN_UID;
  }
  console.log(
    `[contractor-bootstrap] orgs/${ORG}/members/${ADMIN_UID} ${existingMember ? "exists — MERGE" : "missing — CREATE"}`,
  );

  if (!APPLY) {
    console.log(`\n[contractor-bootstrap] DRY RUN — pass --apply to write.`);
    process.exit(0);
  }

  await orgRef.set(orgPlan, { merge: true });
  await stateRef.set(statePlan, { merge: true });
  await memberRef.set(memberPlan, { merge: true });

  const orgAfter = (await orgRef.get()).data() || {};
  const stateAfter = (await stateRef.get()).data() || {};
  const memberAfter = (await memberRef.get()).data() || {};
  console.log(`\n[contractor-bootstrap] AFTER orgs/${ORG}: ${JSON.stringify(orgAfter).slice(0, 280)}…`);
  console.log(`[contractor-bootstrap] AFTER onboarding/state: ${JSON.stringify(stateAfter).slice(0, 280)}…`);
  console.log(`[contractor-bootstrap] AFTER members/${ADMIN_UID}: ${JSON.stringify(memberAfter).slice(0, 280)}…`);

  if (!claimHasOrg) {
    console.log(
      `\n[contractor-bootstrap] ⚠ admin's orgIds claim does not include ${ORG}.\n` +
        `   Append it (preserves existing claims):\n` +
        `     node scripts/appendOrgIdToClaim.cjs --email=${ADMIN_EMAIL} --org=${ORG} --apply`,
    );
  } else {
    console.log(`\n[contractor-bootstrap] ✓ admin's orgIds claim already includes ${ORG}.`);
  }

  console.log("\n[contractor-bootstrap] done.");
  process.exit(0);
})().catch((e) => {
  console.error(`[contractor-bootstrap] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
