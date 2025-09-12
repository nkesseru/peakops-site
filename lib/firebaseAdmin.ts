// lib/firebaseAdmin.ts
// Node-only Firebase Admin bootstrap. Uses either GOOGLE_APPLICATION_CREDENTIALS
// (path to service-account.json) or falls back to Application Default Credentials.

import { getApps, initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'node:fs';

function adminInit() {
  if (getApps().length) return;

  // Prefer explicit path via GOOGLE_APPLICATION_CREDENTIALS
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    const sa = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    initializeApp({ credential: cert(sa) });
    return;
  }

  // Fallback to ADC (e.g., when running on Vercel with env-injected creds)
  initializeApp({ credential: applicationDefault() });
}

adminInit();

export const adminAuth = getAuth();
export const adminDb = getFirestore();
