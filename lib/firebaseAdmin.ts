import * as admin from "firebase-admin";

// Keep a single Admin app across dev hot-reloads
declare global {
  // eslint-disable-next-line no-var
  var __FIREBASE_ADMIN_APP__: admin.app.App | undefined;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing env: ${name}`);
  }
  return v;
}

function privateKeyFromEnv(): string {
  // Preferred: base64-encoded PEM (no newline/quote issues)
  const b64 = process.env.FIREBASE_PRIVATE_KEY_BASE64?.trim();
  if (b64) {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    if (
      pem.startsWith("-----BEGIN PRIVATE KEY-----") &&
      pem.trim().endsWith("-----END PRIVATE KEY-----")
    ) {
      return pem;
    }
    throw new Error("Invalid PEM after base64 decode");
  }

  // Fallback: FIREBASE_PRIVATE_KEY with \n escapes
  const raw = process.env.FIREBASE_PRIVATE_KEY;
  if (raw) {
    const withoutQuotes = raw.replace(/^"+|"+$/g, ""); // strip accidental wrapping quotes
    const pem = withoutQuotes.replace(/\\n/g, "\n");   // unescape newlines
    if (
      pem.startsWith("-----BEGIN PRIVATE KEY-----") &&
      pem.trim().endsWith("-----END PRIVATE KEY-----")
    ) {
      return pem;
    }
    throw new Error("Invalid PEM in FIREBASE_PRIVATE_KEY");
  }

  throw new Error(
    "Missing FIREBASE_PRIVATE_KEY_BASE64 (preferred) or FIREBASE_PRIVATE_KEY"
  );
}

const app =
  globalThis.__FIREBASE_ADMIN_APP__ ??
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: req("FIREBASE_PROJECT_ID"),
      clientEmail: req("FIREBASE_CLIENT_EMAIL"),
      privateKey: privateKeyFromEnv(),
    }),
  });

if (!globalThis.__FIREBASE_ADMIN_APP__) {
  globalThis.__FIREBASE_ADMIN_APP__ = app;
}

export const adminApp = app;
export const db = admin.firestore();
export function getAdminDb() {
  return db;
}
