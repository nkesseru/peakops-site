import fs from 'fs';

const FILE='functions/server.mjs';
let s = fs.readFileSync(FILE,'utf8');

// Ensure Firestore import includes Timestamp (single clean line)
s = s.replace(/import\s*{[^}]*}\s*from\s*['"]@google-cloud\/firestore['"]\s*;\s*/g,'');
if (!s.includes("import { Firestore, Timestamp } from '@google-cloud/firestore';")) {
  if (/(import\s+.*helmet.*?;\s*\n)/.test(s)) {
    s = s.replace(/(import\s+.*helmet.*?;\s*\n)/,
      `$1import { Firestore, Timestamp } from '@google-cloud/firestore';\n`);
  } else {
    s = s.replace(/(import[\s\S]*?;\s*\n)/,
      `$1import { Firestore, Timestamp } from '@google-cloud/firestore';\n`);
  }
}

// If PATCH already exists, exit quietly
if (s.includes("app.patch('/v1/telecom/outages/:id'")) {
  console.log('PATCH already present.'); process.exit(0);
}

// Insert PATCH before export default app
const idx = s.lastIndexOf('export default app');
if (idx === -1) { console.error('❌ missing "export default app"'); process.exit(1); }

const PATCH_BLOCK = `
// ---- PATCH /v1/telecom/outages/:id  (update fields; auto-close sets closed_at)
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

    if (update.title && !update.title.toString().trim()) {
      return res.status(400).json({ ok:false, error:'title_required' });
    }
    if (update.status && !['open','closed'].includes(update.status)) {
      return res.status(400).json({ ok:false, error:'invalid_status' });
    }
    if (update.status === 'closed') {
      update.closed_at = Timestamp.now();
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
`;

const out = s.slice(0, idx) + PATCH_BLOCK + '\n' + s.slice(idx);
fs.writeFileSync(FILE, out);
console.log('✅ Inserted PATCH route and normalized Firestore import.');
