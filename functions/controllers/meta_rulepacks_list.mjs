import { getDb } from '../lib/admin.mjs';
export async function listRulepacks(_req,res){
  try{
    const snap = await getDb().collection('rulepacks').get();
    const packs = snap.docs.map(d => {
      const v = d.data();
      return { id:d.id, regulator:v.regulator, version_id:v.version_id, active:!!v.active, pack_hash:v.pack_hash };
    });
    res.json({ ok:true, count:packs.length, packs });
  }catch(e){ res.status(500).json({ ok:false, error:'internal_error', detail:String(e) }); }
}
