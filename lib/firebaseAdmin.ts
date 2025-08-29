// lib/firebaseAdmin.ts
import * as admin from "firebase-admin";

const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawKey      = process.env.FIREBASE_PRIVATE_KEY || "";
const privateKey  = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

if (!admin.apps.length) {
  if (!projectId || !clientEmail || !privateKey) {
    console.error("Missing FIREBASE_* env vars");
    throw new Error("Missing FIREBASE_* admin env vars");
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

export function getAdminDb() {
  return admin.firestore();
}
