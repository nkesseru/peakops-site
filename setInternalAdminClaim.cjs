/**
 * setInternalAdminClaim.cjs (Slice 16, 2026-05-06)
 *
 * Mints the `peakopsInternalAdmin: true` custom claim on a single
 * Firebase Auth user. That claim is the gate `bootstrapPilotOrgV1`
 * checks in production — without it, the callable refuses to create
 * a customer org plus owner member doc.
 *
 * Companion to the existing `setClaims.cjs` (which mints
 * `{ orgId, role }` for end-user membership). This script is
 * narrower on purpose: it ONLY ever sets `peakopsInternalAdmin`,
 * and it merges with whatever the user's existing claims are so an
 * end-user being elevated to internal admin keeps their `orgIds`
 * and `role`.
 *
 * SAFETY POSTURE
 *   - Dry-run by default. Prints what it WOULD do, then exits.
 *   - --apply is required to actually mutate auth.
 *   - --revoke removes the claim instead of granting it (use with
 *     --apply just like granting).
 *   - --target-uid OR --target-email is required. Wildcards / regex
 *     are not accepted; a typo is much more likely to grant the
 *     wrong human bootstrap-org capability than a regex is to be
 *     correct.
 *   - Confirmation banner before any mutation, including projectId
 *     and target identity. Refuses to apply against demo / emulator
 *     projects (they don't need this claim — bootstrapPilotOrgV1
 *     accepts any caller in emulator mode).
 *   - Does not log the service-account JSON.
 *
 * USAGE
 *
 *   # Dry-run by uid:
 *   node setInternalAdminClaim.cjs --target-uid=<firebase-uid>
 *
 *   # Dry-run by email:
 *   node setInternalAdminClaim.cjs --target-email=name@peakops.io
 *
 *   # Apply:
 *   node setInternalAdminClaim.cjs --target-email=name@peakops.io --apply
 *
 *   # Revoke (production only):
 *   node setInternalAdminClaim.cjs --target-uid=<uid> --revoke --apply
 *
 * CREDENTIAL LOADING (mirrors setClaims.cjs)
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON (JSON text)
 *   2. FIREBASE_SA_JSON_BASE64 (base64-encoded JSON)
 *   3. ./sa.json (file fallback)
 *   4. GOOGLE_APPLICATION_CREDENTIALS / K_SERVICE → ADC
 *
 * After running, the target user must sign out and back in (or the
 * client must call user.getIdToken(true)) before the claim is
 * visible to the Identity Toolkit.
 */
const fs = require("fs");
const admin = require("firebase-admin");

const args = process.argv.slice(2);
const FLAG_APPLY  = args.includes("--apply");
const FLAG_REVOKE = args.includes("--revoke");

function readFlag(name) {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : "";
}

const TARGET_UID   = readFlag("target-uid");
const TARGET_EMAIL = readFlag("target-email").toLowerCase();

function die(msg, code = 1) {
  console.error(`\n[setInternalAdminClaim] ERROR: ${msg}\n`);
  process.exit(code);
}

if (!TARGET_UID && !TARGET_EMAIL) {
  die(
    "Provide exactly one of --target-uid=<uid> or --target-email=<email>.\n" +
    "Example: node setInternalAdminClaim.cjs --target-email=name@peakops.io",
  );
}
if (TARGET_UID && TARGET_EMAIL) {
  die("Specify either --target-uid OR --target-email, not both.");
}

function loadServiceAccount() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;
  let raw = json || (b64 ? Buffer.from(b64, "base64").toString("utf8") : null);
  if (!raw) {
    // PEAKOPS_SLICE17C_SA_FILE_PRIORITY_V1 (2026-05-07)
    // Prefer ./.secrets/sa.json (the current key) over the legacy
    // repo-root ./sa.json (older, often revoked).
    try { raw = fs.readFileSync("./.secrets/sa.json", "utf8"); } catch (_e) { /* try next */ }
    if (!raw) {
      try { raw = fs.readFileSync("./sa.json", "utf8"); } catch (_e) { /* no fallback */ }
    }
  }
  if (!raw) return null;
  const sa = JSON.parse(raw);
  if (sa.private_key && sa.private_key.includes("\\n")) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  return sa;
}

const useAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE);
const sa = useAdc ? null : loadServiceAccount();
if (!useAdc && !sa) {
  die(
    "No credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SA_JSON_BASE64,\n" +
    "or place a service-account JSON at ./sa.json. ADC also works via GOOGLE_APPLICATION_CREDENTIALS.",
  );
}

const projectId = sa
  ? String(sa.project_id || "")
  : String(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "");

if (!projectId) {
  die("Could not determine projectId from credentials. Refusing to proceed without one.");
}

// Refuse to elevate against demo / emulator projects. They don't
// need the claim — bootstrapPilotOrgV1 accepts any caller in
// emulator mode.
const looksLikeDemo = /demo|emu|emulator/i.test(projectId);
if (looksLikeDemo) {
  die(
    `Refusing to set peakopsInternalAdmin against project '${projectId}' — looks like demo/emulator.\n` +
    "bootstrapPilotOrgV1 accepts any caller in emulator mode; this claim is a production-only gate.",
  );
}

admin.initializeApp({
  credential: useAdc
    ? admin.credential.applicationDefault()
    : admin.credential.cert(sa),
  projectId,
});

(async () => {
  // Resolve the user record up front so we can show the operator
  // exactly who they are about to modify.
  let userRecord;
  try {
    userRecord = TARGET_UID
      ? await admin.auth().getUser(TARGET_UID)
      : await admin.auth().getUserByEmail(TARGET_EMAIL);
  } catch (e) {
    die(`Could not look up user: ${(e && e.message) || e}`);
  }

  const existing = userRecord.customClaims || {};
  const alreadyAdmin = existing.peakopsInternalAdmin === true;

  console.log("");
  console.log("===============================================================");
  console.log("  setInternalAdminClaim — Phase 1 Slice 16");
  console.log("===============================================================");
  console.log(`  Project   : ${projectId}`);
  console.log(`  Action    : ${FLAG_REVOKE ? "REVOKE peakopsInternalAdmin" : "GRANT peakopsInternalAdmin"}`);
  console.log(`  Target uid: ${userRecord.uid}`);
  console.log(`  Target em : ${userRecord.email || "(no email)"}`);
  console.log(`  Currently : peakopsInternalAdmin = ${alreadyAdmin}`);
  console.log(`  Existing  : ${JSON.stringify(existing)}`);
  console.log(`  Mode      : ${FLAG_APPLY ? "APPLY (will write)" : "DRY-RUN (no write)"}`);
  console.log("===============================================================");

  // Compute the next claims object. Merge with existing so we don't
  // strip orgIds / role / anything else previously minted.
  const nextClaims = { ...existing };
  if (FLAG_REVOKE) {
    delete nextClaims.peakopsInternalAdmin;
  } else {
    nextClaims.peakopsInternalAdmin = true;
  }

  // No-op short-circuits.
  if (!FLAG_REVOKE && alreadyAdmin) {
    console.log("\nNo change: target already has peakopsInternalAdmin=true.\n");
    process.exit(0);
  }
  if (FLAG_REVOKE && !alreadyAdmin) {
    console.log("\nNo change: target does not have peakopsInternalAdmin set.\n");
    process.exit(0);
  }

  if (!FLAG_APPLY) {
    console.log("\nDry-run only. Re-run with --apply to write the claim above.\n");
    process.exit(0);
  }

  try {
    await admin.auth().setCustomUserClaims(userRecord.uid, nextClaims);
    console.log(
      FLAG_REVOKE
        ? `\nRevoked peakopsInternalAdmin from ${userRecord.uid}.`
        : `\nGranted peakopsInternalAdmin=true to ${userRecord.uid}.`,
    );
    console.log("Target must sign out + back in (or call getIdToken(true)) for the claim to take effect.\n");
    process.exit(0);
  } catch (e) {
    die(`setCustomUserClaims failed: ${(e && e.message) || e}`);
  }
})();
