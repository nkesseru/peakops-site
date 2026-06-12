// PEAKOPS_MUNI_QA_BOOTSTRAP_V1 (2026-05-11) — Slice Municipality 1.0 QA.
//
// One-off operator script: bootstraps a dedicated internal QA org
// for Municipality Mode 1.0 without mutating peakops-internal-alpha
// (the canonical telecom alpha) or any customer-facing org.
//
// What it writes (all keyed by --org=<orgId>, default peakops-internal-muni):
//   1. orgs/{orgId}                                       (industry=municipality, kind=internal)
//   2. orgs/{orgId}/onboarding/state                      (currentStep=ready, completedAt now)
//   3. orgs/{orgId}/members/{admin-email's uid}           (role=admin, status=active)
//
// What it deliberately does NOT do:
//   - does not modify custom claims (claim update is a separate
//     one-line `node setClaims.cjs ...` follow-up if QA needs
//     /api/fn/* access — flagged in the script's exit message).
//   - does not touch peakops-internal-alpha or any other org.
//   - does not seed incidents, jobs, evidence, or notes.
//   - does not touch reports, lifecycle, rules, or auth.
//   - refuses to run if --org resolves to "peakops-internal-alpha"
//     or "demo-org" (belt-and-braces against a typo).
//
// Idempotent + dry-run by default. With --apply it MERGE-writes each
// doc; existing fields are preserved.
//
// Usage:
//   node scripts/bootstrapInternalMuniOrg.cjs
//     --org=peakops-internal-muni
//     --admin=nicholaskesseru@gmail.com
//   (without --apply: dry-run, prints the plan only)
//
//   Add --apply to write.

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const ORG = String(getArg("org") || "peakops-internal-muni").trim();
const ADMIN_EMAIL = String(getArg("admin") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!ADMIN_EMAIL) {
  console.error(
    "Usage: node scripts/bootstrapInternalMuniOrg.cjs --org=<orgId> --admin=<email> [--apply]",
  );
  process.exit(2);
}

// Safety guards — refuse to write to canonical orgs even if mistyped.
const PROTECTED_ORGS = new Set(["peakops-internal-alpha", "demo-org"]);
if (PROTECTED_ORGS.has(ORG)) {
  console.error(`[muni-bootstrap] FATAL — refusing to write to protected org ${ORG}.`);
  process.exit(2);
}

const ORG_NAME = "PeakOps Internal Municipality";
const INDUSTRY = "municipality";
const INDUSTRY_PROFILE_VERSION = "v1.0";

// Mirrors the recommendedWorkflows array in industryProfiles.ts
// municipality entry. Default opsFocus selection covers the same
// five operational focus areas as the spec's Municipality Mode 1.0
// presets so the QA view exercises every municipal copy path.
const SELECTED_TEMPLATE = "stormwater_inspection";
const OPS_FOCUS_SELECTED = [
  "road_damage",
  "stormwater",
  "traffic_signals",
  "row_oversight",
  "contractor_oversight",
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
  console.log(`[muni-bootstrap] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[muni-bootstrap] org=${ORG}`);
  console.log(`[muni-bootstrap] admin=${ADMIN_EMAIL}`);

  const auth = admin.auth();
  const db = admin.firestore();

  // ── 1) Resolve admin UID -------------------------------------------------
  let user;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
  } catch (e) {
    console.error(
      `[muni-bootstrap] FAIL — cannot look up admin by email: ${e && e.message ? e.message : e}`,
    );
    process.exit(3);
  }
  const ADMIN_UID = user.uid;
  console.log(`[muni-bootstrap] admin UID=${ADMIN_UID}`);

  // Read existing claims (read-only; never modified by this script).
  const claims = user.customClaims || {};
  const claimOrgIds = Array.isArray(claims.orgIds) ? claims.orgIds : [];
  const claimHasOrg = claimOrgIds.includes(ORG);
  console.log(`[muni-bootstrap] admin claims.orgIds: [${claimOrgIds.join(", ")}]`);
  console.log(`[muni-bootstrap] admin claims include ${ORG}: ${claimHasOrg}`);

  // ── 2) Plan the org doc -------------------------------------------------
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
    `[muni-bootstrap] orgs/${ORG} ${existingOrg ? "exists — will MERGE" : "missing — will CREATE"}`,
  );

  // ── 3) Plan the onboarding state ---------------------------------------
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
    `[muni-bootstrap] orgs/${ORG}/onboarding/state ${existingState ? "exists — will MERGE" : "missing — will CREATE"}`,
  );

  // ── 4) Plan the admin member doc ---------------------------------------
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
    `[muni-bootstrap] orgs/${ORG}/members/${ADMIN_UID} ${existingMember ? "exists — will MERGE" : "missing — will CREATE"}`,
  );

  // ── Plan dump -----------------------------------------------------------
  console.log(
    `\n[muni-bootstrap] PLAN orgs/${ORG} ← ${JSON.stringify(orgPlan, null, 2)}`,
  );
  console.log(
    `[muni-bootstrap] PLAN orgs/${ORG}/onboarding/state ← ${JSON.stringify(statePlan, null, 2)}`,
  );
  console.log(
    `[muni-bootstrap] PLAN orgs/${ORG}/members/${ADMIN_UID} ← ${JSON.stringify(memberPlan, null, 2)}`,
  );

  if (!APPLY) {
    console.log("\n[muni-bootstrap] DRY RUN — pass --apply to write.");
    process.exit(0);
  }

  // ── Apply (MERGE for each) ---------------------------------------------
  await orgRef.set(orgPlan, { merge: true });
  await stateRef.set(statePlan, { merge: true });
  await memberRef.set(memberPlan, { merge: true });

  // Verification reads
  const orgAfter = (await orgRef.get()).data() || {};
  const stateAfter = (await stateRef.get()).data() || {};
  const memberAfter = (await memberRef.get()).data() || {};
  console.log(`\n[muni-bootstrap] AFTER orgs/${ORG}: ${JSON.stringify(orgAfter)}`);
  console.log(`[muni-bootstrap] AFTER onboarding/state: ${JSON.stringify(stateAfter)}`);
  console.log(`[muni-bootstrap] AFTER members/${ADMIN_UID}: ${JSON.stringify(memberAfter)}`);

  // Claim coherence note (info only; never modified here).
  if (!claimHasOrg) {
    console.log(
      `\n[muni-bootstrap] ⚠ admin's orgIds claim does not include ${ORG}.\n` +
        `   Org-scoped Firestore reads (rules-side) work via the new members doc.\n` +
        `   /api/fn/* (Jobs page incident listing, etc.) require the claim — those will 403\n` +
        `   for this user until the orgIds claim is updated.\n\n` +
        `   To grant /api/fn/* access (admin's choice; this script does NOT change claims):\n` +
        `     # adds this org to orgIds, preserves role + any other claim flags:\n` +
        `     node /Users/kesserumini/peakops/my-app/setClaims.cjs ${ADMIN_UID} ${ORG} <claim-role>\n` +
        `     (claim-role can stay "supervisor" — Firestore-side admin gate already lives in members doc.)`,
    );
  } else {
    console.log(`\n[muni-bootstrap] ✓ admin's orgIds claim already includes ${ORG}.`);
  }

  console.log("\n[muni-bootstrap] done.");
  process.exit(0);
})().catch((e) => {
  console.error(`[muni-bootstrap] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
