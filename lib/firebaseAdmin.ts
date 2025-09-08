// lib/firebaseAdmin.ts
import 'server-only';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  // allow any extra fields Google includes
  [k: string]: unknown;
};

/**
 * Loads Firebase Admin credentials.
 * - On Vercel (Prod/Preview): use FIREBASE_SA_JSON_BASE64 (base64 of the full JSON key, one line).
 * - Local dev: falls back to ./sa-peakops.json (keep that file out of git).
 */
function loadCred(): { sa: ServiceAccount; } & ReturnType<typeof cert> {
  const b64 = process.env.FIREBASE_SA_JSON_BASE64;
  if (b64) {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const sa = JSON.parse(json) as ServiceAccount;
    return { sa, ...cert(sa) };
  }

  // Local fallback (do not commit this file)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sa = require('../sa-peakops.json') as ServiceAccount;
  return { sa, ...cert(sa) };
}

const { sa, ...credential } = loadCred();

const app =
  getApps()[0] ??
  initializeApp({
    // @ts-expect-error firebase-admin types want a Credential object; cert(...) is compatible
    credential,
    projectId: sa.project_id,
  });

export const db = getFirestore(app);
