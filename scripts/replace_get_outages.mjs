import fs from 'fs';
const FILE='functions/server.mjs';
let s=fs.readFileSync(FILE,'utf8');

const GET_RE = /app\.get\(\s*['"]\/v1\/telecom\/outages['"][\s\S]*?\}\);\s*/m;
s = s.replace(GET_RE, ''); // drop any old simple GET

const idx = s.lastIndexOf('export default app');
if (idx === -1) { console.error('❌ missing "export default app"'); process.exit(1); }

const GET_BLOCK = `
// ---- GET /v1/telecom/outages?limit=25&status=open&region=PNW&cursor=<docId>
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
      const curSnap = await db.collection('telecom_outages').doc(cursor).get();
      if (curSnap.exists) q = q.startAfter(curSnap);
    }

    const snap = await q.get();
    const items = []; snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    const nextCursor = items.length === limit ? items[items.length - 1].id : null;

    res.json({ ok:true, count: items.length, nextCursor, items });
  } catch (e) {
    console.error('outages list error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
`;

const out = s.slice(0, idx) + GET_BLOCK + '\n' + s.slice(idx);
fs.writeFileSync(FILE, out);
console.log('✅ Replaced GET /v1/telecom/outages with filtered+cursor version');
