import {
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signOut,
  type ActionCodeSettings,
  type User,
  type UserCredential,
} from "firebase/auth";
import { auth } from "./firebaseClient";

const EMAIL_STORAGE_KEY = "emailForSignIn";

// PEAKOPS_AUTH_CONTINUE_URL_V2 (2026-05-07)
// Resolve actionCodeSettings.url from `window.location.origin`
// instead of `process.env.NEXT_PUBLIC_APP_URL`. Reasons:
//
//   1. The env-var version was empty in Vercel Production (we never
//      set NEXT_PUBLIC_APP_URL — it's not in INTERNAL_ALPHA_DEPLOY_
//      CHECKLIST.md § 1), so the resulting `url` was literally
//      "/login" — Firebase rejected it with
//      auth/invalid-continue-uri because no authorized domain
//      matched.
//   2. window.location.origin always names the exact host the user
//      is on, which is the host they'd already have to be hitting
//      to reach this code. That host is by definition the one we
//      need to add to Firebase Authorized Domains, and it
//      automatically tracks if/when we attach a custom domain
//      (peakops-stormwatch.vercel.app today, custom domain later).
//   3. We deliberately don't use VERCEL_URL: that string changes
//      every preview deploy, and the magic-link email persists for
//      hours. A user clicking yesterday's link would land on a
//      URL that's no longer the canonical production host.
//
// Fallback order:
//   1. window.location.origin (browser only)
//   2. NEXT_PUBLIC_APP_URL (server / non-browser caller; useful for
//      tests or any future server-side flow)
//   3. relative "/login" — Firebase will reject this loudly, which
//      is preferable to silently sending the wrong URL.
//
// returnTo handling stays in sessionStorage (`peakops_return_to`,
// set by RequireAuth and authedFetch's redirect path) — never
// embedded into actionCodeSettings.url, so we never accidentally
// ship an unauthorized-domain URL to Firebase.
function getActionCodeSettings(): ActionCodeSettings {
  let origin = "";
  if (
    typeof window !== "undefined" &&
    window.location &&
    typeof window.location.origin === "string"
  ) {
    origin = window.location.origin.replace(/\/+$/, "");
  } else if (process.env.NEXT_PUBLIC_APP_URL) {
    origin = String(process.env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
  }

  return {
    url: origin ? `${origin}/login` : "/login",
    handleCodeInApp: true,
  };
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

// PEAKOPS_AUTH_PASSWORD_PRIMARY_V1 (PR 48)
// Phase A of the Authentication UX Stabilization (PR 48): email +
// password becomes the primary customer sign-in path; magic-link
// stays enabled as a fallback for users without a password set.
//
// signInWithPassword is a thin wrapper around the SDK call so the
// /login page doesn't have to import from "firebase/auth" directly
// (kept consistent with the existing sendMagicLink / completeSignIn
// surface). Trimming and lower-casing of the email mirrors what
// Firebase itself does server-side, so the caller never sees an
// auth/user-not-found purely because of trailing whitespace.
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<UserCredential> {
  const trimmed = String(email || "").trim();
  return signInWithEmailAndPassword(auth, trimmed, password);
}

// PEAKOPS_AUTH_ACTION_IN_APP_V1 (PR 49 Phase B)
// sendPasswordReset now points the reset link at our in-app handler
// (/auth/action) instead of Firebase's *.firebaseapp.com hosted
// page. Why this matters:
//
//   - The previous handleCodeInApp:false path produced links of
//     the form https://<authDomain>/__/auth/action?... — i.e.
//     firebaseapp.com, a Google-owned property. For users with any
//     Google account active in the same browser, Google's account
//     chooser / security UI could intervene before the reset form
//     rendered, sending them to myaccount.google.com instead of
//     PeakOps. Pilot users were reporting exactly that.
//
//   - handleCodeInApp:true tells Firebase to embed mode + oobCode
//     directly into our continueUrl, so the email link is
//     https://app.peakops.app/auth/action?mode=resetPassword&
//     oobCode=...&apiKey=... — never touching firebaseapp.com.
//     Our /auth/action page consumes the oobCode and calls
//     confirmPasswordReset itself.
export async function sendPasswordReset(email: string): Promise<void> {
  const trimmed = String(email || "").trim();
  // getActionCodeSettings() returns a URL at /login. The new
  // in-app handler lives at /auth/action — derive its URL from the
  // same origin logic so we keep the existing single source of
  // truth for the app's canonical origin.
  const base = getActionCodeSettings();
  const baseUrl = String(base.url || "").replace(/\/login$/, "/auth/action");
  await sendPasswordResetEmail(auth, trimmed, {
    url: baseUrl,
    handleCodeInApp: true,
  });
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
  /**
   * PEAKOPS_CLAIM_ACCESS_HARDENING_V1 (2026-05-11)
   * When true, force the Firebase SDK to mint a fresh ID token
   * server-side instead of returning the locally cached JWT. Used
   * by authedFetch's 403-retry path so a stale token (issued
   * before a server-side setCustomUserClaims update) doesn't keep
   * blocking access to an org the user can in fact reach.
   *
   * Defaults to false so cold-path navigation stays cheap — every
   * /api/fn/* call would otherwise pay a token-mint round-trip.
   */
  forceRefresh?: boolean;
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
    // PEAKOPS_CLAIM_ACCESS_HARDENING_V1 (2026-05-11)
    // Pass `forceRefresh` through to the SDK's getIdToken. The
    // default (false) returns the cached JWT — which is what 99% of
    // calls want. authedFetch only sets it to true on a 403 retry
    // so claim-update propagation isn't gated on the user signing
    // out and back in.
    return await user.getIdToken(opts.forceRefresh === true);
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
