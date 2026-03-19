import { getDb } from '../lib/admin.mjs';
export async function getFinalizedMeta(req, res) {
  try {
    const db = getDb();
    const id = req.params.id;
    const snap = await db.collection('submissions').doc(id).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:'not_found' });
    const s = snap.data();
    return res.json({ ok:true, status: s.status || null, filed_at: s.filed_at || null, artifacts: s.artifacts || null });
  } catch (e) {
    console.error('finalized meta error', e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
}
