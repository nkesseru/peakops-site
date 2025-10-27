// lib/firebaseAdmin.ts — SERVER ONLY
import 'server-only';
import {
  getApps, getApp, initializeApp,
  applicationDefault, cert, type ServiceAccount
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import fs from 'node:fs';

function normalizeToServiceAccount(obj: any): ServiceAccount {
  const out: any = { ...obj };
  if (typeof out.private_key === 'string') out.privateKey = out.private_key; // snake → camel
  if (typeof out.privateKey === 'string') out.privateKey = out.privateKey.replace(/\\n/g, '\n');
  return out as ServiceAccount;
}

function loadServiceAccount(): ServiceAccount | null {
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (envJson) return normalizeToServiceAccount(JSON.parse(envJson));

  const envB64 = process.env.FIREBASE_SA_JSON_BASE64;
  if (envB64) return normalizeToServiceAccount(
    JSON.parse(Buffer.from(envB64, 'base64').toString('utf8'))
  );

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    return normalizeToServiceAccount(JSON.parse(fs.readFileSync(credPath, 'utf8')));
  }
  return null; // fall back to ADC on GCP
}

if (!getApps().length) {
  const sa = loadServiceAccount();
  if (sa) initializeApp({ credential: cert(sa) });
  else initializeApp({ credential: applicationDefault() });
}

const app = getApp();
const _db = getFirestore(app);

export const adminAuth = getAuth(app);
export const db        = _db;  // primary export used by server routes
export const adminDb   = _db;  // alias for older imports
export { FieldValue, Timestamp };
