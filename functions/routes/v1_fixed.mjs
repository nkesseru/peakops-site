import express from 'express';
const api = express.Router();

/* ------------- _routes (introspection) ------------- */
api.get('/_routes', (_req, res) => {
  res.json({
    ok: true,
    routes: [
      { path: '/_routes', methods: ['get'] },
      { path: '/_env/slack', methods: ['get'] },
      { path: '/alerts/ping', methods: ['post'] },
      { path: '/alerts/scan', methods: ['post'] },
      { path: '/alerts/digest', methods: ['post'] }
    ]
  });
});

/* ------------- Env check ------------- */
api.get('/_env/slack', (req,res)=>{
  const v = process.env.SLACK_WEBHOOK_URL;
  res.json({ ok: !!v, len: v ? v.length : 0 });
});

/* ------------- Slack ping (container → Slack) ------------- */
api.post('/alerts/ping', async (req,res)=>{
  try{
    const url = process.env.SLACK_WEBHOOK_URL;
    if(!url) return res.status(200).json({ ok:false, reason:'missing SLACK_WEBHOOK_URL' });
    const doFetch = (typeof fetch === 'function') ? fetch : (await import('node-fetch')).default;
    const r = await doFetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text:`✅ PeakOps Slack ping @ ${new Date().toISOString()}`})
    });
    return res.json({ ok:r.ok, status:r.status });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ------------- Alerts: scan / digest ------------- */
api.post('/alerts/scan', async (req,res)=>{
  try{
    const { scanDeadlines } = await import('../controllers/alerts_scan.mjs');
    return scanDeadlines(req,res);
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) });
  }
});

api.post('/alerts/digest', async (req,res)=>{
  try{
    const { dailyDigest } = await import('../controllers/alerts_digest.mjs');
    return dailyDigest(req,res);
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) });
  }
});

/* ------------- Env check (temp) ------------- */
api.get('/_env/slack', (req,res)=>{
  const v = process.env.SLACK_WEBHOOK_URL;
  res.json({ ok: !!v, len: v ? v.length : 0 });
});

/* ------------- Alerts: ping (container → Slack) ------------- */
api.post('/alerts/ping', async (req,res)=>{
  try{
    const url = process.env.SLACK_WEBHOOK_URL;
    if(!url) return res.status(200).json({ ok:false, reason:'missing SLACK_WEBHOOK_URL' });
    const doFetch = (typeof fetch === 'function') ? fetch : (await import('node-fetch')).default;
    const r = await doFetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text:`✅ PeakOps Slack ping @ ${new Date().toISOString()}`})
    });
    return res.json({ ok:r.ok, status:r.status });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ------------- Env check (temp) ------------- */
api.get('/_env/slack', (req,res)=>{
  const v = process.env.SLACK_WEBHOOK_URL;
  res.json({ ok: !!v, len: v ? v.length : 0 });
});

/* ------------- Alerts: ping (container → Slack) ------------- */
api.post('/alerts/ping', async (req,res)=>{
  try{
    const url = process.env.SLACK_WEBHOOK_URL;
    if(!url) return res.status(200).json({ ok:false, reason:'missing SLACK_WEBHOOK_URL' });
    const doFetch = (typeof fetch === 'function') ? fetch : (await import('node-fetch')).default;
    const r = await doFetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text:`✅ PeakOps Slack ping @ ${new Date().toISOString()}`})
    });
    return res.json({ ok:r.ok, status:r.status });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ------------- Alerts: Daily Digest (PDF) ------------- */
api.get('/alerts/digest.pdf', async (req,res)=>{
  try{
    const { digestPDF } = await import('../controllers/alerts_digest_pdf.mjs');
    return digestPDF(req,res);
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) });
  }
});

/* ------------- Alerts: Daily Digest (PDF) ------------- */
api.get('/alerts/digest.pdf', async (req,res)=>{
  try{
    const { digestPDF } = await import('../controllers/alerts_digest_pdf.mjs');
    return digestPDF(req,res);
  }catch(e){
    console.error(e);
    return res.status(500).json({ ok:false, error:'internal_error', detail:String(e) });
  }
});

export default api;
