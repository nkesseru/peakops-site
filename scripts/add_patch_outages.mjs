import fs from 'fs';
const FILE='functions/server.mjs';
let s=fs.readFileSync(FILE,'utf8');

if (s.includes("app.patch('/v1/telecom/outages/:id'")) {
  console.log('ℹ️  PATCH already present.'); process.exit(0);
}

const idx = s.lastIndexOf('export default app');
if (idx === -1) { console.error('❌ missing "export default app"'); process.exit(1); }

const BLOCK = `
// ---- PATCH /v1/telecom/outages/:id  (update allowed fields; auto-close sets closed_at)
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
      // Timestamp is imported via @google-cloud/firestore
      update.closed_at = (globalThis.Timestamp?.now?.() ?? new Date());
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

const out = s.slice(0, idx) + BLOCK + '\n' + s.slice(idx);
fs.writeFileSync(FILE, out);
console.log('✅ Added PATCH /v1/telecom/outages/:id');
