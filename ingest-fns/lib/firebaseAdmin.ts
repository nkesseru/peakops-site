// lib/firebaseAdmin.ts
import { getApps, initializeApp, applicationDefault, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * We keep a singleton Admin app + Firestore instance so Next.js
 * doesn't try to re-initialize firebase-admin on every request.
 */

let adminApp: App | null = null;

export function getAdminDb() {
  if (!getApps().length) {
    adminApp = initializeApp({
      credential: applicationDefault(),
    });
  }

  return getFirestore(adminApp!);
}
