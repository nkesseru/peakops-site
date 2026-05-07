import {
  applicationDefault,
  getApp,
  getApps,
  initializeApp,
  type App,
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
// In production (no emulator env), behavior is unchanged: full
// applicationDefault credentials. Other dev admin paths
// (verifyIdToken, Firestore reads, Storage reads) work without a
// real credential when the emulator hosts are set — the SDK
// auto-routes those operations to the emulators.
const __emuMode = Boolean(
  String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim() ||
    String(process.env.FIRESTORE_EMULATOR_HOST || "").trim(),
);
const adminApp: App = getApps().length
  ? getApp()
  : initializeApp(
      __emuMode
        ? { projectId: String(process.env.GCLOUD_PROJECT || "peakops-demo") }
        : { credential: applicationDefault() },
    );

export const adminAuth: Auth = getAuth(adminApp);
export const adminDb: Firestore = getFirestore(adminApp);
// PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
// Storage handle for the opaque /api/reports/<id>/download route.
// Used to read incident.packetMeta and either stream the ZIP (emulator)
// or mint a short-lived signed URL (production).
export const adminStorage: Storage = getStorage(adminApp);
