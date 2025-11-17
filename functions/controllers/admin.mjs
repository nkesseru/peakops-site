import { getDb } from '../lib/admin.mjs';
export async function patchRulepack(req,res){
  try{
    const { regulator, version } = req.params;
    const body = req.body;
    if(!regulator || !version || !body) return res.status(400).json({ ok:false, error:'missing_params' });

    let text;
    if (Array.isArray(body)) text = JSON.stringify(body);
    else if (Array.isArray(body.required_fields)) text = JSON.stringify(body.required_fields);
    else if (typeof body.required_fields === 'string') text = body.required_fields;
    else return res.status(400).json({ ok:false, error:'required_fields_not_provided' });

    const id = `${regulator}@${version}`;
    await getDb().collection('rulepacks').doc(id).set({ required_fields: text }, { merge:true });
    const snap = await getDb().collection('rulepacks').doc(id).get();
    return res.json({ ok:true, id, required_fields: snap.data().required_fields ?? null });
  }catch(e){ return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) }); }
}
