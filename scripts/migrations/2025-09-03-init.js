function initAdmin() {
  if (admin.apps.length) return admin.app();

  // 1) Prefer explicit envs (no OAuth)
  if (process.env.FIREBASE_PRIVATE_KEY_BASE64 &&
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL) {
    const privateKey = Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
    if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----') || !privateKey.trim().endsWith('-----END PRIVATE KEY-----')) {
      throw new Error('Invalid PEM after base64 decode');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
    return admin.app();
  }

  // 2) Final fallback: ADC
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  return admin.app();
}
