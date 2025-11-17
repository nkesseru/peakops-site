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

// POST /v1/telecom/outages:ingest  (seed / inbound)
app.post('/v1/telecom/outages:ingest', async (req, res) => {
  try {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const payload = {
      title: (b.title || 'Test outage').toString(),
      status: b.status || 'open',
      region: b.region || 'unknown',
      created_at: Timestamp.now(),
      meta: b.meta || {}
    };
    if (!payload.title.trim()) return res.status(400).json({ ok:false, error:'title_required' });
    if (!['open','closed'].includes(payload.status)) return res.status(400).json({ ok:false, error:'invalid_status' });

    const ref = await db.collection('telecom_outages').add(payload);
    res.json({ ok: true, id: ref.id, item: payload });
  } catch (e) {
    console.error('ingest error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// GET /v1/telecom/outages?limit=25&status=open&region=PNW&cursor=<docId>
} catch (e) {
    console.error('outages list error', e);
    // If Firestore prints an index URL, create it once and retry
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// PATCH /v1/telecom/outages/:id  (update; auto-close sets closed_at)
const allowed = ['status','region','title','meta'];
    const update = {};
    for (const k of allowed) if (k in b) update[k] = b[k];

    if (update.title && !update.title.toString().trim()) return res.status(400).json({ ok:false, error:'title_required' });
    if (update.status && !['open','closed'].includes(update.status)) return res.status(400).json({ ok:false, error:'invalid_status' });
    if (update.status === 'closed') update.closed_at = Timestamp.now();
    if (!Object.keys(update).length) return res.status(400).json({ ok:false, error:'no_valid_fields' });

    await ref.set(update, { merge:true });
    res.json({ ok:true, id, update });
  } catch (e) {
    console.error('patch error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
/* ===== End Firestore: telecom_outages ===== */

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


/* ===== Telecom outages ===== */
// GET /v1/telecom/outages?limit=25&status=open&region=PNW&cursor=<docId>
} catch (e) {
    console.error('outages list error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// PATCH /v1/telecom/outages/:id
const allowed = ['status','region','title','meta'];
    const update = {}; for (const k of allowed) if (k in b) update[k]=b[k];

    if (update.title && !update.title.toString().trim()) return res.status(400).json({ ok:false, error:'title_required' });
    if (update.status && !['open','closed'].includes(update.status)) return res.status(400).json({ ok:false, error:'invalid_status' });
    if (update.status === 'closed') update.closed_at = Timestamp.now();
    if (!Object.keys(update).length) return res.status(400).json({ ok:false, error:'no_valid_fields' });

    await ref.set(update, { merge:true });
    res.json({ ok:true, id, update });
  } catch (e) {
    console.error('patch error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
/* ===== End telecom outages ===== */


/* ===== Telecom outages ===== */
// GET /v1/telecom/outages?limit=25&status=open&region=PNW&cursor=<docId>
app.get('/v1/telecom/outages', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '25', 10), 200);
    const status = req.query.status;
    const region = req.query.region;
    const cursor = req.query.cursor;

    let q = db.collection('telecom_outages');
    if (status) q = q.where('status','==', status);
    if (region) q = q.where('region','==', region);
    q = q.orderBy('created_at','desc').limit(limit);

    if (cursor) {
      const cur = await db.collection('telecom_outages').doc(cursor).get();
      if (cur.exists) q = q.startAfter(cur);
    }

    const snap = await q.get();
    const items = []; snap.forEach(d => items.push({ id:d.id, ...d.data() }));
    const nextCursor = items.length === limit ? items[items.length-1].id : null;

    res.json({ ok:true, count: items.length, nextCursor, items });
  } catch (e) {
    console.error('outages list error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// PATCH /v1/telecom/outages/:id
app.patch('/v1/telecom/outages/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const ref = db.collection('telecom_outages').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:'not_found', id });

    const allowed = ['status','region','title','meta'];
    const update = {}; for (const k of allowed) if (k in b) update[k]=b[k];

    if (update.title && !update.title.toString().trim()) return res.status(400).json({ ok:false, error:'title_required' });
    if (update.status && !['open','closed'].includes(update.status)) return res.status(400).json({ ok:false, error:'invalid_status' });
    if (update.status === 'closed') update.closed_at = Timestamp.now();
    if (!Object.keys(update).length) return res.status(400).json({ ok:false, error:'no_valid_fields' });

    await ref.set(update, { merge:true });
    res.json({ ok:true, id, update });
  } catch (e) {
    console.error('patch error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});
/* ===== End telecom outages ===== */

export default app;
