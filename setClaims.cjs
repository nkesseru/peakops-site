const fs = require('fs');
const admin = require('firebase-admin');

function loadSA() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;
  let raw = json || (b64 ? Buffer.from(b64,'base64').toString('utf8') : null);
  if (!raw) raw = fs.readFileSync('./sa.json','utf8'); // fallback
  const sa = JSON.parse(raw);
  if (sa.private_key?.includes('\\n')) {
    sa.private_key = sa.private_key.replace(/\\n/g,'\n');
  }
  return sa;
}

const sa = loadSA();
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });

(async () => {
  const [uid, orgId, role] = process.argv.slice(2);
  if (!uid || !orgId || !role) {
    console.error('Usage: node setClaims.js <UID> <ORG_ID> <role>');
    process.exit(1);
  }
  await admin.auth().setCustomUserClaims(uid, { orgId, role });
  console.log(`✅ Claims set for ${uid}: { orgId: ${orgId}, role: ${role} }`);
  process.exit(0);
})();
