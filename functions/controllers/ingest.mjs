// functions/controllers/ingest.mjs
import crypto from 'crypto';
import { getDb } from '../lib/admin.mjs';

function verifyHmac(req) {
  const secret = process.env.INGEST_HMAC_SECRET;
  if (!secret) return true; // dev: allow; prod: require
  const body = JSON.stringify(req.body || {});
  const sig  = req.headers['x-signature'] || '';
  const mac  = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); } catch { return false; }
}

const TZ_MAP = {
  'America/Los_Angeles': 'Pacific',
  'America/Denver': 'Mountain',
  'America/Chicago': 'Central',
  'America/New_York': 'Eastern',
  'Pacific/Honolulu': 'Hawaii',
  'America/Anchorage': 'Alaska',
  // add Atlantic / Chamorro if needed
};

export async function ingestOutageEvent(req, res) {
  try {
    if (!verifyHmac(req)) return res.status(401).json({ ok:false, error:'bad_signature' });
    const db = getDb();
    const p  = req.body || {};
    const orgId = p.org_id || 'unknown';

    // normalize tz (IANA -> OE-417 labels)
    let timezone = p.timezone || p.tz || null;
    if (timezone && TZ_MAP[timezone]) timezone = TZ_MAP[timezone];

    const nowISO = new Date().toISOString();
    const doc = {
      source: String(p.source || 'unknown'),
      external_id: String(p.external_id || ''),
      org_id: orgId,
      incident_start: p.incident_start || null,
      incident_end: p.incident_end || null,
      timezone: timezone || p.timezone || p.tz || null,
      substation: p.substation || null,
      county: p.county || null,
      state: p.state || null,
      county_fips: p.county_fips || null,
      demand_affected_mw: p.demand_affected_mw ?? null,
      customers_affected: p.customers_affected ?? null,
      cause: p.cause || null,
      impact: Array.isArray(p.impact) ? p.impact : (p.impact ? [p.impact] : []),
      actions_taken: Array.isArray(p.actions_taken) ? p.actions_taken : (p.actions_taken ? [p.actions_taken] : []),
      notes: p.notes || null,
      status: p.status || 'open',
      created_at: nowISO,
      updated_at: nowISO
    };

    // upsert outage_events by (org_id + external_id)
    let ref;
    if (doc.external_id) {
      const q = await db.collection('outage_events')
        .where('org_id','==',orgId).where('external_id','==',doc.external_id).limit(1).get();
      if (!q.empty) {
        ref = q.docs[0].ref;
        await ref.set({ ...doc, updated_at: nowISO }, { merge: true });
      } else {
        ref = await db.collection('outage_events').add(doc);
      }
    } else {
      ref = await db.collection('outage_events').add(doc);
    }

    // create / update a prefilled OE-417 draft (regulator = DOE_OE417)
    const prefill = {
      start: doc.incident_start,
      timezone: doc.timezone,
      county: doc.county,
      fips: doc.county_fips,
      mw: String(doc.demand_affected_mw ?? ''),
      cust: String(doc.customers_affected ?? ''),
      cause: doc.cause || '',
      impact: (doc.impact||[])[0] || '',
      actions: (doc.actions_taken||[])[0] || '',
      narr: doc.notes || '',
      external_id: doc.external_id || ''
    };

    // try to find an existing draft linked to this external_id
    let draftRef = null;
    if (prefill.external_id) {
      const dq = await db.collection('submissions')
        .where('regulator','==','DOE_OE417')
        .where('payload.external_id','==',prefill.external_id)
        .limit(1).get();
      if (!dq.empty) draftRef = dq.docs[0].ref;
    }
    if (draftRef) {
      await draftRef.set({ payload: { ...prefill }, updated_at: nowISO }, { merge: true });
    } else {
      await db.collection('submissions').add({
        regulator: 'DOE_OE417',
        org_id: orgId,
        payload: { ...prefill },
        preflight: { passed: false, errors: [], warnings: [] },
        created_at: nowISO
      });
    }

    return res.json({ ok:true, id: ref.id });
  } catch (e) {
    console.error('ingestOutageEvent error', e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
}

export async function ingestGIS(req, res) {
  try {
    if (!verifyHmac(req)) return res.status(401).json({ ok:false, error:'bad_signature' });
    // stub: extend later w/ reverse geocode + FIPS enrichment
    return res.json({ ok:true, note:'GIS ingest stub — ready to wire reverse geocode/FIPS' });
  } catch (e) {
    console.error('ingestGIS error', e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
}

export async function ingestCIS(req, res) {
  try {
    if (!verifyHmac(req)) return res.status(401).json({ ok:false, error:'bad_signature' });
    const db = getDb();
    const p = req.body || {};
    await db.collection('cis_baseline').doc(`${p.org_id}_${p.county_fips}`).set({
      org_id: p.org_id, county_fips: p.county_fips,
      customers_total: p.customers_total, as_of: p.as_of || new Date().toISOString()
    }, { merge: true });
    return res.json({ ok:true });
  } catch (e) {
    console.error('ingestCIS error', e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
}
