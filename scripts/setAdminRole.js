import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const [,,uid, orgId] = process.argv;
if (!uid || !orgId) {
  console.error('Usage: node setAdminRole.js <uid> <orgId>');
  process.exit(1);
}
const claims = { role: 'admin', orgId };
await getAuth().setCustomUserClaims(uid, claims);
console.log('✅ set claims for', uid, claims);
