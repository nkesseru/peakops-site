// functions/controllers/finalize.mjs
import crypto from 'crypto';
import { getDb } from '../lib/admin.mjs';
import { Storage } from '@google-cloud/storage';
import PDFDocument from 'pdfkit';

function sha256(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr));
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}
function getStorage() {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) return null;
  return { storage: new Storage(), bucket };
}

/**
 * POST /v1/finalize/:id
 * Body: { actor?: "email-or-uid" }
 * Output: { ok, json_key, json_hash, pdf_key, pdf_hash }
 */
export async function finalizeSubmission(req, res) {
  try {
    const db = getDb();
    const id = req.params.id;
    const actor = (req.body && req.body.actor) || null;

    const snap = await db.collection('submissions').doc(id).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:'not_found' });
    const sub = snap.data();

    // Build a sealed snapshot object
    const now = new Date().toISOString();
    const snapshot = {
      submission_id: id,
      filed_at: now,
      regulator: sub.regulator,
      org_id: sub.org_id || null,
      payload: sub.payload || {},
      preflight: sub.preflight || {},
      rule_pack: sub.rule_pack || {},
      evidence: sub.evidence || [],
      sealed_by: actor
    };
    const jsonBuf = Buffer.from(JSON.stringify(snapshot, null, 2));
    const json_hash = sha256(jsonBuf);

    // Create a simple PDF summary
    const pdfDoc = new PDFDocument({ size:'A4', margin:48 });
    const chunks = [];
    pdfDoc.on('data', c => chunks.push(c));
    const pdfDone = new Promise(resolve => pdfDoc.on('end', resolve));

    pdfDoc.fontSize(16).text(`${sub.regulator} — Finalized`, { underline:false });
    pdfDoc.moveDown(0.5);
    pdfDoc.fontSize(10).fillColor('#555')
      .text(`Submission: ${id}`)
      .text(`Filed At:   ${now}`)
      .text(`JSON Hash:  ${json_hash}`)
      .text(`Rule Pack:  ${snapshot.rule_pack?.regulator || ''}@${snapshot.rule_pack?.version_id || ''}`);
    pdfDoc.moveDown();
    pdfDoc.fillColor('#000').fontSize(12).text('Summary');
    pdfDoc.fontSize(9).fillColor('#111').text(JSON.stringify({
      payload: snapshot.payload,
      evidence_count: (snapshot.evidence||[]).length
    }, null, 2));
    pdfDoc.end();
    await pdfDone;
    const pdfBuf = Buffer.concat(chunks);
    const pdf_hash = sha256(pdfBuf);

    let json_key = null, pdf_key = null, bucket = null;
    const io = getStorage();

    if (io) {
      bucket = io.bucket;
      json_key = `submissions/${id}/final_${json_hash.slice(7,19)}.json`;
      pdf_key  = `submissions/${id}/final_${pdf_hash.slice(7,19)}.pdf`;
      await io.storage.bucket(bucket).file(json_key).save(jsonBuf, { contentType:'application/json' });
      await io.storage.bucket(bucket).file(pdf_key).save(pdfBuf,  { contentType:'application/pdf'  });
    }

    // Update submission status + artifacts
    await db.collection('submissions').doc(id).set({
      status: 'filed',
      filed_at: now,
      artifacts: {
        json_key, json_hash,
        pdf_key,  pdf_hash,
        bucket
      }
    }, { merge: true });

    return res.json({ ok:true, json_key, json_hash, pdf_key, pdf_hash, bucket });
  } catch (e) {
    console.error('finalize error', e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
}
