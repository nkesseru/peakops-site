import { getDb } from '../lib/admin.mjs';
import PDFDocument from 'pdfkit';

// Try these in order; stop on first hit
const CANDIDATES = ['submissions','prefile_oe417','prefiles','oe417_prefile','oe417_submissions','prefile_baba_sar'];

async function getSnapById(id) {
  const db = getDb();
  for (const coll of CANDIDATES) {
    const ref = db.collection(coll).doc(id);
    const snap = await ref.get();
    console.log('[export.lookup]', { coll, id, exists: snap.exists });
    if (snap.exists) return { coll, snap };
  }
  return { coll: null, snap: null };
}

export async function exportSubmissionJSON(req, res) {
  try {
    const { id } = req.params;
    const { coll, snap } = await getSnapById(id);
    if (!snap) return res.status(404).json({ ok:false, error:'not_found', tried: CANDIDATES, path: req.path });
    res.setHeader('Content-Type', 'application/json');
    res.json({ ok: true, export_type: 'json', id, collection: coll, exported_at: new Date().toISOString(), submission: snap.data() });
  } catch (err) {
    console.error('[export.json]', err);
    res.status(500).json({ ok:false, error:'export_failed' });
  }
}

export async function exportSubmissionPDF(req, res) {
  try {
    const { id } = req.params;
    const { coll, snap } = await getSnapById(id);
    if (!snap) return res.status(404).json({ ok:false, error:'not_found', tried: CANDIDATES, path: req.path });

    const s = snap.data() || {};
    const p = s.payload || {};
    const pre = s.preflight || {};
    const rp = s.rule_pack || {};

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="OE417_${id}.pdf"`);

    const doc = new PDFDocument({ autoFirstPage: true, margin: 48 });
    doc.pipe(res);

    doc.fontSize(16).text('PeakOps — OE-417 Submission', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10)
      .text(`ID: ${id}`)
      .text(`Collection: ${coll}`)
      .text(`Created: ${s.created_at ?? ''}`)
      .text(`Regulator: ${s.regulator ?? ''}`);

    doc.moveDown().fontSize(12).text('Payload', { underline: true }).fontSize(10);
    [['start', p.start], ['timezone', p.timezone], ['county', p.county], ['fips', p.fips],
     ['mw', p.mw], ['cust', p.cust], ['cause', p.cause], ['impact', p.impact],
     ['actions', p.actions], ['narr', p.narr]].forEach(([k,v]) => doc.text(`${k}: ${v ?? ''}`));

    doc.moveDown().fontSize(12).text('Preflight', { underline: true }).fontSize(10)
      .text(`passed: ${pre.passed === true}`)
      .text(`errors: ${(pre.errors||[]).join(', ')}`)
      .text(`warnings: ${(pre.warnings||[]).join(', ')}`);

    doc.moveDown().fontSize(12).text('Rule Pack', { underline: true }).fontSize(10)
      .text(`version: ${rp.version_id ?? ''}`)
      .text(`hash: ${rp.pack_hash ?? ''}`)
      .text(`cfr_refs: ${Array.isArray(rp.cfr_refs) ? rp.cfr_refs.map(c => (c.citation ?? c)).join(' | ') : ''}`);

    doc.end();
  } catch (err) {
    console.error('[export.pdf]', err);
    res.status(500).json({ ok:false, error:'export_failed' });
  }
}

// Back-compat names
export const exportSubmissionJson = exportSubmissionJSON;
export const exportSubmissionPdf  = exportSubmissionPDF;
