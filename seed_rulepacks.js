import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const packs = [
  {
    regulator: 'DOE_OE417',
    version_id: '2027.05',
    pack_hash: 'sha256:seed-oe417',
    active: true,
    cfr_refs: ['OMB 1901-0288'],
    required_fields: JSON.stringify([
      { path:'payload.start', type:'datetime', tz_enum:['Eastern','Central','Mountain','Pacific','Alaska','Hawaii','Atlantic','Chamorro'] },
      { path:'payload.county_fips', type:'string' },
      { path:'payload.mw', type:'number' },
      { path:'payload.cust', type:'integer' }
    ]),
    json_logic_rules: JSON.stringify([
      { name:'tz-whitelist', rule:{ "in":[ {"var":"payload.timezone"}, ['Eastern','Central','Mountain','Pacific','Alaska','Hawaii','Atlantic','Chamorro'] ] } }
    ]),
    export: {
      json_template: { schedule1:{ start:'{{payload.start}}', tz:'{{payload.timezone}}', mw:'{{payload.mw}}', cust:'{{payload.cust}}' } },
      pdf_template: 'oe417_v2027_05.pug'
    }
  },
  {
    regulator: 'FCC_DIRS',
    version_id: '2025.02',
    pack_hash: 'sha256:seed-dirs',
    active: true,
    cfr_refs: ['47 CFR Part 4 §4.18'],
    required_fields: JSON.stringify([
      { path:'payload.as_of', type:'date' },
      { path:'payload.county_fips', type:'string' },
      { path:'payload.cell_sites_served', type:'integer' },
      { path:'payload.cell_sites_out', type:'integer' }
    ]),
    json_logic_rules: JSON.stringify([
      { name:'percent-math', rule:{ "<=":[ {"var":"payload.cell_sites_out"}, {"var":"payload.cell_sites_served"} ] } }
    ]),
    export: {
      json_template: { daily:{ fips:'{{payload.county_fips}}', out:'{{payload.cell_sites_out}}', served:'{{payload.cell_sites_served}}' } },
      csv_template: 'dirs_daily_v2025_02.csv'
    }
  }
];

for (const p of packs) {
  const id = `${p.regulator}@${p.version_id}`;
  await db.collection('rulepacks').doc(id).set(p, { merge:true });
  console.log('✅ Seeded', id);
}
