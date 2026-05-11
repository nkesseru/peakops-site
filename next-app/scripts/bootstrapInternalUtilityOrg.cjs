// PEAKOPS_UTILITY_QA_BOOTSTRAP_V1 (2026-05-11) — Slice Utility 1.0 QA.
//
// Sister of scripts/bootstrapInternalMuniOrg.cjs — same shape, same
// safety guards, different industry payload. Bootstraps the
// peakops-internal-utility QA org so Utility Mode 1.0 can be QA'd
// in production without touching peakops-internal-alpha (telecom)
// or peakops-internal-muni (municipality).
//
// What it writes (all keyed by --org=<orgId>, default peakops-internal-utility):
//   1. orgs/{orgId}                                       (industry=utilities, kind=internal)
//   2. orgs/{orgId}/onboarding/state                      (currentStep=ready, utility template, utility opsFocus)
//   3. orgs/{orgId}/members/{admin-email's uid}           (role=admin, status=active)
//
// What it deliberately does NOT do:
//   - does not modify custom claims (claim append is a separate
//     follow-up via scripts/appendOrgIdToClaim.cjs)
//   - does not touch peakops-internal-alpha or peakops-internal-muni
//   - does not seed incidents, jobs, evidence, or notes
//   - refuses to run if --org resolves to a protected org id
//
// Idempotent + dry-run by default. --apply to write.

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const ORG = String(getArg("org") || "peakops-internal-utility").trim();
const ADMIN_EMAIL = String(getArg("admin") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!ADMIN_EMAIL) {
  console.error(
    "Usage: node scripts/bootstrapInternalUtilityOrg.cjs --org=<orgId> --admin=<email> [--apply]",
  );
  process.exit(2);
}

const PROTECTED_ORGS = new Set([
  "peakops-internal-alpha",
  "peakops-internal-muni",
  "demo-org",
]);
if (PROTECTED_ORGS.has(ORG)) {
  console.error(`[utility-bootstrap] FATAL — refusing to write to protected org ${ORG}.`);
  process.exit(2);
}

const ORG_NAME = "PeakOps Internal Utility";
const INDUSTRY = "utilities";
const INDUSTRY_PROFILE_VERSION = "v1.0";
const SELECTED_TEMPLATE = "utility_outage";
const OPS_FOCUS_SELECTED = [
  "outage_restoration",
  "pole_inspection",
  "transformer_inspection",
  "vegetation_management",
  "safety_inspection",
  "damage_assessment",
  "emergency_response",
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
  console.log(`[utility-bootstrap] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[utility-bootstrap] org=${ORG} admin=${ADMIN_EMAIL}`);

  const auth = admin.auth();
  const db = admin.firestore();

  let user;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
  } catch (e) {
    console.error(
      `[utility-bootstrap] FAIL — cannot look up admin by email: ${e && e.message ? e.message : e}`,
    );
    process.exit(3);
  }
  const ADMIN_UID = user.uid;
  console.log(`[utility-bootstrap] admin UID=${ADMIN_UID}`);

  const claims = user.customClaims || {};
  const claimOrgIds = Array.isArray(claims.orgIds) ? claims.orgIds : [];
  console.log(`[utility-bootstrap] admin claims.orgIds: [${claimOrgIds.join(", ")}]`);
  const claimHasOrg = claimOrgIds.includes(ORG);
  console.log(`[utility-bootstrap] admin claims include ${ORG}: ${claimHasOrg}`);

  // ── 1) Plan the org doc ------------------------------------------------
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
    `[utility-bootstrap] orgs/${ORG} ${existingOrg ? "exists — will MERGE" : "missing — will CREATE"}`,
  );

  // ── 2) Plan the onboarding state ---------------------------------------
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
    `[utility-bootstrap] orgs/${ORG}/onboarding/state ${existingState ? "exists — will MERGE" : "missing — will CREATE"}`,
  );

  // ── 3) Plan the admin member doc ---------------------------------------
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
    `[utility-bootstrap] orgs/${ORG}/members/${ADMIN_UID} ${existingMember ? "exists — will MERGE" : "missing — will CREATE"}`,
  );

  if (!APPLY) {
    console.log("\n[utility-bootstrap] DRY RUN — pass --apply to write.");
    process.exit(0);
  }

  await orgRef.set(orgPlan, { merge: true });
  await stateRef.set(statePlan, { merge: true });
  await memberRef.set(memberPlan, { merge: true });

  const orgAfter = (await orgRef.get()).data() || {};
  const stateAfter = (await stateRef.get()).data() || {};
  const memberAfter = (await memberRef.get()).data() || {};
  console.log(`\n[utility-bootstrap] AFTER orgs/${ORG}: ${JSON.stringify(orgAfter)}`);
  console.log(`[utility-bootstrap] AFTER onboarding/state: ${JSON.stringify(stateAfter)}`);
  console.log(`[utility-bootstrap] AFTER members/${ADMIN_UID}: ${JSON.stringify(memberAfter)}`);

  if (!claimHasOrg) {
    console.log(
      `\n[utility-bootstrap] ⚠ admin's orgIds claim does not include ${ORG}.\n` +
        `   Append it (preserves existing claims):\n` +
        `     node scripts/appendOrgIdToClaim.cjs --email=${ADMIN_EMAIL} --org=${ORG} --apply`,
    );
  } else {
    console.log(`\n[utility-bootstrap] ✓ admin's orgIds claim already includes ${ORG}.`);
  }

  console.log("\n[utility-bootstrap] done.");
  process.exit(0);
})().catch((e) => {
  console.error(`[utility-bootstrap] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
