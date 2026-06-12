// setClaims.cjs (Slice 17C, 2026-05-07)
//
// Mints { orgId, role, orgIds: [orgId] } on the target Firebase Auth
// uid. orgIds (plural array) is what next-app's enforceOrgAndProxy
// checks; orgId (singular) is preserved for backward compatibility
// with any code path that has not migrated to the array shape.
//
// MERGE semantics: existing custom claims (e.g. peakopsInternalAdmin
// set by setInternalAdminClaim.cjs) are preserved. Only orgId, role,
// and orgIds are overwritten on this call.
//
// Service-account loading order:
//   1. FIREBASE_SERVICE_ACCOUNT_JSON env var (full JSON string)
//   2. FIREBASE_SA_JSON_BASE64 env var
//   3. ./.secrets/sa.json (current key — preferred file fallback)
//   4. ./sa.json (legacy file fallback; this key is frequently
//      revoked in older checkouts)
// Or, if GOOGLE_APPLICATION_CREDENTIALS / K_SERVICE is set,
// applicationDefault() takes over and the file fallbacks are unused.

const fs = require('fs');
const admin = require('firebase-admin');

function loadSA() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;
  let raw = json || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : null);
  if (!raw) {
    if (fs.existsSync('./.secrets/sa.json')) {
      raw = fs.readFileSync('./.secrets/sa.json', 'utf8');
    } else if (fs.existsSync('./sa.json')) {
      raw = fs.readFileSync('./sa.json', 'utf8');
    } else {
      console.error('No service-account JSON found. Set FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SA_JSON_BASE64, or place sa.json at ./.secrets/sa.json or ./sa.json.');
      process.exit(1);
    }
  }
  const sa = JSON.parse(raw);
  if (sa.private_key?.includes('\\n')) {
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  }
  return sa;
}

const sa = loadSA();
const useAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE);
admin.initializeApp({
  credential: useAdc ? admin.credential.applicationDefault() : admin.credential.cert(sa),
  projectId: sa.project_id
});

(async () => {
  const [uid, orgId, role] = process.argv.slice(2);
  if (!uid || !orgId || !role) {
    console.error('Usage: node setClaims.cjs <UID> <ORG_ID> <role>');
    process.exit(1);
  }

  let existing = {};
  try {
    const u = await admin.auth().getUser(uid);
    existing = u.customClaims || {};
  } catch (e) {
    console.error('Failed to look up user:', (e && e.message) || e);
    process.exit(1);
  }

  const next = { ...existing, orgId, role, orgIds: [orgId] };

  await admin.auth().setCustomUserClaims(uid, next);
  console.log(`Claims set for ${uid}`);
  console.log(`  before: ${JSON.stringify(existing)}`);
  console.log(`  after : ${JSON.stringify(next)}`);
  console.log('Target must sign out + back in (or call getIdToken(true)) for the claim to take effect.');
  process.exit(0);
})();
