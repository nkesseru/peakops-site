// functions/routes/v1.mjs
import express from 'express';
import { getDb } from '../lib/admin.mjs';
import { handleOE417 } from '../controllers/oe417.mjs';
import { getRulesMeta } from '../controllers/meta.mjs';
import { loadRulePack, validatePayload } from '../../src/rules/loader.mjs';

const api = express.Router();

// ---- DOE OE-417 ----
api.post('/prefile/oe417', handleOE417);

api.get('/prefile/oe417', async (_req, res, next) => {
  try {
    const db = getDb();
    const snap = await db.collection('submissions')
      .where('regulator', '==', 'DOE_OE417')
      .orderBy('created_at', 'desc')
      .limit(10).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, count: docs.length, docs });
  } catch (e) { next(e); }
});

// ---- FCC DIRS ----
api.post('/prefile/dirs', async (req, res, next) => {
  try {
    const db = getDb();
    const { orgId, payload, extras } = req.body || {};
    const pack = await loadRulePack('FCC_DIRS', new Date(), orgId);
    const pre = validatePayload(pack, payload || {}, extras || {});
    if (!pre.passed) return res.status(422).json({ ok: false, issues: pre });

    const doc = await db.collection('submissions').add({
      regulator: 'FCC_DIRS',
      payload, preflight: pre,
      rule_pack: {
        regulator: 'FCC_DIRS',
        version_id: pack.version_id,
        pack_hash: pack.pack_hash || null,
        cfr_refs: pack.cfr_refs || [],
        codelists: pack.codelist_refs || []
      },
      created_at: new Date().toISOString()
    });
    res.json({ ok: true, id: doc.id });
  } catch (e) { next(e); }
});

api.get('/prefile/dirs', async (_req, res, next) => {
  try {
    const db = getDb();
    const snap = await db.collection('submissions')
      .where('regulator', '==', 'FCC_DIRS')
      .orderBy('created_at', 'desc')
      .limit(10).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, count: docs.length, docs });
  } catch (e) { next(e); }
});

// ---- Rules meta ----
api.get('/meta/rules/:regulator', getRulesMeta);

export default api;
