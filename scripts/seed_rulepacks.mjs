import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

// Helper
const h = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
async function writePack(p) {
  const id = `${p.regulator}@${p.version_id}`;
  const required_fields = JSON.stringify(p.required_fields || []);
  const json_logic_rules = JSON.stringify(p.json_logic_rules || []);
  const pack = {
    regulator: p.regulator,
    version_id: p.version_id,
    active: p.active ?? true,
    cfr_refs: p.cfr_refs || [],
    // Store as strings; engine JSON.parses them
    required_fields, json_logic_rules,
    export: p.export || {},
    pack_hash: h(required_fields + json_logic_rules)
  };
  await db.collection('rulepacks').doc(id).set(pack, { merge:true });
  const snap = await db.collection('rulepacks').doc(id).get();
  console.log('✅ seeded', id, '→ pack_hash', snap.data().pack_hash);
}

// ---- RULEPACKS (add more here) ----

// DOE OE-417 (Schedule 1 basics)
await writePack({
  regulator: 'DOE_OE417',
  version_id: '2027.05',
  cfr_refs: ['OMB 1901-0288'],
  required_fields: [
    { path:'payload.start', type:'datetime' },
    { path:'payload.timezone', type:'string' },
    { path:'payload.county_fips', type:'string' },
    { path:'payload.mw', type:'number' },
    { path:'payload.cust', type:'integer' }
  ],
  json_logic_rules: [],
  export: {
    json_template: { schedule1:{ start:'{{payload.start}}', tz:'{{payload.timezone}}' } },
    pdf_template: 'oe417_v2027_05.pug'
  }
});

// FCC DIRS (single-row by default; you can flip to rows[] later)
await writePack({
  regulator: 'FCC_DIRS',
  version_id: '2025.02',
  cfr_refs: ['47 CFR Part 4 §4.18'],
  required_fields: [
    { path:'payload.as_of', type:'date' },
    { path:'payload.county_fips', type:'string' },
    { path:'payload.cell_sites_served', type:'integer' },
    { path:'payload.cell_sites_out', type:'integer' }
  ],
  json_logic_rules: [
    { name:'out<=served', rule:{ "<=":[ { "var":"payload.cell_sites_out" }, { "var":"payload.cell_sites_served" } ] } }
  ],
  export: {
    csv_template: 'dirs_daily_v2025_02.csv'
  }
});

// DOT/OMB BABA OF-2211 (waiver request skeleton)
await writePack({
  regulator: 'DOT_BABA_OF2211',
  version_id: '2024.05',
  cfr_refs: ['2 CFR Part 184', 'IIJA §70914'],
  required_fields: [
    { path:'payload.uei', type:'string' },
    { path:'payload.legal_name', type:'string' },
    { path:'payload.project.description', type:'string' },
    { path:'payload.items[].name', type:'string' },
    { path:'payload.items[].naics', type:'string' },
    { path:'payload.waiver.type', type:'string' }
  ],
  json_logic_rules: [],
  export: {
    pdf_template: 'of2211_v2024_05.pug'
  }
});

console.log('✅ All rulepacks seeded.');
