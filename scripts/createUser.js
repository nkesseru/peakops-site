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
  const [email, password] = process.argv.slice(2);
  if (!email || !password) { console.error('Usage: node scripts/createUser.js <email> <password>'); process.exit(1); }
  const u = await admin.auth().createUser({ email, password });
  console.log('Created UID:', u.uid);
  process.exit(0);
})();
