// lib/firebaseAdmin.ts
import 'server-only';
import { getApps, initializeApp, cert, App, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

/**
 * Supports either:
 *  - FIREBASE_SERVICE_ACCOUNT_JSON  (plain JSON, single line)
 *  - FIREBASE_SA_JSON_BASE64        (base64 of the same JSON)
 */
function loadServiceAccount(): {
  project_id: string;
  client_email: string;
  private_key: string;
} {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64  = process.env.FIREBASE_SA_JSON_BASE64;

  if (!json && !b64) {
    throw new Error(
      'Missing service account: set FIREBASE_SERVICE_ACCOUNT_JSON (plain JSON) or FIREBASE_SA_JSON_BASE64 (base64).'
    );
  }
  const raw = json ?? Buffer.from(b64!, 'base64').toString('utf8');

  // Some providers escape newlines in private keys. Normalize them.
  const parsed = JSON.parse(raw);
  if (parsed.private_key?.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

const sa = loadServiceAccount();

const app: App =
  getApps().length
    ? getApp()
    : initializeApp({
        credential: cert({
          projectId: sa.project_id,
          clientEmail: sa.client_email,
          privateKey: sa.private_key,
        }),
        projectId: sa.project_id,
      });

export const adminAuth = getAuth(app);
export const db = getFirestore(app);
export { FieldValue, Timestamp };
