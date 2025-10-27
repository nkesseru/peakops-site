import admin from 'firebase-admin';
if (!admin.apps.length) admin.initializeApp();   // ADC
const db = admin.firestore();

const doc = {
  regulator: 'FCC_DIRS',
  payload: {
    incident: 'major-outage',
    start: new Date().toISOString().slice(0,16),
    timezone: 'UTC',
    county: 'Spokane',
    fips: '53063',
    status: 'active',
    cell_sites_served: 10,
    cell_sites_out: 5,
    out_due_to_power: 2,
    out_due_to_transport: 2,
    out_due_to_damage: 1,
    narr: 'Seed DIRS record for UI.'
  },
  preflight: { passed: true, errors: [], warnings: [] },
  rule_pack: {
    regulator: 'FCC_DIRS',
    version_id: '2025.02',
    pack_hash: null,
    cfr_refs: ['47 CFR §4.18'],
    codelists: ['FCC_DIRS_fields@2025.02']
  },
  created_at: new Date().toISOString()
};

const id = (await db.collection('prefile_dirs').add(doc)).id;
console.log('✅ Seeded DIRS doc:', id);
