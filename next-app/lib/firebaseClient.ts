import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

// PEAKOPS_FIREBASE_CLIENT_STATIC_ENV_V1 (2026-04-27)
// Each NEXT_PUBLIC_* reference must be a literal `process.env.NAME` so the
// Next.js bundler can statically inline the value into the client bundle.
// Dynamic forms like `process.env[key]` or loops over a list of names work
// on the server but evaluate to undefined in the browser, which is why a
// previous validation pass falsely threw "Missing environment variable" in
// the browser even when .env.local had the value.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

if (!firebaseConfig.apiKey) throw new Error("Missing environment variable: NEXT_PUBLIC_FIREBASE_API_KEY");
if (!firebaseConfig.authDomain) throw new Error("Missing environment variable: NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
if (!firebaseConfig.projectId) throw new Error("Missing environment variable: NEXT_PUBLIC_FIREBASE_PROJECT_ID");

export const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth: Auth = getAuth(app);
// PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
// Client-side Firestore handle. Used by the /settings page to read +
// write users/{uid}/settings/profile. Not used elsewhere yet — every
// other Firestore touch in this app currently goes server-side via
// firebase-admin.
export const db: Firestore = getFirestore(app);
