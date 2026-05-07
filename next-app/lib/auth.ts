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
//
// PEAKOPS_GET_CURRENT_USER_TOKEN_TIMEOUT_V1 (2026-05-06)
// Slice 12 hardening: add an explicit timeout so a stuck or
// very-slow-to-restore auth session can't hang the whole UI on a
// /api/fn/* request that's waiting for getIdToken(). 3000ms is the
// architecture default — long enough for typical localStorage
// hydration, short enough that a true unauth state propagates to
// the caller quickly.

export type GetCurrentUserTokenOptions = {
  /** Max time to wait for onAuthStateChanged before giving up. */
  timeoutMs?: number;
};

/**
 * Resolve the current Firebase Auth user's ID token, waiting briefly
 * for auth state to restore from persistence if `currentUser` isn't
 * synchronously available yet. Returns `null` on timeout or when the
 * user is genuinely signed out.
 */
export async function getCurrentUserToken(
  opts: GetCurrentUserTokenOptions = {},
): Promise<string | null> {
  const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 3000));
  let user: User | null = auth.currentUser;
  if (!user) {
    user = await new Promise<User | null>((resolve) => {
      let settled = false;
      const finish = (u: User | null) => {
        if (settled) return;
        settled = true;
        resolve(u);
      };
      const unsub = onAuthStateChanged(auth, (u) => {
        unsub();
        finish(u);
      });
      if (timeoutMs > 0) {
        setTimeout(() => {
          // Don't unsubscribe synchronously here — the listener might
          // still be firing concurrently. finish() is idempotent.
          finish(null);
        }, timeoutMs);
      }
    });
  }
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    // Token refresh can fail (network, revoked, etc.) — surface as
    // "no token" rather than a thrown rejection so authedFetch can
    // route it through its standard unauth path.
    return null;
  }
}

/**
 * @deprecated Use `getCurrentUserToken` directly. Kept for the small
 *   number of pre-Slice-12 callers that imported it. Same shape.
 */
export async function getIdToken(): Promise<string | null> {
  return getCurrentUserToken();
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}
