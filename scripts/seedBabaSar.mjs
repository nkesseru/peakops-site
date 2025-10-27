import admin from 'firebase-admin';
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const doc = {
  regulator: 'BABA_SAR',
  payload: {
    award_id: 'AWD-1234',
    vendor: 'USA Steel Co',
    category: 'manufactured_product',
    domestic_content_pct: 62,
    country_of_origin: 'US',
    waiver: { status: 'none' },
    narr: 'Seed BABA-SAR record for UI.'
  },
  preflight: { passed: true, errors: [], warnings: [] },
  rule_pack: {
    regulator: 'BABA_SAR',
    version_id: '2025.01',
    pack_hash: null,
    cfr_refs: ['2 CFR Part 184'],
    codelists: ['BABA_material_types@2025.01']
  },
  created_at: new Date().toISOString()
};
const id = (await db.collection('prefile_baba_sar').add(doc)).id;
console.log('✅ Seeded BABA-SAR doc:', id);
