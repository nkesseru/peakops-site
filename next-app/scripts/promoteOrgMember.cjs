// PEAKOPS_RBAC_PROMOTE_ORG_MEMBER_V1 (2026-05-11)
//
// One-off operator script: promote a real Firebase Auth user to a
// real org-members record on a real org.
//
// Why this exists:
//   Earlier slices accepted a "dev-admin" / internal-admin actor
//   shortcut on the incident/review write path. Slice Branding 1.0
//   correctly gates org-level writes on the canonical members doc
//   (orgs/{orgId}/members/{uid}.role ∈ {owner, admin}). When a
//   real operator's session can perform incident lifecycle actions
//   via the shortcut path but is treated as non-admin by Branding,
//   the right fix is to give them a first-class members record —
//   not to weaken the Branding gate.
//
// This script:
//   1. Looks up the Firebase Auth user by email.
//   2. Reads current custom claims (read-only — never modified).
//   3. Reads the current orgs/{orgId}/members/{uid} doc.
//   4. With --apply, sets {role, status: "active", email,
//      createdAt (if new), updatedAt} on that doc, MERGE.
//   5. Verifies the write and prints the resulting member doc.
//
// What this script does NOT do:
//   - Does not modify custom claims.
//   - Does not modify the org doc.
//   - Does not modify any other org's members.
//   - Does not delete or downgrade anything.
//   - Cannot promote to a role other than "admin" or "owner"
//     (--role rejected otherwise).
//
// Auth + project resolution:
//   1. PEAKOPS_SA_PATH env var → service account JSON
//   2. ./service-account.json (next-app root) → default fallback
//   3. GOOGLE_APPLICATION_CREDENTIALS / applicationDefault() →
//      final fallback (e.g. running on GCE)
//
// Usage:
//   node scripts/promoteOrgMember.cjs \
//     --org=peakops-internal-alpha \
//     --email=user@example.com \
//     --role=admin
//
//   Without --apply: dry-run, prints the plan.
//   With    --apply: writes the member doc.

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const ORG = String(getArg("org") || "").trim();
const EMAIL = String(getArg("email") || "").trim().toLowerCase();
const ROLE = (String(getArg("role") || "admin") || "admin").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!ORG || !EMAIL) {
  console.error(
    "Usage: node scripts/promoteOrgMember.cjs --org=<orgId> --email=<email> [--role=admin|owner] [--apply]",
  );
  process.exit(2);
}

if (!["admin", "owner"].includes(ROLE)) {
  console.error(`--role must be "admin" or "owner" (got ${JSON.stringify(ROLE)})`);
  process.exit(2);
}

function loadServiceAccount() {
  const envPath = process.env.PEAKOPS_SA_PATH;
  const tryPaths = [
    envPath,
    path.resolve(__dirname, "..", "service-account.json"),
  ].filter(Boolean);
  for (const p of tryPaths) {
    if (p && fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const sa = JSON.parse(raw);
      if (sa.private_key && sa.private_key.includes("\\n")) {
        sa.private_key = sa.private_key.replace(/\\n/g, "\n");
      }
      return { sa, path: p };
    }
  }
  return null;
}

function ensureAdminApp() {
  if (admin.apps.length > 0) return admin.apps[0];
  const loaded = loadServiceAccount();
  if (loaded) {
    return admin.initializeApp({
      credential: admin.credential.cert(loaded.sa),
      projectId: loaded.sa.project_id,
    });
  }
  return admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

(async () => {
  const app = ensureAdminApp();
  const projectId = (app.options && app.options.projectId) || "(unknown)";
  console.log(`[promote] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[promote] org=${ORG} email=${EMAIL} role=${ROLE}`);

  const auth = admin.auth();
  const db = admin.firestore();

  // 1) Resolve UID
  let user;
  try {
    user = await auth.getUserByEmail(EMAIL);
  } catch (e) {
    console.error(`[promote] FAIL — could not look up user by email: ${e && e.message ? e.message : e}`);
    process.exit(3);
  }
  console.log(`[promote] UID=${user.uid}`);
  console.log(`[promote] displayName=${user.displayName || "(none)"} disabled=${!!user.disabled}`);

  // 2) Read claims (read-only; never modified)
  const claims = user.customClaims || {};
  console.log(`[promote] customClaims=${JSON.stringify(claims)}`);

  // 3) Read current member doc
  const memberRef = db.doc(`orgs/${ORG}/members/${user.uid}`);
  const memberSnap = await memberRef.get();
  const existing = memberSnap.exists ? memberSnap.data() : null;
  console.log(`[promote] existing members doc: ${existing ? JSON.stringify(existing) : "(none)"}`);

  // 4) Decide plan
  const existingStatus = String((existing && existing.status) || "").toLowerCase();
  const existingRole = String((existing && existing.role) || "").toLowerCase();
  if (existingStatus === "active" && existingRole === ROLE) {
    console.log(
      `[promote] no-op — already members/{${user.uid}} with role="${ROLE}" status="active"`,
    );
    process.exit(0);
  }

  const planFields = {
    role: ROLE,
    status: "active",
    email: EMAIL,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!existing) {
    planFields.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  console.log(`[promote] plan: set orgs/${ORG}/members/${user.uid} → ${JSON.stringify(planFields)} (merge)`);

  if (!APPLY) {
    console.log(`[promote] DRY RUN — pass --apply to write.`);
    process.exit(0);
  }

  await memberRef.set(planFields, { merge: true });
  const after = await memberRef.get();
  console.log(`[promote] write OK. resulting doc: ${JSON.stringify(after.data())}`);

  // 5) Claim coherence note (informational only)
  const orgIds = Array.isArray(claims.orgIds) ? claims.orgIds : [];
  const claimedOrgInList = orgIds.includes(ORG);
  if (claimedOrgInList) {
    console.log(`[promote] ✓ user's orgIds claim already includes ${ORG}`);
  } else {
    console.log(
      `[promote] ⚠ user's orgIds claim does NOT include ${ORG}. ` +
        `Org-scoped Firestore reads gated on orgIds claim will not work for this user. ` +
        `The Branding gate uses the members doc and is unaffected. ` +
        `Run scripts/../setClaims.cjs if claim coherence is required.`,
    );
  }

  console.log(`[promote] done.`);
  process.exit(0);
})().catch((e) => {
  console.error(`[promote] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
