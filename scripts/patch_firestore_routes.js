const fs = require('fs');

const path = 'functions/server.mjs';
let s = fs.readFileSync(path, 'utf8');
let changed = false;

// --- 1) Import Firestore after helmet import (or anywhere near top if not found)
if (!s.includes("@google-cloud/firestore")) {
  const helmetRe = /(import\s+.*helmet.*?;\s*\n)/;
  if (helmetRe.test(s)) {
    s = s.replace(helmetRe, `$1import { Firestore } from '@google-cloud/firestore';\n`);
  } else {
    // fallback: add after first import block
    const firstImportRe = /(import[\s\S]*?;\s*\n)/;
    s = s.replace(firstImportRe, `$1import { Firestore } from '@google-cloud/firestore';\n`);
  }
  changed = true;
}

// --- 2) Client init right after const app = express();
if (!/new\s+Firestore\(/.test(s)) {
  const appLineRe = /(const\s+app\s*=\s*express\(\)\s*;\s*\n)/;
  if (!appLineRe.test(s)) {
    console.error('❌ Could not find "const app = express();" – aborting to avoid corrupting file.');
    process.exit(1);
  }
  const initBlock =
`\n// ---- Firestore client (uses Cloud Run SA, no keys)
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const db = new Firestore({ projectId: GCLOUD_PROJECT });
`;
  s = s.replace(appLineRe, `$1${initBlock}`);
  changed = true;
}

// --- 3) Insert routes above the 404 handler
if (!s.includes('app.get("/__db"')) {
  // Find the 404 handler line
  const notFoundRe = /app\.use\(\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*res\.status\(\s*404\s*\)\.json\([\s\S]*?\)\s*\)\s*;\s*/;
  if (!notFoundRe.test(s)) {
    console.error('❌ Could not find the 404 app.use(...) handler – put routes near the end manually.');
    process.exit(1);
  }
  const routesBlock =
`
/* ===== Firestore diagnostics & telecom routes ===== */
// quick DB ping
app.get("/__db", async (_req, res) => {
  try {
    const t0 = Date.now();
    await db.listCollections();
    res.json({ ok: true, project: GCLOUD_PROJECT || "unknown", ms: Date.now() - t0 });
  } catch (e) {
    console.error("DB ping error", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// GET /v1/telecom/outages?limit=25  (adjust collection/field names if needed)
app.get("/v1/telecom/outages", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "25", 10), 200);
    const snap = await db.collection("telecom_outages")
      .orderBy("created_at", "desc")
      .limit(limit)
      .get();
    const items = [];
    snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    // Firestore will include an index URL when needed; build it once and retry
    console.error("outages list error", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});
/* ===== End Firestore block ===== */

`;
  s = s.replace(notFoundRe, routesBlock + '\n' + s.match(notFoundRe)[0]);
  changed = true;
}

if (!changed) {
  console.log('ℹ️  Nothing to change; Firestore import/init/routes already present.');
} else {
  fs.writeFileSync(path, s);
  console.log('✅ Patched Firestore import, client init, and routes.');
}
