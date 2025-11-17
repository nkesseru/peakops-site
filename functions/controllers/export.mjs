import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import { Storage } from '@google-cloud/storage';
import { getDb } from '../lib/admin.mjs';

function sha256(buf){ return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex'); }
function getBucket() {
  const bucket = process.env.BUCKET_NAME || 'peakops-evidence-prod';
  const storage = new Storage(); // ADC in Cloud Run
  return { storage, bucket };
}
async function putObject(key, buf, contentType='application/octet-stream'){
  const { storage, bucket } = getBucket();
  await storage.bucket(bucket).file(key).save(buf, { resumable:false, contentType });
  return { bucket, key };
}

/** -------- JSON export (kept) -------- */
export async function exportSubmissionJSON(req, res, headless=false){
  const id = req.params.id;
  const db = getDb();
  const snap = await db.collection('submissions').doc(id).get();
  if(!snap.exists) return res.status(404).json({ ok:false, error:'submission_not_found' });
  const sub = snap.data();
  const payload = {
    submission_id: id,
    regulator: sub.regulator,
    rule_pack_pin: sub.rule_pack_pin || null,
    payload: sub.payload || {},
    preflight: sub.preflight || {},
    artifacts: sub.artifacts || null,
    created_at: sub.created_at || null,
    filed_at: new Date().toISOString()
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2));
  const hash = sha256(buf);
  const key = `submissions/${id}/final_${Date.now()}.json`;
  const { bucket } = await putObject(key, buf, 'application/json');
  if (headless) return { json_key:key, json_hash:hash, bucket };
  return res.json({ ok:true, json_key:key, json_hash:hash, bucket });
}

/** -------- Pretty, branded DOE PDF -------- */
export async function exportSubmissionPDF(req, res, headless=false){
  const id = req.params.id;
  const db = getDb();
  const snap = await db.collection('submissions').doc(id).get();
  if(!snap.exists) return res.status(404).json({ ok:false, error:'submission_not_found' });
  const sub = snap.data();
  const p = sub.payload || {};
  const pre = sub.preflight || {};

  const doc = new PDFDocument({ size:'A4', margin:48 });
  const chunks=[]; doc.on('data', c=>chunks.push(c));
  const done = new Promise(r=>doc.on('end', r));

  // Header
  doc.rect(48,48, 514, 28).fill('#111').fillColor('#fff').fontSize(14)
     .text('PeakOps — Regulation-as-Code Filing Summary', 54, 56, { width:500 });
  doc.moveDown(2).fillColor('#000');

  // Meta bar
  doc.fontSize(11).text(`Regulator: ${sub.regulator}`, { continued:true }).text(`   Submission: ${id}`);
  doc.moveDown(0.2).fontSize(9).fillColor('#555')
     .text(`Rule Pack: ${(sub.rule_pack_pin?.regulator||'')}@${(sub.rule_pack_pin?.version_id||'')}`)
     .text(`Filed At:  ${new Date().toISOString()}`)
     .moveDown(0.6).fillColor('#000');

  // Section helper
  function kv(obj, pairs) {
    doc.fontSize(11).fillColor('#000').text('Details', { underline:true }); doc.moveDown(0.2);
    doc.fontSize(9).fillColor('#111');
    pairs.forEach(([k,v])=>{
      doc.text(`${k}: ${v ?? ''}`);
    });
    doc.moveDown(0.8);
  }

  // DOE-friendly top-level fields
  if (sub.regulator === 'DOE_OE417') {
    kv(p, [
      ['Start (UTC)', p.start],
      ['Time Zone', p.timezone],
      ['County FIPS', p.county_fips],
      ['MW Affected', p.mw],
      ['Customers', p.cust],
      ['Cause', p.cause || (Array.isArray(p.cause)?p.cause.join('; '):'')],
      ['Impact', p.impact || (Array.isArray(p.impact)?p.impact.join('; '):'')],
    ]);
  } else {
    // generic dump
    doc.fontSize(11).text('Payload', { underline:true }).moveDown(0.2);
    doc.fontSize(9).text(JSON.stringify(p, null, 2));
    doc.moveDown(0.8);
  }

  doc.fontSize(11).fillColor('#000').text('Preflight', { underline:true }).moveDown(0.2);
  doc.fontSize(9).fillColor(pre.passed ? '#0a0' : '#a00').text(JSON.stringify(pre, null, 2));

  doc.end(); await done;
  const buf = Buffer.concat(chunks);
  const hash = sha256(buf);
  const key = `submissions/${id}/final_${Date.now()}.pdf`;
  const { bucket } = await putObject(key, buf, 'application/pdf');
  if (headless) return { pdf_key:key, pdf_hash:hash, bucket };
  return res.json({ ok:true, pdf_key:key, pdf_hash:hash, bucket });
}

/** -------- Multi-row CSV for FCC DIRS --------
 * Supports:
 *  - Single-row payload { as_of, county_fips, cell_sites_served, cell_sites_out }
 *  - Batch rows: payload.rows = [ { as_of, county_fips, ... }, ... ]
 */
export async function exportDIRSCSV(req, res, headless=false){
  const id = req.params.id;
  const db = getDb();
  const snap = await db.collection('submissions').doc(id).get();
  if(!snap.exists) return res.status(404).json({ ok:false, error:'submission_not_found' });
  const p = snap.data()?.payload || {};
  const headers = ['as_of','county_fips','cell_sites_served','cell_sites_out','percent_out'];

  const rows = Array.isArray(p.rows) ? p.rows : [p];
  const lines = rows.map(r => {
    const served = Number(r.cell_sites_served ?? 0);
    const out = Number(r.cell_sites_out ?? 0);
    const pct = (served > 0 ? (out/served) : 0).toFixed(4);
    return [r.as_of||'', r.county_fips||'', served, out, pct].join(',');
  });
  const csv = headers.join(',') + '\n' + lines.join('\n') + '\n';

  const buf = Buffer.from(csv, 'utf8');
  const key = `submissions/${id}/dirs_${Date.now()}.csv`;
  const { bucket } = await putObject(key, buf, 'text/csv');
  if (headless) return { csv_key:key, bucket };
  return res.json({ ok:true, csv_key:key, bucket });
}

export async function exportFEMACPUSummaryPDF(req,res,headless=false){
  const id=req.params.id; const {getDb}=await import('../lib/admin.mjs');
  const snap=await getDb().collection('submissions').doc(id).get();
  if(!snap.exists) return res.status(404).json({ok:false,error:'submission_not_found'});
  const s=snap.data(), p=s.payload||{};
  const PDFDocument=(await import('pdfkit')).default;
  const doc=new PDFDocument({size:'A4',margin:48}); const chunks=[]; doc.on('data',c=>chunks.push(c));
  const done=new Promise(r=>doc.on('end',r));
  doc.rect(48,48,514,28).fill('#111').fillColor('#fff').fontSize(14).text('FEMA PA — Summary',54,56);
  doc.moveDown(2).fillColor('#000').fontSize(11).text(`Applicant: ${p.applicant?.legal_name||''}`);
  doc.fontSize(9).fillColor('#555').text(`DUNS: ${p.applicant?.duns||''}`).text(`Disaster: ${p.disaster_number||''}`);
  doc.moveDown().fillColor('#000').fontSize(11).text('Project'); doc.fontSize(9).text(JSON.stringify(p.project||{},null,2));
  doc.moveDown().fontSize(11).text('Period'); doc.fontSize(9).text(JSON.stringify(p.period||{},null,2));
  doc.moveDown().fontSize(11).text('Work'); doc.fontSize(9).text(JSON.stringify(p.work||{},null,2));
  doc.moveDown().fontSize(11).text('Costs'); doc.fontSize(9).text(JSON.stringify(p.costs||{},null,2));
  doc.end(); await done; const buf=Buffer.concat(chunks);
  const {bucket,key}=await (await import('@google-cloud/storage')).Storage.prototype; /* placeholder to satisfy lints */
  const { Storage } = await import('@google-cloud/storage'); const storage=new Storage(); const b=process.env.BUCKET_NAME||'peakops-evidence-prod';
  const pdfKey=`submissions/${id}/fema_pa_${Date.now()}.pdf`; await storage.bucket(b).file(pdfKey).save(buf,{resumable:false,contentType:'application/pdf'});
  if(headless) return {pdf_key:pdfKey,bucket:b}; return res.json({ok:true,pdf_key:pdfKey,bucket:b});
}

export async function exportFEMACSV(req,res,headless=false){
  const id=req.params.id; const {getDb}=await import('../lib/admin.mjs');
  const snap=await getDb().collection('submissions').doc(id).get();
  if(!snap.exists) return res.status(404).json({ok:false,error:'submission_not_found'});
  const p=snap.data()?.payload||{};
  const headers=['disaster','category','period_start','period_end','labor_hours','equipment_hours','total_usd'];
  const row=[p.disaster_number||'',p.project?.category||'',p.period?.start||'',p.period?.end||'',p.work?.labor_hours??'',p.work?.equipment_hours??'',p.costs?.total_usd??''];
  const csv=headers.join(',')+'\n'+row.join(',')+'\n'; const buf=Buffer.from(csv,'utf8');
  const { Storage } = await import('@google-cloud/storage'); const storage=new Storage(); const b=process.env.BUCKET_NAME||'peakops-evidence-prod';
  const key=`submissions/${id}/fema_pa_${Date.now()}.csv`; await storage.bucket(b).file(key).save(buf,{resumable:false,contentType:'text/csv'});
  if(headless) return {csv_key:key,bucket:b}; return res.json({ok:true,csv_key:key,bucket:b});
}

export async function exportNORSCSV(req,res,headless=false){
  const id=req.params.id; const {getDb}=await import('../lib/admin.mjs');
  const snap=await getDb().collection('submissions').doc(id).get();
  if(!snap.exists) return res.status(404).json({ok:false,error:'submission_not_found'});
  const p=snap.data()?.payload||{};
  const headers=['outage_start','duration_minutes','affected_customers','technology','cause','psap_affected'];
  const row=[p.outage_start||'',p.duration_minutes??'',p.affected_customers??'',p.technology||'',p.cause||'',p.psap_affected??false];
  const csv=headers.join(',')+'\n'+row.join(',')+'\n'; const buf=Buffer.from(csv,'utf8');
  const { Storage } = await import('@google-cloud/storage'); const storage=new Storage(); const b=process.env.BUCKET_NAME||'peakops-evidence-prod';
  const key=`submissions/${id}/nors_${Date.now()}.csv`; await storage.bucket(b).file(key).save(buf,{resumable:false,contentType:'text/csv'});
  if(headless) return {csv_key:key,bucket:b}; return res.json({ok:true,csv_key:key,bucket:b});
}
