import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || 'peakops-pilot' });
const db = getFirestore();

const DEFAULTS = {
  DOE_OE417: 15,
  FCC_DIRS: 120,
  FCC_NORS: 90,
  FEMA_PA: 180,
  DOT_BABA_OF2211: 240
};

(async () => {
  const snap = await db.collection('rulepacks').get();
  let updated = 0;
  for (const doc of snap.docs) {
    const pack = doc.data() || {};
    const reg = pack.regulator;
    const def = DEFAULTS[reg] ?? 60;
    const rules = (pack.deadline_rules || []).map(r => ({
      ...r,
      throttleMin: r.throttleMin ?? def
    }));
    await doc.ref.update({ deadline_rules: rules });
    updated++;
    console.log(`✅ Updated ${doc.id} (${reg}) with throttleMin=${def}`);
  }
  console.log(`\nAll done — updated ${updated} rulepacks.`);
})();
