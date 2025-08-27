import * as admin from "firebase-admin";

const g = global as unknown as { _adminApp?: admin.app.App };

export function getAdminApp() {
  if (g._adminApp) return g._adminApp;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  g._adminApp = admin.app();
  return g._adminApp;
}

export function getAdminDb() {
  return getAdminApp().firestore();
}
