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

const adminApp: App = getApps().length
  ? getApp()
  : initializeApp({
      credential: applicationDefault(),
    });

export const adminAuth: Auth = getAuth(adminApp);
export const adminDb: Firestore = getFirestore(adminApp);
// PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
// Storage handle for the opaque /api/reports/<id>/download route.
// Used to read incident.packetMeta and either stream the ZIP (emulator)
// or mint a short-lived signed URL (production).
export const adminStorage: Storage = getStorage(adminApp);
