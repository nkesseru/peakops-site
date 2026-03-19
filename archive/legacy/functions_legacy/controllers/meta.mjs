import { loadRulePack } from '../../src/rules/loader.mjs';

export async function getRulesMeta(req, res) {
  try {
    const { regulator } = req.params;
    const pack = await loadRulePack(regulator, new Date());
    res.json({
      ok: true,
      regulator,
      version_id: pack.version_id || null,
      pack_hash: pack.pack_hash || null,
      cfr_refs: pack.cfr_refs || [],
      codelist_refs: pack.codelist_refs || []
    });
  } catch (e) {
    res.status(404).json({ ok:false, error:'rules_not_found', message:String(e.message || e) });
  }
}
export { getRulesMeta as metaRules };
