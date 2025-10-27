import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const svcPath = path.join(__dirname, '..', 'serviceAccount.json');
if (!fs.existsSync(svcPath)) {
  console.error('Missing serviceAccount.json in project root. Aborting.');
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(svcPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

const seed = {
  FCC_DIRS: {
    active_version: '2025.02',
    description: 'FCC DIRS reporting rules (Feb 2025)',
    versions: {
      '2025.02': {
        regulator: 'FCC_DIRS',
        version_id: '2025.02',
        effective_start: '2025-02-01'
      }
    }
  },
  DOE_OE417: {
    active_version: '2027.05',
    description: 'DOE OE-417 incident reporting rules (May 2027)',
    versions: {
      '2027.05': {
        regulator: 'DOE_OE417',
        version_id: '2027.05',
        effective_start: '2023-08-30'
      }
    }
  },
  OMB_OF2211: {
    active_version: '2024.05',
    description: 'OMB OF-2211 waiver request rules (May 2024)',
    versions: {
      '2024.05': {
        regulator: 'OMB_OF2211',
        version_id: '2024.05',
        effective_start: '2024-05-01'
      }
    }
  }
};

async function run() {
  for (const [reg, data] of Object.entries(seed)) {
    const ref = db.collection('rules_registry').doc(reg);
    await ref.set({ active_version: data.active_version, description: data.description }, { merge: true });
    for (const [verId, ver] of Object.entries(data.versions)) {
      await ref.collection('versions').doc(verId).set(ver, { merge: true });
    }
  }
  console.log('✅ Minimal rules seeded');
}
run().catch(e => { console.error('❌', e); process.exit(1); });
