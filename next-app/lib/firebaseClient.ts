import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  type Auth,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";

// PEAKOPS_FIREBASE_CLIENT_STATIC_ENV_V1 (2026-04-27)
// Each NEXT_PUBLIC_* reference must be a literal `process.env.NAME` so the
// Next.js bundler can statically inline the value into the client bundle.
// Dynamic forms like `process.env[key]` or loops over a list of names work
// on the server but evaluate to undefined in the browser, which is why a
// previous validation pass falsely threw "Missing environment variable" in
// the browser even when .env.local had the value.

// PEAKOPS_FIREBASE_EMULATOR_PROJECT_OVERRIDE_V1 (2026-05-06)
// Phase 1 Slice 10.1: when the dev session is running against the LOCAL
// emulator suite, we want the Firebase client app to be initialized
// against `peakops-demo` (the same project the emulator runs under and
// the same project the seed scripts write to) — NOT `peakops-pilot`,
// which is production. Without this override, Firestore reads from the
// browser's Firestore SDK go to the emulator under the
// `peakops-pilot` namespace and find nothing seeded; the demo flow
// silently breaks.
//
// Override mechanic:
//   - NEXT_PUBLIC_USE_FIREBASE_EMULATORS=1   ← turns on emulator mode
//   - NEXT_PUBLIC_FIREBASE_PROJECT_ID_EMULATOR ← project id used in
//                                                 emulator mode
//   - In production, both are unset, behavior is unchanged.
//
// Storage bucket also needs a parallel override because storage
// references include the bucket name; misalignment between the
// firebaseConfig bucket and the emulator's bucket fails uploads.
const EMU_FLAG = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "1";
const EMU_PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID_EMULATOR || "";
const EMU_STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_EMULATOR || "";
const AUTH_EMU_HOST = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FS_EMU_HOST = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST || "127.0.0.1:8087";
const STORAGE_EMU_HOST = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";

const baseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const baseStorageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

const useEmuProjectId = EMU_FLAG && EMU_PROJECT_ID;
const useEmuStorageBucket = EMU_FLAG && EMU_STORAGE_BUCKET;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: useEmuProjectId ? EMU_PROJECT_ID : baseProjectId,
  storageBucket: useEmuStorageBucket ? EMU_STORAGE_BUCKET : baseStorageBucket,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

if (!firebaseConfig.apiKey) throw new Error("Missing environment variable: NEXT_PUBLIC_FIREBASE_API_KEY");
if (!firebaseConfig.authDomain) throw new Error("Missing environment variable: NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
if (!firebaseConfig.projectId) throw new Error("Missing environment variable: NEXT_PUBLIC_FIREBASE_PROJECT_ID");

export const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth: Auth = getAuth(app);

// PEAKOPS_AUTH_FAILFAST_V1 (Safari session-restore loop fix)
// Make the persistence choice explicit. Default is already
// browserLocalPersistence (IndexedDB-backed), but setting it
// explicitly documents the contract and gives us a clean fallback
// path. In Safari private mode (and after certain ITP evictions)
// IndexedDB can be unavailable; setPersistence rejects, we fall
// back to inMemoryPersistence so the page at least renders. The
// fallback means sessions don't survive a reload in private mode —
// preferable to an infinite "Restoring your session…" loop.
if (typeof window !== "undefined") {
  setPersistence(auth, browserLocalPersistence).catch(() => {
    // eslint-disable-next-line no-console
    console.warn(
      "[firebaseClient] browserLocalPersistence unavailable; falling back to inMemoryPersistence",
    );
    setPersistence(auth, inMemoryPersistence).catch(() => {
      /* in-memory should never reject; swallow */
    });
  });
}
// PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
// Client-side Firestore handle. Used by the /settings page to read +
// write users/{uid}/settings/profile.
export const db: Firestore = getFirestore(app);
// PEAKOPS_STORAGE_CLIENT_V1 (2026-05-06)
// Client-side Storage handle. Slice 10.1 added this so the emulator
// wire-up below can call connectStorageEmulator. Reading/writing
// storage from the browser is currently routed through Cloud
// Functions, so this handle exists primarily for the emulator
// wiring rather than direct upload.
export const storage: FirebaseStorage = getStorage(app);

// PEAKOPS_FIREBASE_EMULATOR_WIRE_V1 (2026-05-06)
//
// Phase 1 Slice 10/10.1: opt-in client wiring to the local Firebase
// emulator suite. Activated when NEXT_PUBLIC_USE_FIREBASE_EMULATORS=1
// is set at build time. PRODUCTION DEFAULT REMAINS UNCHANGED — the
// flag must be explicitly enabled in .env.local for dev sessions
// that want to hit the local emulator instead of production.
//
// Wiring once per page load via a globalThis sentinel; calling any
// of the connect*Emulator functions twice on the same instance
// throws.
if (typeof window !== "undefined" && EMU_FLAG) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.__peakopsEmulatorWired) {
    g.__peakopsEmulatorWired = true;
    try {
      connectAuthEmulator(auth, `http://${AUTH_EMU_HOST}`, { disableWarnings: true });
      const [fsHost, fsPortStr] = FS_EMU_HOST.split(":");
      connectFirestoreEmulator(db, fsHost || "127.0.0.1", Number(fsPortStr || "8087"));
      const [stHost, stPortStr] = STORAGE_EMU_HOST.split(":");
      connectStorageEmulator(storage, stHost || "127.0.0.1", Number(stPortStr || "9199"));
      console.info("[firebaseClient] connected to local emulators", {
        projectId: firebaseConfig.projectId,
        auth: AUTH_EMU_HOST,
        firestore: FS_EMU_HOST,
        storage: STORAGE_EMU_HOST,
      });
    } catch (e) {
      console.error("[firebaseClient] emulator wire-up failed", e);
    }
  }
}
