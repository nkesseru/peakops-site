// PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
// Typed read/write for users/{uid}/settings/profile. Single doc per
// user — Firestore subcollection-of-one. Easier than a top-level
// `users/{uid}` doc because the security rules cleanly delegate
// "the user owns everything under their settings/" without
// entangling other user-shaped data we may add later (sessions,
// audit prefs, etc.).
//
// Rules at the time of writing:
//   match /users/{uid}/settings/{document=**} {
//     allow read, write: if request.auth.uid == uid;
//   }
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type DocumentReference,
} from "firebase/firestore";
import { db } from "./firebaseClient";

export type DefaultLandingPage =
  | "mission_control"
  | "my_active_work"
  | "review_queue";

export type UserSettings = {
  displayName: string;
  emailUpdatesEnabled: boolean;
  reportReadyAlertsEnabled: boolean;
  defaultLandingPage: DefaultLandingPage;
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  displayName: "",
  emailUpdatesEnabled: true,
  reportReadyAlertsEnabled: true,
  defaultLandingPage: "mission_control",
};

const VALID_LANDING_PAGES: DefaultLandingPage[] = [
  "mission_control",
  "my_active_work",
  "review_queue",
];

function settingsRef(uid: string): DocumentReference {
  // One doc, not a doc-per-key. Settings are read together at page
  // mount and written together on Save — atomic on the user side
  // and avoids N round-trips.
  return doc(db, "users", uid, "settings", "profile");
}

function coerceSettings(raw: any): UserSettings {
  const out: UserSettings = { ...DEFAULT_USER_SETTINGS };
  if (raw && typeof raw === "object") {
    if (typeof raw.displayName === "string") out.displayName = raw.displayName;
    if (typeof raw.emailUpdatesEnabled === "boolean") out.emailUpdatesEnabled = raw.emailUpdatesEnabled;
    if (typeof raw.reportReadyAlertsEnabled === "boolean") out.reportReadyAlertsEnabled = raw.reportReadyAlertsEnabled;
    if (typeof raw.defaultLandingPage === "string" && VALID_LANDING_PAGES.includes(raw.defaultLandingPage)) {
      out.defaultLandingPage = raw.defaultLandingPage;
    }
  }
  return out;
}

export async function loadUserSettings(uid: string): Promise<UserSettings> {
  if (!uid) return { ...DEFAULT_USER_SETTINGS };
  const snap = await getDoc(settingsRef(uid));
  if (!snap.exists()) return { ...DEFAULT_USER_SETTINGS };
  return coerceSettings(snap.data());
}

export async function saveUserSettings(
  uid: string,
  settings: UserSettings,
): Promise<void> {
  if (!uid) throw new Error("uid required");
  // Defensive coerce on the way out too — anything stuffed in by a
  // future ref that doesn't conform to the type gets dropped.
  const safe = coerceSettings(settings);
  await setDoc(
    settingsRef(uid),
    {
      ...safe,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
