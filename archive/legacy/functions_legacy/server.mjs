/**
 * PeakOps API — middleware → routes → 404 → error → listener → export
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Firestore, Timestamp } from '@google-cloud/firestore';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 8080;
const GCLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

const app = express();

/* ===== runtime diagnostics ===== */
app.get("/__routes", (_req,res)=>{
  const list=[]; const push=(layer,base="")=>{
    if(layer.route?.path){
      const methods=Object.keys(layer.route.methods||{}).map(m=>m.toUpperCase());
      list.push({ path: base + layer.route.path, methods });
    }else if(layer.name==="router" && layer.handle?.stack){
      for(const l of layer.handle.stack) push(l, base);
    }
  };
  if(app._router?.stack) for(const l of app._router.stack) push(l,"");
  res.json({ ok:true, count:list.length, routes:list });
});
app.get("/__diag", (_req,res)=>res.json({
  ok:true,
  service:process.env.K_SERVICE||"local",
  revision:process.env.K_REVISION||"dev",
  project:process.env.GOOGLE_CLOUD_PROJECT||process.env.GCLOUD_PROJECT||"unknown",
  now:new Date().toISOString()
}));
/* ===== end diagnostics ===== */
const db = new Firestore({ projectId: GCLOUD_PROJECT });

// core middleware
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ===== Diagnostics ===== */
app.get('/__routes', (_req, res) => {
  const list = [];
  const push = (layer, base = '') => {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods || {}).map(m => m.toUpperCase());
      list.push({ path: base + layer.route.path, methods });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      for (const l of layer.handle.stack) push(l, base);
    }
  };
  if (app._router?.stack) for (const l of app._router.stack) push(l, '');
  res.json({ ok: true, count: list.length, routes: list });
});

app.get('/__diag', (_req, res) => {
  res.json({
    ok: true,
    service: process.env.K_SERVICE || 'local',
    revision: process.env.K_REVISION || 'dev',
    project: GCLOUD_PROJECT || 'unknown',
    now: new Date().toISOString()
  });
});
/* ===== End Diagnostics ===== */

/* ===== Firestore: telecom_outages ===== */

// quick DB ping
app.get('/__db', async (_req, res) => {
  try {
    const t0 = Date.now();
    await db.listCollections();
    res.json({ ok: true, project: GCLOUD_PROJECT || 'unknown', ms: Date.now() - t0 });
  } catch (e) {
    console.error('DB ping error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});


/* 404 LAST */
app.use((req, res) => res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl }));

/* Error handler */
app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  res.status(status).json({ ok:false, error:'internal', message: NODE_ENV === 'production' ? undefined : String(err) });
});

/* Cloud Run listener */
if (!globalThis.__PEAKOPS_SERVER__) {
  globalThis.__PEAKOPS_SERVER__ = app.listen(PORT, '0.0.0.0', () => {
    console.log(`peakops server on :${PORT} env=${NODE_ENV}`);
  });
}


