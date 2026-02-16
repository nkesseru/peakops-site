import { getDb } from '../lib/admin.mjs';
export async function getRulepack(req,res){
  try{
    const id = `${req.params.regulator}@${req.params.version}`;
    const snap = await getDb().collection('rulepacks').doc(id).get();
    if(!snap.exists) return res.status(404).json({ ok:false, error:'rulepack_not_found', id });
    return res.json({ ok:true, id, rulepack: snap.data() });
  }catch(e){ return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) }); }
}
