// PEAKOPS_ENTITLEMENT_SEED_V1 (2026-05-13)
//
// Operator one-off: writes orgs/{orgId}/billing/state for the
// five known internal/demo orgs so the new requireEntitlement
// gate in exportIncidentPacketV1 doesn't 402 their existing
// export flows on deploy.
//
// What it writes (per org, merge-only, idempotent):
//   status:                            "active"  — only if currently missing
//   plan:                              "legacy"  — only if currently missing
//   entitlements.riskDefenseModule:    true      — only if not already true
//   lastUpdatedAt:                     serverTimestamp on any change
//   lastUpdatedBy:                     "operator:seed-billing-state-1.0"
//
// What it deliberately does NOT do:
//   - never overwrites notes (preserved verbatim if present, never
//     written at all — operators use the admin UI for notes)
//   - never overwrites plan if already set (so an org pushed to
//     "growth" / "enterprise" later does not get downgraded back
//     to "legacy")
//   - never overwrites status if already set (so a "suspended"
//     org does NOT silently get re-activated by this script)
//   - never touches any entitlement other than riskDefenseModule
//   - never touches limits / stripeCustomerId / stripeSubscriptionId /
//     currentPeriod
//   - never touches any org outside the hardcoded TARGETS list
//     below — editing TARGETS is a manual, in-file change
//   - never modifies firestore.rules, members, claims, or any
//     non-billing collection
//
// Idempotent: running twice produces the same state as running once.
// Dry-run by default; pass --apply to write.
//
// Usage:
//   node next-app/scripts/seedBillingState.cjs            # dry-run, prints plan
//   node next-app/scripts/seedBillingState.cjs --apply    # writes for real
//
//   PEAKOPS_SA_PATH=/path/to/sa.json node next-app/scripts/seedBillingState.cjs --apply
//   (override the service-account path; otherwise looks for
//    next-app/service-account.json then falls back to ADC.)

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

// Hardcoded allow-list. The safety property of this script is
// "never touches any org not explicitly listed here." Edit by hand
// only; no --org=<id> flag deliberately.
const TARGETS = [
  "peakops-internal-alpha",
  "peakops-internal-muni",
  "peakops-internal-utility",
  "peakops-internal-contractor",
  "demo-org",
];

const SEED_BY = "operator:seed-billing-state-1.0";
const DEFAULT_PLAN = "legacy";
const DEFAULT_STATUS = "active";

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
  return admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

function fmtTs(v) {
  if (!v) return "(none)";
  try {
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
  } catch (_) {
    /* ignore */
  }
  return "(unknown)";
}

function summarizeEntitlements(ent) {
  if (!ent || typeof ent !== "object") return "(none)";
  const keys = Object.keys(ent);
  if (keys.length === 0) return "(none)";
  return keys
    .map((k) => `${k}=${ent[k] === true ? "true" : "false"}`)
    .join(", ");
}

(async () => {
  const app = ensureAdminApp();
  const projectId = (app.options && app.options.projectId) || "(unknown)";

  console.log(
    `[seed-billing] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`,
  );
  console.log(`[seed-billing] targets (${TARGETS.length}): ${TARGETS.join(", ")}`);
  console.log("");

  const db = admin.firestore();

  let willWriteCount = 0;
  let skippedCount = 0;
  let missingOrgCount = 0;
  let wroteCount = 0;

  for (const orgId of TARGETS) {
    console.log(`── ${orgId} ──`);

    // Refuse to attach billing to an org that doesn't exist.
    // This script never auto-creates parent org docs.
    const orgSnap = await db.doc(`orgs/${orgId}`).get();
    if (!orgSnap.exists) {
      console.warn(
        `  !! orgs/${orgId} does not exist — SKIP (no parent org to attach billing to)`,
      );
      missingOrgCount++;
      console.log("");
      continue;
    }

    const ref = db.doc(`orgs/${orgId}/billing/state`);
    const before = await ref.get();
    const beforeData = before.exists ? before.data() || {} : null;

    console.log("  BEFORE:");
    if (!beforeData) {
      console.log("    (no billing/state doc — full seed)");
    } else {
      console.log(`    status=${beforeData.status || "(missing)"}`);
      console.log(`    plan=${beforeData.plan || "(missing)"}`);
      console.log(`    entitlements: ${summarizeEntitlements(beforeData.entitlements)}`);
      console.log(
        `    notes=${beforeData.notes ? `<preserved, ${String(beforeData.notes).length} chars>` : "(empty)"}`,
      );
      console.log(`    lastUpdatedAt=${fmtTs(beforeData.lastUpdatedAt)}`);
      console.log(`    lastUpdatedBy=${beforeData.lastUpdatedBy || "(none)"}`);
    }

    // Build the patch with strict idempotency. We use merge:true on
    // the write so any pre-existing fields not listed here are
    // preserved untouched (limits, stripe IDs, currentPeriod, etc).
    const patch = {};
    let willWrite = false;

    if (!beforeData || !beforeData.status) {
      patch.status = DEFAULT_STATUS;
      willWrite = true;
    }

    if (!beforeData || !beforeData.plan) {
      patch.plan = DEFAULT_PLAN;
      willWrite = true;
    }

    const beforeEnt =
      beforeData &&
      beforeData.entitlements &&
      typeof beforeData.entitlements === "object"
        ? beforeData.entitlements
        : {};
    if (beforeEnt.riskDefenseModule !== true) {
      // Spread the existing entitlements so any other premium keys
      // (api/sso/whiteLabel) are preserved exactly as set elsewhere.
      patch.entitlements = { ...beforeEnt, riskDefenseModule: true };
      willWrite = true;
    }

    if (!willWrite) {
      console.log(
        "  CHANGE: (nothing — status set, plan set, riskDefenseModule=true)",
      );
      skippedCount++;
      console.log("");
      continue;
    }

    patch.lastUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
    patch.lastUpdatedBy = SEED_BY;

    console.log("  CHANGE:");
    if (patch.status) console.log(`    + status = "${patch.status}"`);
    if (patch.plan) console.log(`    + plan   = "${patch.plan}"`);
    if (patch.entitlements) {
      const preservedKeys = Object.keys(beforeEnt).filter(
        (k) => k !== "riskDefenseModule",
      );
      console.log(
        `    + entitlements.riskDefenseModule = true` +
          (preservedKeys.length
            ? ` (preserving: ${preservedKeys.join(", ")})`
            : ""),
      );
    }
    console.log(`    + lastUpdatedAt = serverTimestamp`);
    console.log(`    + lastUpdatedBy = "${SEED_BY}"`);

    willWriteCount++;

    if (!APPLY) {
      console.log("  DRY RUN — pass --apply to write.");
      console.log("");
      continue;
    }

    await ref.set(patch, { merge: true });

    const afterSnap = await ref.get();
    const after = afterSnap.data() || {};
    console.log("  AFTER:");
    console.log(`    status=${after.status || "(missing)"}`);
    console.log(`    plan=${after.plan || "(missing)"}`);
    console.log(`    entitlements: ${summarizeEntitlements(after.entitlements)}`);
    console.log(
      `    notes=${after.notes ? `<preserved, ${String(after.notes).length} chars>` : "(empty)"}`,
    );
    console.log(`    lastUpdatedAt=${fmtTs(after.lastUpdatedAt)}`);
    console.log(`    lastUpdatedBy=${after.lastUpdatedBy || "(none)"}`);
    wroteCount++;
    console.log("");
  }

  console.log("──── summary ────");
  console.log(`  targets:        ${TARGETS.length}`);
  console.log(
    `  would-write:    ${willWriteCount}${APPLY ? "" : " (dry-run; re-run with --apply)"}`,
  );
  console.log(`  wrote:          ${wroteCount}${APPLY ? "" : " (n/a in dry-run)"}`);
  console.log(`  skipped:        ${skippedCount}  (already fully provisioned)`);
  console.log(
    `  missing parent: ${missingOrgCount}  (parent orgs/{orgId} doc not found)`,
  );
  console.log(`  mode:           ${APPLY ? "APPLY" : "dry-run"}`);

  // Non-zero exit when something needs operator attention.
  process.exit(missingOrgCount > 0 ? 2 : 0);
})().catch((e) => {
  console.error(
    "[seed-billing] FAIL:",
    e && e.stack ? e.stack : String(e),
  );
  process.exit(1);
});
