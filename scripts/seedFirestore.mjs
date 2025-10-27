import admin from 'firebase-admin';

if (!admin.apps.length) admin.initializeApp(); // uses ADC
const db = admin.firestore();

async function upsert(docRef, data) {
  const snap = await docRef.get();
  if (snap.exists) return docRef.update({ ...data, _updated_at: new Date().toISOString() });
  return docRef.set({ ...data, _created_at: new Date().toISOString() });
}

async function main() {
  // --- Customers you want visible in FF ---
  const customers = [
    {
      id: 'pioneer',
      name: 'Pioneer Commercial Cleaning',
      status: 'active',
      contact_email: 'ops@pioneer.example',
      region: 'US-WA'
    },
    {
      id: 'peakops-pilot',
      name: 'PeakOps Pilot',
      status: 'active',
      contact_email: 'pilot@peakops.example',
      region: 'US-WA'
    },
    {
      id: 'ardent',
      name: 'Ardent (Pilot)',
      status: 'prospect',
      contact_email: 'eng@ardent.example',
      region: 'US-OR'
    }
  ];

  for (const c of customers) {
    await upsert(db.collection('customers').doc(c.id), c);
  }

  // --- A sample submission so FF sees fields ---
  const sample = {
    regulator: 'DOE_OE417',
    payload: {
      start: '2025-10-27T10:00',
      timezone: 'Pacific',
      county: 'Spokane',
      fips: '53063',
      mw: 250,
      cust: 42000,
      cause: 'Severe Weather',
      impact: 'Partial Loss of Load',
      actions: 'Manual Switching',
      narr: 'Seed record for UI wiring.'
    },
    preflight: { passed: true, errors: [], warnings: [] },
    rule_pack: {
      regulator: 'DOE_OE417',
      version_id: '2025.02',
      pack_hash: null,
      cfr_refs: ['DOE OE-417 OMB 1901-0288'],
      codelists: ['DOE_OE417_timezones@2027.05','DOE_OE417_causes@2027.05']
    },
    created_at: new Date().toISOString()
  };

  await db.collection('submissions').add(sample);

  console.log('✅ Seed complete.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
