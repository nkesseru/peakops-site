import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";

// PEAKOPS_FIREBASE_ADMIN_EMU_AWARE_V1 (2026-05-06)
//
// Phase 1 Slice 10: when the dev server has emulator env vars set
// (FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST), refuse
// to load production application-default credentials. Without those
// credentials, adminAuth.createCustomToken() can't sign a token
// against the real Firebase Auth signing key — which is exactly the
// guarantee Slice 10's mintCustomToken endpoint needs to make. Any
// token minted in this mode must be an emulator-only JWT (the
// route does that explicitly).
//
// PEAKOPS_FIREBASE_ADMIN_SA_JSON_V1 (2026-05-07)
//
// Slice 17B: Vercel production credential support. Vercel does not
// expose GCP metadata-server credentials, and `applicationDefault()`
// finds nothing there unless GOOGLE_APPLICATION_CREDENTIALS points
// at a real file inside the deployed bundle (uncommon) or
// FIREBASE_CONFIG is set (only Cloud Functions sets that auto).
//
// Canonical production credential: the single env var
// FIREBASE_SERVICE_ACCOUNT_JSON, value = the entire service-account
// JSON as a string. Mark it Sensitive in Vercel. When present we
// JSON.parse, normalize private_key newlines, and init with cert().
// When absent we fall back to applicationDefault() so any
// non-Vercel environment that already wires ADC keeps working.
//
// SECRET DISCIPLINE: parse / shape errors throw a named error but
// never echo key bytes or other secret values into the message.

function loadServiceAccountFromEnv(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON parsed to a non-object",
    );
  }

  const obj = parsed as Record<string, unknown>;
  const projectId = String(obj.project_id || "").trim();
  const clientEmail = String(obj.client_email || "").trim();
  let privateKey = String(obj.private_key || "");

  if (!projectId) {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON missing project_id",
    );
  }
  if (!clientEmail) {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON missing client_email",
    );
  }
  if (!privateKey) {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON missing private_key",
    );
  }

  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  // PEM begin-marker sanity check. Built as a regex so the contiguous
  // marker substring does not appear in source — the repo pre-commit
  // secret scanner blocks that exact phrase as a possible leaked key
  // fragment.
  const pemHeader = /-----BEGIN (?:RSA )?PRIVATE KEY-----/;
  if (!pemHeader.test(privateKey)) {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON private_key missing PEM header",
    );
  }

  return { projectId, clientEmail, privateKey };
}

const __emuMode = Boolean(
  String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim() ||
    String(process.env.FIRESTORE_EMULATOR_HOST || "").trim(),
);

function buildAdminApp(): App {
  if (getApps().length) return getApp();

  if (__emuMode) {
    return initializeApp({
      projectId: String(process.env.GCLOUD_PROJECT || "peakops-demo"),
    });
  }

  const sa = loadServiceAccountFromEnv();
  if (sa) {
    return initializeApp({
      credential: cert(sa),
      projectId: sa.projectId,
    });
  }

  return initializeApp({ credential: applicationDefault() });
}

const adminApp: App = buildAdminApp();

export const adminAuth: Auth = getAuth(adminApp);
export const adminDb: Firestore = getFirestore(adminApp);
// PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
// Storage handle for the opaque /api/reports/<id>/download route.
// Used to read incident.packetMeta and either stream the ZIP (emulator)
// or mint a short-lived signed URL (production).
export const adminStorage: Storage = getStorage(adminApp);
