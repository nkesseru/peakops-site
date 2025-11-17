import admin from 'firebase-admin';
let app;
export function getDb() {
  if (!app) {
    app = admin.apps.length ? admin.app() : admin.initializeApp(); // ADC
    const pid =
      process.env.GCLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      admin.app().options?.projectId ||
      'unknown';
    console.log('[admin] SINGLETON initialized. project:', pid);
  }
  return admin.firestore();
}
