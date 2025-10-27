import { getFirestore } from 'firebase-admin/firestore';
import jsonLogic from 'json-logic-js';

const _cache = new Map();
const TTL = 5 * 60 * 1000;

function chooseVersion(asOfISO, docs, pinned) {
  if (pinned) {
    const hit = docs.find(d => d.id === pinned);
    if (!hit) throw new Error(`Pinned version ${pinned} not found`);
    return hit;
  }
  const eligible = docs.filter(d => {
    const s = d.data.effective_start ?? '0000-01-01';
    const e = d.data.effective_end ?? null;
    return s <= asOfISO && (!e || e >= asOfISO);
  });
  return eligible.sort((a,b)=> (a.data.effective_start < b.data.effective_start ? 1 : -1))[0] || null;
}

function evalExpr(expr, context) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(context), `return (${expr});`);
  return !!fn(...Object.values(context));
}

export async function loadRulePack(regulator, asOfDate = new Date(), orgId) {
  const db = getFirestore();
  const asOfISO = asOfDate.toISOString().slice(0,10);
  const ck = `${regulator}:${orgId||'-'}:${asOfISO}`;
  const hit = _cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.val;

  let pinnedVersionId = null;
  let featureOverrides = null;
  if (orgId) {
    const pinSnap = await db.doc(`orgs/${orgId}/rule_overrides/${regulator}`).get();
    if (pinSnap.exists) {
      const p = pinSnap.data() || {};
      pinnedVersionId = p.version_pin || null;
      featureOverrides = p.feature_overrides || null;
    }
  }

  const regRef = db.collection('rules_registry').doc(regulator);
  const versionsSnap = await regRef.collection('versions').get();
  const docs = versionsSnap.docs.map(d => ({ id: d.id, data: d.data() }));
  if (!docs.length) throw new Error(`No versions found for ${regulator}`);

  const chosen = chooseVersion(asOfISO, docs, pinnedVersionId);
  if (!chosen) throw new Error(`No eligible version for ${regulator} as of ${asOfISO}`);

  const pack = {
    ...chosen.data,
    feature_flags: { ...(chosen.data.feature_flags || {}), ...(featureOverrides || {}) }
  };

  if (Array.isArray(pack.validators)) {
    pack.validators = pack.validators.map(v => {
      if (v.logic_json && !v.logic) {
        try { v.logic = JSON.parse(v.logic_json); } catch {}
      }
      return v;
    });
  }

  _cache.set(ck, { val: pack, exp: Date.now() + TTL });
  return pack;
}

export function validatePayload(rulePack, payload, extras = {}) {
  const errors = [];
  const warnings = [];
  const flags = rulePack.feature_flags || {};
  const ctx = { flags, ...extras };

  for (const v of (rulePack.validators || [])) {
    try {
      if (v.type === 'jsonlogic' && v.logic) {
        const ok = !!jsonLogic.apply(v.logic, { ...payload, ...ctx });
        if (!ok) (v.severity === 'block' ? errors : warnings).push(v.name);
      } else if (v.type === 'flag' && v.expr) {
        const ok = evalExpr(v.expr, ctx);
        if (!ok) (v.severity === 'block' ? errors : warnings).push(v.name);
      }
    } catch {
      warnings.push(`${v.name}:eval-error`);
    }
  }
  return { passed: errors.length === 0, errors, warnings };
}
