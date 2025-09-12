// scripts/seed.ts
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json \
//   ORG_ID=demo-org ADMIN_EMAIL="you@example.com" \
//   pnpm tsx scripts/seed.ts

import { initializeApp, cert, getApps, ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

async function main() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sa = require(credPath) as ServiceAccount;

  if (!getApps().length) {
    initializeApp({ credential: cert(sa) });
  }
  const db = getFirestore();
  const auth = getAuth();

  const ORG_ID = process.env.ORG_ID || 'demo-org';
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  if (!ADMIN_EMAIL) throw new Error('Set ADMIN_EMAIL=email@domain.com');

  // 1) Find or create admin user in Firebase Auth
  let user = null as any;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
  } catch {
    user = await auth.createUser({ email: ADMIN_EMAIL, emailVerified: true });
  }
  const uid = user.uid;

  // 2) Upsert org
  await db.doc(`orgs/${ORG_ID}`).set(
    { name: 'PeakOps Demo Org', createdAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  // 3) Upsert user doc (link to org, make admin)
  await db.doc(`users/${uid}`).set(
    {
      orgId: ORG_ID,
      role: 'admin',
      email: ADMIN_EMAIL,
      name: user.displayName || 'Admin',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // 4) Seed one job for the org
  const jobRef = db.collection('jobs').doc();
  await jobRef.set({
    orgId: ORG_ID,
    title: 'Tower Inspection — Riverside Ridge',
    status: 'scheduled', // draft | scheduled | in_progress | closeout_ready | done
    site: { name: 'Riverside Ridge • 901 E Upriver D' },
    window: { start: '08:00', end: '10:30' },
    createdAt: FieldValue.serverTimestamp(),
  });

  console.log('✅ Seed complete.');
  console.log('Org:', ORG_ID);
  console.log('Admin uid:', uid);
  console.log('Job id:', jobRef.id);
}

main().catch((e) => {
  console.error('❌ Seed failed:', e);
  process.exit(1);
});
