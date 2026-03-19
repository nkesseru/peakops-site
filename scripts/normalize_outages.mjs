import fs from 'fs';
const FILE='functions/server.mjs'; let s=fs.readFileSync(FILE,'utf8'); let ch=false;

// Ensure single Firestore import with Timestamp
s = s
  .replace(/import\s*{\s*Firestore\s*,\s*Timestamp\s*}[^;]*;?/g, m => (ch=true, ''))
  .replace(/import\s*{\s*Firestore\s*}[^;]*;?/g, m => (ch=true, ''))
  .replace(/(import\s+.*helmet.*?;\s*\n)/, `$1import { Firestore, Timestamp } from '@google-cloud/firestore';\n`);

// Ensure client exists after app
if (!/new\s+Firestore\(/.test(s)) {
  s = s.replace(/const\s+app\s*=\s*express\(\)\s*;\s*\n/, m => m + `
/* ---- Firestore client ---- */
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const db = new Firestore({ projectId: GCLOUD_PROJECT });
`);
  ch=true;
}

// Kill any previous definitions to avoid duplicates
const killers = [
  /app\.get\(\s*['"]\/__db['"][\s\S]*?\}\);\s*/g,
  /app\.get\(\s*['"]\/v1\/telecom\/outages['"][\s\S]*?\}\);\s*/g,
  /app\.post\(\s*['"]\/v1\/telecom\/outages:ingest['"][\s\S]*?\}\);\s*/g,
  /app\.patch\(\s*['"]\/v1\/telecom\/outages\/:id['"][\s\S]*?\}\);\s*/g
];
for (const re of killers) s = s.replace(re, m => (ch=true, ''));

// Insert canonical block right before export
const idx = s.lastIndexOf('export default app');
if (idx === -1) { console.error('❌ missing "export default app"'); process.exit(1); }
const BLOCK = `
/* ===== Firestore diagnostics & telecom outages ===== */
app.get('/__db', async (_req,res)=>{try{const t0=Date.now();await db.listCollections();res.json({ok:true,project:GCLOUD_PROJECT||'unknown',ms:Date.now()-t0});}catch(e){console.error('DB ping error',e);res.status(500).json({ok:false,error:String(e)})}});

app.get('/v1/telecom/outages', async (req,res)=>{try{
  const limit=Math.min(parseInt(req.query.limit||'25',10),200);
  const status=req.query.status, region=req.query.region, cursor=req.query.cursor;
  let q=db.collection('telecom_outages');
  if(status) q=q.where('status','==',status);
  if(region) q=q.where('region','==',region);
  q=q.orderBy('created_at','desc').limit(limit);
  if(cursor){const cur=await db.collection('telecom_outages').doc(cursor).get(); if(cur.exists) q=q.startAfter(cur);}
  const snap=await q.get(); const items=[]; snap.forEach(d=>items.push({id:d.id,...d.data()}));
  const nextCursor=items.length===limit?items[items.length-1].id:null;
  res.json({ok:true,count:items.length,nextCursor,items});
}catch(e){console.error('outages list error',e);res.status(500).json({ok:false,error:String(e)})}});

app.post('/v1/telecom/outages:ingest', async (req,res)=>{try{
  const b=(req.body&&typeof req.body==='object')?req.body:{};
  const payload={title:(b.title||'Test outage').toString(),status:b.status||'open',region:b.region||'unknown',created_at:Timestamp.now?.()||new Date(),meta:b.meta||{}};
  if(!payload.title.trim()) return res.status(400).json({ok:false,error:'title_required'});
  if(!['open','closed'].includes(payload.status)) return res.status(400).json({ok:false,error:'invalid_status'});
  const ref=await db.collection('telecom_outages').add(payload); res.json({ok:true,id:ref.id,item:payload});
}catch(e){console.error('ingest error',e);res.status(500).json({ok:false,error:String(e)})}});

app.patch('/v1/telecom/outages/:id', async (req,res)=>{try{
  const id=req.params.id; const b=(req.body&&typeof req.body==='object')?req.body:{};
  const ref=db.collection('telecom_outages').doc(id); const snap=await ref.get();
  if(!snap.exists) return res.status(404).json({ok:false,error:'not_found',id});
  const allowed=['status','region','title','meta']; const update={}; for(const k of allowed) if(k in b) update[k]=b[k];
  if(update.title && !update.title.toString().trim()) return res.status(400).json({ok:false,error:'title_required'});
  if(update.status && !['open','closed'].includes(update.status)) return res.status(400).json({ok:false,error:'invalid_status'});
  if(update.status==='closed') update.closed_at=Timestamp.now?.()||new Date();
  if(!Object.keys(update).length) return res.status(400).json({ok:false,error:'no_valid_fields'});
  await ref.set(update,{merge:true}); res.json({ok:true,id,update});
}catch(e){console.error('patch error',e);res.status(500).json({ok:false,error:String(e)})}});
/* ===== End Firestore block ===== */
`;
const out = s.slice(0, idx) + BLOCK + '\n' + s.slice(idx);
fs.writeFileSync(FILE, out);
console.log('✅ Normalized Firestore imports + outages routes; inserted before export.');
