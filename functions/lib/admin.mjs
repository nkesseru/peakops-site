// functions/lib/admin.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * Initialize Firebase Admin exactly once.
 * ADC first (Cloud Run/Functions), then serviceAccount.json fallback (local/dev).
 */
export function ensureAdmin() {
  if (getApps().length) return;

  // Try ADC (Cloud Run / GCP)
  try {
    if (process.env.K_SERVICE || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ credential: applicationDefault() });
      return;
    }
  } catch (_) { /* fall through to service account */ }

  // Local/dev fallback: serviceAccount.json in repo root (or SERVICE_ACCOUNT_PATH)
  const svcPath =
    process.env.SERVICE_ACCOUNT_PATH ||
    path.resolve(process.cwd(), 'serviceAccount.json') ||
    path.resolve(__dirname, '..', 'serviceAccount.json');

  if (fs.existsSync(svcPath)) {
    const svc = JSON.parse(fs.readFileSync(svcPath, 'utf8'));
    initializeApp({ credential: cert(svc) });
    return;
  }

  // Last resort: attempt ADC again (no credential throws in local)
  initializeApp({ credential: applicationDefault() });
}

/** Get Firestore (ensures Admin is initialized) */
export function getDb() {
  ensureAdmin();
  return getFirestore();
}
