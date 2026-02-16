import { getFirestore } from 'firebase-admin/firestore';
import express from 'express';
import { loadRulePack, validatePayload } from '../src/rules/loader.mjs';

if (!process.env.FUNCTIONS_EMULATOR && !global._admin) {
  global._admin = true;
}
const db = getFirestore();
const app = express();
app.use(express.json());

app.post('/prefile/dirs', async (req, res) => {
  try {
    const { orgId, payload, extras } = req.body || {};
    const pack = await loadRulePack('FCC_DIRS', new Date(), orgId);
    const pre = validatePayload(pack, payload, extras || {});
    if (!pre.passed) return res.status(422).json({ ok:false, issues: pre });

    const submission = {
      regulator: 'FCC_DIRS',
      payload,
      preflight: pre,
      rule_pack: {
        regulator: 'FCC_DIRS',
        version_id: pack.version_id,
        pack_hash: pack.pack_hash || null,
        cfr_refs: pack.cfr_refs || [],
        codelists: pack.codelist_refs || []
      },
      created_at: new Date().toISOString()
    };

    const doc = await db.collection('submissions').add(submission);
    return res.json({ ok:true, id: doc.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

export default app;
