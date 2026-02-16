import { getDb } from '../lib/admin.mjs';
export async function getMetrics(_req,res){
  try{
    const db=getDb(); const out={ total:0, filed:0, draft:0, byReg:{} };
    const snap=await db.collection('submissions').get();
    out.total=snap.size;
    for (const d of snap.docs){
      const s=d.data()||{}; const r=s.regulator||'UNKNOWN';
      out.byReg[r]=(out.byReg[r]||0)+1;
      if (s.status==='FILED') out.filed++; else out.draft++;
    }
    return res.json({ ok:true, metrics:out });
  }catch(e){ return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) }); }
}
