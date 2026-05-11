import { getCurrentUserToken } from "./auth";

export type AuthedFetchOptions = RequestInit & {
  /**
   * When true (default), a missing token redirects the browser to /login
   * before the request would have been sent. Set false to bubble the
   * "Not authenticated" error to the caller instead.
   */
  redirectOnUnauth?: boolean;
  /**
   * Override the default 3000ms wait for auth state to restore from
   * persistence. Rarely useful — the default handles a fresh page
   * load, and a longer wait usually masks a real auth-state bug.
   */
  authTimeoutMs?: number;
};

/**
 * Centralized wrapper around fetch(). Attaches a Firebase ID token as
 * `Authorization: Bearer <token>` and short-circuits when the user
 * isn't signed in. Same call signature as fetch() so call sites
 * migrate 1:1.
 *
 * PEAKOPS_AUTHED_FETCH_HARDENING_V1 (2026-05-06)
 * Slice 12 hardening:
 *   - Token resolution flows through getCurrentUserToken({ timeoutMs })
 *     so a stuck auth restore can't hang the UI indefinitely.
 *   - If the caller already provided an Authorization header in
 *     `init.headers`, that wins — the wrapper does not silently
 *     overwrite it. (Useful for tests or rare flows that want a
 *     specific token.)
 *   - The thrown error string is more diagnostic ("authedFetch:
 *     not signed in") so the call-site catch block has something
 *     specific to log.
 */
export async function authedFetch(
  input: string,
  init: AuthedFetchOptions = {},
): Promise<Response> {
  const {
    redirectOnUnauth = true,
    authTimeoutMs,
    ...rest
  } = init;

  const headers = new Headers(rest.headers || {});

  // If the caller pre-set Authorization, trust them and skip the
  // token-resolve path. This keeps the wrapper composable with any
  // future server-to-server flow that mints its own bearer.
  // PEAKOPS_AUTHED_FETCH_HARDENING_V1 (2026-05-06)
  // Track whether we minted the Authorization header ourselves. Only
  // in that case can we safely retry with a fresh token on 403 —
  // caller-provided tokens are theirs to manage.
  let mintedAuthHeader = false;
  if (!headers.has("Authorization") && !headers.has("authorization")) {
    const token = await getCurrentUserToken({ timeoutMs: authTimeoutMs ?? 3000 });
    if (!token) {
      if (redirectOnUnauth && typeof window !== "undefined") {
        // PEAKOPS_AUTH_RETURN_TO_V1 (2026-04-28)
        // Capture the originally-requested URL (path + query + hash)
        // in sessionStorage so the login page can return the user
        // here after they sign in. /login is the only redirect
        // target — never store /login itself, and never store
        // protocol-relative or off-origin URLs (sessionStorage is
        // same-origin already, but defense-in-depth).
        try {
          const here =
            window.location.pathname + window.location.search + window.location.hash;
          if (
            here &&
            here.startsWith("/") &&
            !here.startsWith("//") &&
            !here.startsWith("/login")
          ) {
            window.sessionStorage.setItem("peakops_return_to", here);
          }
        } catch {
          /* sessionStorage may be unavailable (private mode); fall through */
        }
        window.location.href = "/login";
      }
      throw new Error("authedFetch: not signed in");
    }
    headers.set("Authorization", `Bearer ${token}`);
    mintedAuthHeader = true;
  }

  const firstResponse = await fetch(input, { ...rest, headers });

  // PEAKOPS_CLAIM_ACCESS_HARDENING_V1 (2026-05-11)
  // If the server returned 403 and we minted the Authorization
  // header from the cached token, retry ONCE with a force-refreshed
  // token. Covers the common case where custom claims (notably
  // `orgIds`) were updated server-side but the browser still holds
  // a pre-update cached JWT — Firebase only embeds custom claims in
  // tokens minted AFTER setCustomUserClaims, and the SDK's default
  // getIdToken() returns the cached token until it naturally
  // expires (~1 hour).
  //
  // Scope:
  //   - 403 only (401 = bad/missing token; not a claim-staleness
  //     signal — let the caller handle).
  //   - mintedAuthHeader === true (caller-supplied tokens are theirs).
  //   - One retry maximum; if the fresh token still 403s, the
  //     denial is real and propagates to the caller untouched.
  //
  // Side effect: a single extra Firebase Auth token-mint network
  // call on the unhappy 403 path. Cheap, and pays for itself by
  // removing the "sign out and back in" workaround for buyers
  // whose org access has just been provisioned.
  if (firstResponse.status === 403 && mintedAuthHeader) {
    const freshToken = await getCurrentUserToken({
      timeoutMs: authTimeoutMs ?? 3000,
      forceRefresh: true,
    });
    if (freshToken) {
      const retryHeaders = new Headers(rest.headers || {});
      retryHeaders.set("Authorization", `Bearer ${freshToken}`);
      return fetch(input, { ...rest, headers: retryHeaders });
    }
  }

  return firstResponse;
}
