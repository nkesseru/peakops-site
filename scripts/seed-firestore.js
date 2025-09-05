import fs from 'fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// --- Read creds from env ---
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKeyB64 = process.env.FIREBASE_PRIVATE_KEY_BASE64;

if (!projectId || !clientEmail || !privateKeyB64) {
  console.error('Missing one or more env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY_BASE64');
  process.exit(1);
}

const privateKey = Buffer.from(privateKeyB64, 'base64').toString('utf8');

// --- Initialize Admin (idempotent) ---
if (!getApps().length) {
  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}
const db = getFirestore();

// ---- Seed Data Model ----
// orgs/{orgId}
const orgId = 'peakops'; // change later if needed

const orgDoc = {
  name: 'PeakOps Telecom',
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
  status: 'active', // active|suspended
  plan: 'pilot',    // pilot|pro|enterprise
};

// users/{uid}
const userId = 'nick'; // change when you link real auth uids
const userDoc = {
  orgId,
  role: 'owner', // owner|admin|manager|tech
  profile: {
    displayName: 'Nick Kesseru',
    email: 'nick@example.com',
  },
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
};

// jobs/{jobId}
const jobId = 'job-0001';
const jobDoc = {
  orgId,
  title: 'Tower 1342 – Antenna Swap',
  siteId: 'S-1342',
  phase: 'In Progress', // Intake|Scoping|Scheduled|In Progress|QA|Closeout
  phaseProgress: 0.35,  // 0..1 within current phase
  assignees: ['tech-001','tech-002'],
  dueAt: new Date(Date.now() + 1000*60*60*24*7), // +7d
  priority: 'P1',  // P0|P1|P2
  status: 'open',  // open|blocked|done|archived
  budgetHours: 40,
  actualHours: 6,
  createdBy: userId,
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
};

// jobs/{jobId}/tasks/{taskId}
const taskId = 'task-0001';
const taskDoc = {
  title: 'Pre-check & materials',
  owner: 'tech-001',
  status: 'open', // open|in_progress|blocked|done
  order: 1,
  notes: 'Verify safety kit; confirm permits.',
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
};

// ---- Upserts (safe to re-run) ----
async function upsert(path, data) {
  await db.doc(path).set(data, { merge: true });
  console.log('✓ upserted:', path);
}

(async () => {
  try {
    await upsert(`orgs/${orgId}`, orgDoc);
    await upsert(`users/${userId}`, userDoc);
    await upsert(`jobs/${jobId}`, jobDoc);
    await upsert(`jobs/${jobId}/tasks/${taskId}`, taskDoc);

    console.log('\n✅ Seed complete.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  }
})();
