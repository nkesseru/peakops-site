import fs from 'fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function sa() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;
  let raw = json || (b64 ? Buffer.from(b64,'base64').toString('utf8') : fs.readFileSync('./sa.json','utf8'));
  const obj = JSON.parse(raw);
  if (obj.private_key?.includes('\\n')) obj.private_key = obj.private_key.replace(/\\n/g,'\n');
  return obj;
}
const obj = sa();
console.log('Admin Project:', obj.project_id);
initializeApp({ credential: cert(obj), projectId: obj.project_id });

const email = process.argv[2];
if (!email) { console.error('Usage: node scripts/findUid.mjs <email>'); process.exit(1); }
const user = await getAuth().getUserByEmail(email).catch(() => null);
if (!user) { console.error('No user for', email); process.exit(2); }
console.log('UID:', user.uid);
