import * as admin from "firebase-admin";

const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
// Read the key from env. Strip accidental quotes and turn "\n" into real newlines.
const rawKey      = process.env.FIREBASE_PRIVATE_KEY || "";
const withoutQuotes = rawKey.replace(/^"+|"+$/g, "");
const privateKey    = withoutQuotes.replace(/\\n/g, "\n");

if (!admin.apps.length) {
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing FIREBASE_* admin env vars");
  }
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

export function getAdminDb() {
  return admin.firestore();
}
