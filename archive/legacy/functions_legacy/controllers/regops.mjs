import { getDb } from '../lib/admin.mjs';
import jsonLogic from 'json-logic-js';

function pinRulepack(p){ return { regulator:p.regulator, version_id:p.version_id, pack_hash:p.pack_hash }; }

// rows[]-aware getter; supports payload.as_of and payload.rows[].as_of
function getByPath(root, path) {
  const segs = path.split('.');
  function walk(node, i) {
    if (node == null) return undefined;
    if (i >= segs.length) return node;
    const seg = segs[i];
    if (seg === 'rows[]') {
      const arr = node?.rows;
      if (!Array.isArray(arr)) return undefined;
      return arr.map(row => walk(row, i + 1));
    }
    return walk(node[seg], i + 1);
  }
  return walk(root, 0);
}

function evaluateRules(pack, payload, regulator) {
  const errors=[], warnings=[];
  let rules=[], reqs=[];
  try { rules = JSON.parse(pack?.json_logic_rules || '[]'); } catch { warnings.push('parse_error:rules'); }
  try {
    const raw = pack?.required_fields;
    if (Array.isArray(raw)) reqs = raw;
    else if (typeof raw === 'string') reqs = JSON.parse(raw);
    else reqs = []; // if pack omits, tolerate (we can add defaults later)
  } catch { warnings.push('parse_error:reqs'); }

  // run json-logic if present
  for (const r of rules) {
    try { if (!jsonLogic.apply(r.rule, {payload})) errors.push(r.name); } catch { warnings.push(`rule_error:${r.name}`); }
  }

  // required: pass if EITHER single-field OR rows[] variant is present (FCC_DIRS)
  for (const f of reqs) {
    const v = getByPath({payload}, f.path);
    if (Array.isArray(v)) {
      if (v.length===0 || v.some(x=>x===undefined||x===null||x==='')) errors.push(`missing:${f.path}`);
    } else if (v===undefined || v===null || v==='') {
      if (regulator==='FCC_DIRS' && f.path.startsWith('payload.')) {
        const alt = getByPath({payload}, f.path.replace('payload.','payload.rows[].'));
        if (!Array.isArray(alt) || alt.length===0 || alt.some(x=>x===undefined||x===null||x==='')) {
          errors.push(`missing:${f.path}`);
        }
      } else {
        errors.push(`missing:${f.path}`);
      }
    }
  }
  return { passed: errors.length===0, errors, warnings };
}

export async function prefileGeneric(req,res){
  try{
    const db=getDb(); const { regulator } = req.params;
    const { rulepack_version, payload, external_id, org_id } = req.body || {};
    const packId = `${regulator}@${rulepack_version}`;
    const pSnap = await db.collection('rulepacks').doc(packId).get();
    if(!pSnap.exists) return res.status(404).json({ ok:false, error:'rulepack_not_found', id:packId });
    const pack = pSnap.data();

    const preflight = evaluateRules(pack, payload||{}, regulator);
    const now = new Date().toISOString();

    let ref;
    if (external_id && org_id) {
      const q = await db.collection('submissions').where('regulator','==',regulator)
        .where('org_id','==',org_id).where('payload.external_id','==',external_id).limit(1).get();
      ref = q.empty ? db.collection('submissions').doc() : q.docs[0].ref;
    } else ref = db.collection('submissions').doc();

    await ref.set({
      regulator, org_id: org_id||null, payload,
      rule_pack_pin: pinRulepack(pack),
      preflight, status: preflight.passed ? 'PREFLIGHT_PASS' : 'PREFLIGHT_FAIL',
      updated_at: now, created_at: (await ref.get()).exists ? undefined : now
    }, { merge:true });

    await db.collection('events').add({ submission_id:ref.id, event:'prefile', regulator, preflight, at:now, actor:req.user?.email||'api' });
    res.json({ ok:true, id: ref.id, preflight });
  }catch(e){ console.error('prefileGeneric error:',e); res.status(500).json({ ok:false, error:'internal_error', detail:String(e) }); }
}

export async function finalizeGeneric(req,res){
  try{
    const db=getDb(); const { regulator, id } = req.params;
    const sSnap = await db.collection('submissions').doc(id).get();
    if(!sSnap.exists) return res.status(404).json({ ok:false, error:'submission_not_found' });
    const s = sSnap.data();
    if (s.regulator !== regulator) return res.status(400).json({ ok:false, error:'regulator_mismatch' });

    const packId = `${s.rule_pack_pin.regulator}@${s.rule_pack_pin.version_id}`;
    const pSnap = await db.collection('rulepacks').doc(packId).get();
    if(!pSnap.exists) return res.status(404).json({ ok:false, error:'pinned_rulepack_missing', id:packId });
    const pack = pSnap.data();

    const preflight = { ...s.preflight, ...evaluateRules(pack, s.payload||{}, regulator) };
    if (!preflight.passed) return res.status(422).json({ ok:false, error:'preflight_failed', preflight });

    const { exportSubmissionJSON, exportSubmissionPDF, exportDIRSCSV } = await import('./export.mjs');
    const jsonRes = await exportSubmissionJSON({ params:{ id } }, { json:()=>{} }, true);
    let artifacts = { json_key: jsonRes.json_key, json_hash: jsonRes.json_hash, bucket: jsonRes.bucket };

    if (regulator==='DOE_OE417') {
      const pdfRes = await exportSubmissionPDF({ params:{ id } }, { json:()=>{} }, true);
      artifacts = { ...artifacts, pdf_key: pdfRes.pdf_key, pdf_hash: pdfRes.pdf_hash, bucket: pdfRes.bucket || artifacts.bucket };
    } else if (regulator==='FCC_DIRS') {
      const csvRes = await exportDIRSCSV({ params:{ id } }, { json:()=>{} }, true);
      artifacts = { ...artifacts, csv_key: csvRes.csv_key, bucket: csvRes.bucket || artifacts.bucket };
    }

    const now = new Date().toISOString();
    await sSnap.ref.set({ preflight, status:'FILED', filed_at: now, artifacts }, { merge:true });
    await db.collection('events').add({ submission_id:id, event:'finalize', regulator, artifacts, at:now, actor:req.user?.email||'api' });

    res.json({ ok:true, status:'filed', artifacts });
  }catch(e){ console.error('finalizeGeneric error:',e); res.status(500).json({ ok:false, error:'internal_error', detail:String(e) }); }
}
