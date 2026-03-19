// functions/controllers/oe417.mjs
import { getDb } from '../lib/admin.mjs';
import { loadRulePack, validatePayload } from '../../src/rules/loader.mjs';

/**
 * POST /v1/prefile/oe417
 * Body: { orgId?: string, payload: object, extras?: object }
 */
export async function handleOE417(req, res) {
  try {
    const db = getDb();
    const { orgId, payload = {}, extras = {} } = req.body || {};

    // Normalize: always copy tz into timezone (overwrite if both are present)
    const norm = { ...payload };
    if (Object.prototype.hasOwnProperty.call(norm, 'tz')) {
      norm.timezone = norm.tz;
    }

    // Load rules and validate normalized payload
    const pack = await loadRulePack('BABA_SAR', new Date(), orgId);
    const pre = validatePayload(pack, norm, extras);

    if (!pre.passed) {
      return res.status(422).json({ ok: false, issues: pre });
    }

    // Persist with stamped rules
    const submission = {
      regulator: 'BABA_SAR',
      org_id: orgId || null,
      payload: norm,
      preflight: pre,
      rule_pack: {
        regulator: 'BABA_SAR',
        version_id: pack.version_id,
        pack_hash: pack.pack_hash || null,
        cfr_refs: pack.cfr_refs || [],
        codelists: pack.codelist_refs || []
      },
      created_at: new Date().toISOString()
    };

    const docRef = await db.collection('submissions').add(submission);
    return res.json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error('OE-417 error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

export const handleBabaSarPrefile = handleOE417;
