import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const id = 'FCC_DIRS@2025.02';
const required = [
  { path: 'payload.rows[].as_of',             type: 'date'    },
  { path: 'payload.rows[].county_fips',       type: 'string'  },
  { path: 'payload.rows[].cell_sites_served', type: 'integer' },
  { path: 'payload.rows[].cell_sites_out',    type: 'integer' }
];

const main = async () => {
  await db.collection('rulepacks').doc(id).set({
    required_fields: JSON.stringify(required)
  }, { merge: true });

  const snap = await db.collection('rulepacks').doc(id).get();
  if (!snap.exists) throw new Error('rulepack not found: ' + id);
  console.log('✅ required_fields in', id, '=>', snap.data().required_fields);
};
main().catch(e => { console.error(e); process.exit(1); });
