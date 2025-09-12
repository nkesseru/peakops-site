// setClaims.mjs — Firebase Admin v12 ESM
import fs from 'fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function loadSA() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;
  let raw = json || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : null);
  if (!raw) raw = fs.readFileSync('./sa.json', 'utf8'); // optional local fallback
  const sa = JSON.parse(raw);
  if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

const sa = loadSA();
console.log('Admin Project:', sa.project_id);       // 👈 DIAGNOSTIC
initializeApp({ credential: cert(sa), projectId: sa.project_id });

const [uid, orgId, role] = process.argv.slice(2);
if (!uid || !orgId || !role) {
  console.error('Usage: node setClaims.mjs <UID> <ORG_ID> <role>');
  process.exit(1);
}

try {
  await getAuth().setCustomUserCustomClaims(uid, { orgId, role });
  // ^ setCustomUserCustomClaims works in v12; if your installed version needs setCustomUserClaims, use that.
} catch {
  await getAuth().setCustomUserClaims(uid, { orgId, role });
}
console.log(`✅ Claims set for ${uid}: { orgId: ${orgId}, role: ${role} }`);
