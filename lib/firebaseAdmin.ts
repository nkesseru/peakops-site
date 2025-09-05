import * as admin from "firebase-admin";

declare global {
  // eslint-disable-next-line no-var
  var __FIREBASE_ADMIN_APP__: admin.app.App | undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getPem(): string {
  const b64 = process.env.FIREBASE_PRIVATE_KEY_BASE64?.trim();
  if (!b64) throw new Error("Missing FIREBASE_PRIVATE_KEY_BASE64");
  const pem = Buffer.from(b64, "base64").toString("utf8").trim();
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----") || !pem.endsWith("-----END PRIVATE KEY-----")) {
    throw new Error("Invalid PEM decoded from FIREBASE_PRIVATE_KEY_BASE64");
  }
  return pem;
}

const app =
  globalThis.__FIREBASE_ADMIN_APP__ ??
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:  requireEnv("FIREBASE_PROJECT_ID"),
      clientEmail: requireEnv("FIREBASE_CLIENT_EMAIL"),
      privateKey:  getPem(),
    }),
  });

if (!globalThis.__FIREBASE_ADMIN_APP__) globalThis.__FIREBASE_ADMIN_APP__ = app;

export const adminApp = app;
export const db = app.firestore();
export function getAdminDb() { return db; }
