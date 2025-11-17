// src/lib/firebaseAdmin.ts
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import path from "path";

/**
 * Local-dev helper: initialize Firebase Admin from a local service-account.json
 * sitting in the Next app root (next-app/service-account.json).
 */

export function getAdminDb() {
  if (!getApps().length) {
    const saPath = path.join(process.cwd(), "service-account.json");
    const raw = readFileSync(saPath, "utf8");
    const serviceAccount = JSON.parse(raw);

    initializeApp({
      credential: cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
      }),
    });
  }

  // Use the default app (the one we just initialized above)
  return getFirestore();
}
