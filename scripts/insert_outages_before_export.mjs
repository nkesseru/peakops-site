import fs from 'fs';

const FILE = 'functions/server.mjs';
let s = fs.readFileSync(FILE, 'utf8');
let changed = false;

/* 1) Ensure Firestore import includes Timestamp */
if (s.includes("@google-cloud/firestore")) {
  if (!/import\s*{\s*Firestore\s*,\s*Timestamp\s*}/.test(s)) {
    s = s.replace(
      /import\s*{\s*Firestore\s*}\s*from\s*['"]@google-cloud\/firestore['"]\s*;/,
      "import { Firestore, Timestamp } from '@google-cloud/firestore';"
    );
    changed = true;
  }
} else {
  // add after helmet import (fallback)
  s = s.replace(
    /(import\s+.*helmet.*?;\s*\n)/,
    `$1import { Firestore, Timestamp } from '@google-cloud/firestore';\n`
  );
  changed = true;
}

/* 2) Ensure Firestore client exists after const app = express(); */
if (!/new\s+Firestore\(/.test(s)) {
  const m = s.match(/const\s+app\s*=\s*express\(\)\s*;\s*\n/);
  if (!m) { console.error('❌ Could not find "const app = express();".'); process.exit(1); }
  const block = `
/* ---- Firestore client (Cloud Run SA; no keys) ---- */
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const db = new Firestore({ projectId: GCLOUD_PROJECT });
`;
  s = s.replace(m[0], m[0] + block);
  changed = true;
}

/* 3) Remove any previous definitions of these routes to avoid duplicates */
const kill = [
  /app\.get\(\s*['"]\/v1\/telecom\/outages['"][\s\S]*?\}\);\s*/g,
  /app\.post\(\s*['"]\/v1\/telecom\/outages:ingest['"][\s\S]*?\}\);\s*/g,
  /app\.patch\(\s*['"]\/v1\/telecom\/outages\/:id['"][\s\S]*?\}\);\s*/g,
  /app\.get\(\s*['"]\/__db['"][\s\S]*?\}\);\s*/g
];
for (const re of kill) if (re.test(s)) { s = s.replace(re, ''); changed = true; }

/* 4) Insert our canonical block immediately before "export default app;" */
const idx = s.lastIndexOf('export default app');
if (idx === -1) { console.error('❌ Could not find "export default app;"'); process.exit(1); }

const ROUTES = `
/* ===== Firestore diagnostics & telecom outages ===== */
// Firestore ping
app.get('/__db', async (_req, res) => {
  try {
    const t0 = Date.now();
    await db.listCollections();
    res.json({ ok:true, project: GCLOUD_PROJECT || 'unknown', ms: Date.now() - t0 });
  } catch (e) {
    console.error('DB ping error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// GET /v1/telecom/outages?limit=25&status=open&region=PNW&cursor=<docId>
app.get('/v1/telecom/outages', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '25', 10), 200);
    const status = req.query.status;
    const region = req.query.region;
    const cursor = req.query.cursor;

    let q = db.collection('telecom_outages');
    if (status) q = q.where('status', '==', status);
    if (region) q = q.where('region', '==', region);

    q = q.orderBy('created_at', 'desc').limit(limit);

    if (cursor) {
      const curSnap = await db.collection('telecom_outages').doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }

    const snap = await q.get();
    const items = [];
    snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    const nextCursor = items.length === limit ? items[items.length - 1].id : null;

    res.json({ ok:true, count: items.length, nextCursor, items });
  } catch (e) {
    console.error('outages list error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// POST /v1/telecom/outages:ingest  (quick seed / inbound)
app.post('/v1/telecom/outages:ingest', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const payload = {
      title: (body.title || 'Test outage').toString(),
      status: body.status || 'open',
      region: body.region || 'unknown',
      created_at: typeof Timestamp !== 'undefined' ? Timestamp.now() : new Date(),
      meta: body.meta || {}
    };
    if (!payload.title.trim()) return res.status(400).json({ ok:false, error:'title_required' });
    if (!['open','closed'].includes(payload.status)) return res.status(400).json({ ok:false, error:'invalid_status' });

    const ref = await db.collection('telecom_outages').add(payload);
    res.json({ ok:true, id: ref.id, item: payload });
  } catch (e) {
    console.error('ingest error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// PATCH /v1/telecom/outages/:id  (update fields; auto-close sets closed_at)
app.patch('/v1/telecom/outages/:id', async (req, res) => {
  try {
    const id   = req.params.id;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ref  = db.collection('telecom_outages').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:'not_found', id });

    const allowed = ['status','region','title','meta'];
    const update  = {};
    for (const k of allowed) if (k in body) update[k] = body[k];

    if (update.status === 'closed') {
      update.closed_at = typeof Timestamp !== 'undefined' ? Timestamp.now() : new Date();
    }
    if (update.title && !update.title.toString().trim()) {
      return res.status(400).json({ ok:false, error:'title_required' });
    }
    if (update.status && !['open','closed'].includes(update.status)) {
      return res.status(400).json({ ok:false, error:'invalid_status' });
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ ok:false, error:'no_valid_fields' });
    }

    await ref.set(update, { merge:true });
    res.json({ ok:true, id, update });
  } catch (e) {
    console.error('patch error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
/* ===== End Firestore block ===== */
`;

// splice in before export
s = s.slice(0, idx) + ROUTES + '\n' + s.slice(idx);
fs.writeFileSync(FILE, s);
console.log('✅ Inserted outages routes before "export default app;".');
