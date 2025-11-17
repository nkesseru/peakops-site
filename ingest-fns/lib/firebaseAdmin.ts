// lib/firebaseAdmin.ts
import { getApps, initializeApp, cert, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * We keep a singleton Admin app + Firestore instance so Next.js
 * doesn't try to re-initialize firebase-admin on every request.
 */

let adminApp: App | null = null;

export function getAdminDb() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY env vars",
      );
    }

    // If private key comes from env, newlines are usually escaped as \n
    const fixedKey = privateKey.replace(/\\n/g, "\n");

    adminApp = initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey: fixedKey,
      }),
    });
  }

  return getFirestore(adminApp!);
}
