import fs from 'fs';
const FILE='functions/server.mjs';
let s=fs.readFileSync(FILE,'utf8');

s = s.replace(/import\s*{[^}]*}\s*from\s*['"]@google-cloud\/firestore['"]\s*;\s*/g,'');
if (!s.includes("import { Firestore, Timestamp } from '@google-cloud/firestore';")) {
  if (/(import\s+.*helmet.*?;\s*\n)/.test(s)) {
    s = s.replace(/(import\s+.*helmet.*?;\s*\n)/, `$1import { Firestore, Timestamp } from '@google-cloud/firestore';\n`);
  } else {
    s = s.replace(/(import[\s\S]*?;\s*\n)/, `$1import { Firestore, Timestamp } from '@google-cloud/firestore';\n`);
  }
}
if (!/new\s+Firestore\(/.test(s)) {
  s = s.replace(/const\s+app\s*=\s*express\(\)\s*;\s*\n/, m => m + `
/* ---- Firestore client ---- */
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const db = new Firestore({ projectId: GCLOUD_PROJECT });
`);
}
for (const re of [
  /app\.get\(\s*['"]\/v1\/telecom\/outages['"][\s\S]*?\}\);\s*/g,
  /app\.patch\(\s*['"]\/v1\/telecom\/outages\/:id['"][\s\S]*?\}\);\s*/g
]) s = s.replace(re,'');
const idx = s.lastIndexOf('export default app');
if (idx === -1) { console.error('missing "export default app"'); process.exit(1); }
app.get('/v1/telecom/outages', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '25', 10), 200);
    const status = req.query.status;
    const region = req.query.region;
    const cursor = req.query.cursor;

    let q = db.collection('telecom_outages');
    if (status) q = q.where('status','==', status);
    if (region) q = q.where('region','==', region);

    q = q.orderBy('created_at','desc').limit(limit);

    if (cursor) {
      const cur = await db.collection('telecom_outages').doc(cursor).get();
      if (cur.exists) q = q.startAfter(cur);
    }

    const snap = await q.get();
    const items = []; snap.forEach(d => items.push({ id:d.id, ...d.data() }));
    const nextCursor = items.length === limit ? items[items.length-1].id : null;

    res.json({ ok:true, count: items.length, nextCursor, items });
  } catch (e) {
    console.error('outages list error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
app.patch('/v1/telecom/outages/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const ref = db.collection('telecom_outages').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:'not_found', id });

    const allowed = ['status','region','title','meta'];
    const update = {};
    for (const k of allowed) if (k in body) update[k] = body[k];

    if (update.title && !update.title.toString().trim()) return res.status(400).json({ ok:false, error:'title_required' });
    if (update.status && !['open','closed'].includes(update.status)) return res.status(400).json({ ok:false, error:'invalid_status' });
    if (update.status === 'closed') update.closed_at = Timestamp.now();
    if (!Object.keys(update).length) return res.status(400).json({ ok:false, error:'no_valid_fields' });

    await ref.set(update, { merge:true });
    res.json({ ok:true, id, update });
  } catch (e) {
    console.error('patch error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
`;
s = s.slice(0, idx) + BLOCK + '\n' + s.slice(idx);
fs.writeFileSync(FILE, s);
console.log('patched routes');
