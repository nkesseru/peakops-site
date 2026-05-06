import { getIdToken } from "./auth";

export type AuthedFetchOptions = RequestInit & {
  /**
   * When true (default), a missing token redirects the browser to /login
   * before the request would have been sent. Set false to bubble the
   * "Not authenticated" error to the caller instead.
   */
  redirectOnUnauth?: boolean;
};

/**
 * Centralized wrapper around fetch(). Attaches a Firebase ID token as
 * `Authorization: Bearer <token>` and short-circuits when the user isn't
 * signed in. Same call signature as fetch() so call sites migrate 1:1.
 */
export async function authedFetch(
  input: string,
  init: AuthedFetchOptions = {},
): Promise<Response> {
  const { redirectOnUnauth = true, ...rest } = init;

  const token = await getIdToken();
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
        const here = window.location.pathname + window.location.search + window.location.hash;
        if (here && here.startsWith("/") && !here.startsWith("//") && !here.startsWith("/login")) {
          window.sessionStorage.setItem("peakops_return_to", here);
        }
      } catch {
        /* sessionStorage may be unavailable (private mode); fall through */
      }
      window.location.href = "/login";
    }
    throw new Error("Not authenticated");
  }

  const headers = new Headers(rest.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, { ...rest, headers });
}
