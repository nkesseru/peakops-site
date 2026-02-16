import { getDb } from '../lib/admin.mjs';

const SLACK_URL = process.env.SLACK_WEBHOOK_URL || '';

async function postSlack(text) {
  if (!SLACK_URL) return { ok:false, reason:'missing_env' };
  const payload = { text };
  try {
    // Ensure fetch exists (Node 18+ has it; else fallback)
    const doFetch = (typeof fetch === 'function') ? fetch : (await import('node-fetch')).default;
    const r = await doFetch(SLACK_URL, {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

export async function dailyDigest(_req, res) {
  const db = getDb();
  const now = Date.now();
  const since = now - 24*3600*1000;

  const subs = await db.collection('submissions')
    .where('status','in',['DRAFT','PREFLIGHT_PASS','PREFLIGHT_FAIL']).get();

  const byReg={}, byRule={}; let count=0;
  for (const doc of subs.docs) {
    const s=doc.data()||{};
    const laAt=s.last_alert?.at ? Date.parse(s.last_alert.at) : 0;
    if(!laAt || laAt < since) continue;
    count++;
    const reg=s.regulator||'UNKNOWN';
    const rule=s.last_alert?.rule || 'unknown_rule';
    byReg[reg]=(byReg[reg]||0)+1;
    const key=`${reg}::${rule}`;
    byRule[key]=(byRule[key]||0)+1;
  }

  const lines=[];
  lines.push(`📣 *Daily RegOps Digest* (last 24h)`);
  lines.push(`Total alerts: *${count}*`);
  if(count){
    lines.push(`\n*By regulator:*`);
    Object.entries(byReg).forEach(([k,v])=>lines.push(`• ${k}: ${v}`));
    lines.push(`\n*By rule:*`);
    Object.entries(byRule).forEach(([k,v])=>{
      const [reg,rule]=k.split('::');
      lines.push(`• ${reg} / ${rule}: ${v}`);
    });
  }else{
    lines.push(`No alerts fired in the last 24 hours ✅`);
  }

  const slack = await postSlack(lines.join('\n'));
  return res.json({ ok:true, count, byReg, byRule, slack });
}
