// PEAKOPS_APPEND_ORGID_CLAIM_V1 (2026-05-11)
//
// Append-safe variant of setClaims.cjs. The legacy setClaims.cjs
// REPLACES orgIds with [orgId] every time it runs — useful for a
// first-time provision but destructive for a multi-org user who's
// just being added to one more org.
//
// This script:
//   - reads existing customClaims
//   - appends orgId to orgIds (deduped)
//   - preserves singular orgId (sets it to the first element of
//     the resulting array)
//   - preserves role, peakopsInternalAdmin, and every other claim
//     key the user already has
//   - DOES NOT change role unless --role is explicitly passed
//
// Usage:
//   node scripts/appendOrgIdToClaim.cjs --email=<email> --org=<orgId>
//   Add --apply to write.
//   --role=<role> (optional) overrides the existing role claim;
//   default is "preserve existing".

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const EMAIL = String(getArg("email") || "").trim().toLowerCase();
const ORG = String(getArg("org") || "").trim();
const NEW_ROLE = String(getArg("role") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!EMAIL || !ORG) {
  console.error(
    "Usage: node scripts/appendOrgIdToClaim.cjs --email=<email> --org=<orgId> [--role=<role>] [--apply]",
  );
  process.exit(2);
}

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
  console.log(`[append-claim] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[append-claim] email=${EMAIL} append-org=${ORG} role=${NEW_ROLE || "(preserve)"}`);

  const user = await admin.auth().getUserByEmail(EMAIL);
  console.log(`[append-claim] uid=${user.uid}`);
  const before = user.customClaims || {};
  console.log(`[append-claim] BEFORE customClaims=${JSON.stringify(before)}`);

  const beforeOrgIds = Array.isArray(before.orgIds)
    ? before.orgIds.map((v) => String(v)).filter(Boolean)
    : (typeof before.orgId === "string" && before.orgId.trim() ? [String(before.orgId).trim()] : []);
  const merged = Array.from(new Set([...beforeOrgIds, ORG]));

  const nextRole = NEW_ROLE || String(before.role || "");
  const next = {
    ...before,
    orgIds: merged,
    // Preserve singular orgId. Prefer the existing primary orgId if
    // present, else fall back to first element of the merged array.
    orgId: typeof before.orgId === "string" && before.orgId.trim() ? String(before.orgId).trim() : merged[0],
    role: nextRole,
  };

  console.log(`[append-claim] AFTER  customClaims=${JSON.stringify(next)}`);
  const orgsAdded = merged.filter((o) => !beforeOrgIds.includes(o));
  const orgsRemoved = beforeOrgIds.filter((o) => !merged.includes(o));
  console.log(`[append-claim] diff added=${JSON.stringify(orgsAdded)} removed=${JSON.stringify(orgsRemoved)}`);
  if (orgsRemoved.length > 0) {
    console.error(`[append-claim] FAIL — would remove orgIds (${orgsRemoved.join(",")}). Refusing.`);
    process.exit(3);
  }

  if (!APPLY) {
    console.log("[append-claim] DRY RUN — pass --apply to write.");
    process.exit(0);
  }

  await admin.auth().setCustomUserClaims(user.uid, next);

  // Verify with a fresh read.
  const verify = await admin.auth().getUser(user.uid);
  console.log(`[append-claim] VERIFIED customClaims=${JSON.stringify(verify.customClaims || {})}`);
  console.log(`[append-claim] done. User must sign out + back in (or call getIdToken(true)) for the new claim to take effect in the browser.`);
  process.exit(0);
})().catch((e) => {
  console.error(`[append-claim] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
