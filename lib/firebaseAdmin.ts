import * as admin from "firebase-admin";

// Read base envs
const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

// Build a robust PEM from env:
// 1) Prefer base64 (avoids any \n or quote issues),
// 2) Fallback to raw with \n escapes (strip quotes, convert \n to newlines).
function buildPem(): string {
  const b64 = process.env.FIREBASE_PRIVATE_KEY_BASE64?.trim();
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      // fall through to next method
    }
  }
  const raw = process.env.FIREBASE_PRIVATE_KEY || "";
  const withoutQuotes = raw.replace(/^"+|"+$/g, ""); // remove wrapping quotes if pasted
  return withoutQuotes.replace(/\\n/g, "\n");
}

const privateKey = buildPem();

if (!admin.apps.length) {
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing FIREBASE_* admin env vars");
  }

  // quick guard so we fail fast if PEM is malformed
  const begins = privateKey.startsWith("-----BEGIN PRIVATE KEY-----");
  const ends   = privateKey.trim().endsWith("-----END PRIVATE KEY-----");
  if (!begins || !ends) {
    throw new Error("Invalid PEM: missing BEGIN/END lines after sanitize");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

// Named + default-ish exports for compatibility
export function getAdminDb() {
  return admin.firestore();
}
export const db = admin.firestore();
