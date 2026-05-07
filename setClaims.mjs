// setClaims.mjs — Firebase Admin v12 ESM (Slice 17C, 2026-05-07)
//
// ESM mirror of setClaims.cjs. See that file for the full design
// notes. Same semantics: writes { orgId, role, orgIds: [orgId] }
// merged with existing claims; preferred file fallback is
// ./.secrets/sa.json (the current key) over the legacy ./sa.json.

import fs from 'fs';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

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
  if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

const sa = loadSA();
console.log('Admin Project:', sa.project_id);
const useAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE);
initializeApp({
  credential: useAdc ? applicationDefault() : cert(sa),
  projectId: sa.project_id
});

const [uid, orgId, role] = process.argv.slice(2);
if (!uid || !orgId || !role) {
  console.error('Usage: node setClaims.mjs <UID> <ORG_ID> <role>');
  process.exit(1);
}

let existing = {};
try {
  const u = await getAuth().getUser(uid);
  existing = u.customClaims || {};
} catch (e) {
  console.error('Failed to look up user:', (e && e.message) || e);
  process.exit(1);
}

const next = { ...existing, orgId, role, orgIds: [orgId] };

try {
  await getAuth().setCustomUserClaims(uid, next);
} catch (e) {
  console.error('setCustomUserClaims failed:', (e && e.message) || e);
  process.exit(1);
}

console.log(`Claims set for ${uid}`);
console.log(`  before: ${JSON.stringify(existing)}`);
console.log(`  after : ${JSON.stringify(next)}`);
console.log('Target must sign out + back in (or call getIdToken(true)) for the claim to take effect.');
