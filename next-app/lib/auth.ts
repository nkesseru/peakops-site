import {
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  type ActionCodeSettings,
  type User,
  type UserCredential,
} from "firebase/auth";
import { auth } from "./firebaseClient";

const EMAIL_STORAGE_KEY = "emailForSignIn";

function getActionCodeSettings(): ActionCodeSettings {
  const base = String(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

  const actionCodeSettings = {
    url: `${base}/login`,
    handleCodeInApp: true,
  };

  return actionCodeSettings;
}

export async function sendMagicLink(email: string): Promise<void> {
  const trimmed = String(email || "").trim();
  await sendSignInLinkToEmail(auth, trimmed, getActionCodeSettings());
  if (typeof window !== "undefined") {
    window.localStorage.setItem(EMAIL_STORAGE_KEY, trimmed);
  }
}

export async function completeSignIn(): Promise<UserCredential | null> {
  if (typeof window === "undefined") return null;
  const href = window.location.href;
  if (!isSignInWithEmailLink(auth, href)) return null;

  let email = window.localStorage.getItem(EMAIL_STORAGE_KEY) || "";
  if (!email) {
    email = window.prompt("Please confirm your email to complete sign-in:") || "";
  }
  if (!email) return null;

  const cred = await signInWithEmailLink(auth, email, href);
  window.localStorage.removeItem(EMAIL_STORAGE_KEY);
  return cred;
}

// PEAKOPS_GET_ID_TOKEN_HYDRATE_V1 (2026-04-27)
// On a fresh page navigation Firebase Auth restores its persisted
// session asynchronously after module init, which means `auth.currentUser`
// is briefly null even when the user is in fact signed in. Reading it
// synchronously was causing authedFetch to declare "Not authenticated"
// and redirect to /login mid-navigation. Wait for the first
// onAuthStateChanged callback before deciding the user is logged out.
export async function getIdToken(): Promise<string | null> {
  let user: User | null = auth.currentUser;
  if (!user) {
    user = await new Promise<User | null>((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => {
        unsub();
        resolve(u);
      });
    });
  }
  if (!user) return null;
  return user.getIdToken();
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}
