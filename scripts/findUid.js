// scripts/findUid.js
const admin = require('firebase-admin');
const fs = require('fs');

function loadSA() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;
  let raw = json || (b64 ? Buffer.from(b64,'base64').toString('utf8') : null);
  if (!raw) raw = fs.readFileSync('./sa.json','utf8');
  const sa = JSON.parse(raw);
  if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g,'\n');
  return sa;
}
admin.initializeApp({ credential: admin.credential.cert(loadSA()) });

(async () => {
  const email = process.argv[2];
  if (!email) { console.error('Usage: node scripts/findUid.js <email>'); process.exit(1); }
  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  if (!user) { console.error('No user found for', email); process.exit(2); }
  console.log('UID:', user.uid);
  process.exit(0);
})();
