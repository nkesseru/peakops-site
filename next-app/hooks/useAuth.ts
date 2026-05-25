"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "../lib/firebaseClient";

export type UseAuthClaims = {
  /** Single primary role string from the Firebase custom claim, lowercased. */
  role: string;
  /** All orgIds the user has access to, derived from the custom claim. */
  orgIds: string[];
};

export type UseAuthState = {
  user: User | null;
  loading: boolean;
  claims: UseAuthClaims;
};

const EMPTY_CLAIMS: UseAuthClaims = { role: "", orgIds: [] };

// PEAKOPS_AUTH_FAILFAST_V1 (Safari session-restore loop fix)
//
// Two unguarded async dependencies were locking Safari users out:
//
//   A. onAuthStateChanged's initial callback never fires when
//      Firebase Auth's IndexedDB-backed persistence layer stalls
//      (Safari private mode, ITP eviction, first-paint-after-idle,
//      certain iframe configurations). loading stays true forever.
//
//   B. Inside the callback, await next.getIdTokenResult() hits
//      securetoken.googleapis.com to refresh. Safari ITP can block
//      that round-trip; if it hangs, the setLoading(false) line
//      below the await never runs.
//
// Both produce the same visible symptom: "Checking session… /
// Restoring your session…" panel renders forever. RequireAuth +
// /login both gate on loading.
//
// Bounded timers race against each waiting state. On timeout we
// treat as anonymous (user=null, claims=empty, loading=false) so
// RequireAuth bounces cleanly to /login. We deliberately do NOT
// sign out — the persisted session stays in place, so when Safari
// eventually restores it on a later page load it just works. The
// "continue-as" panel on /login (PR 48) picks up the user once
// onAuthStateChanged finally fires.
const AUTH_INIT_TIMEOUT_MS = 7000;
const TOKEN_RESULT_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`peakops_auth_timeout:${tag}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export function useAuth(): UseAuthState {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<UseAuthClaims>(EMPTY_CLAIMS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let listenerFired = false;

    // Defense-in-depth init timer. If onAuthStateChanged hasn't
    // fired its initial callback before this fires, treat the page
    // as anonymous and unblock the UI. Subsequent listener fires
    // (if/when persistence eventually restores) still update state.
    const initTimer = setTimeout(() => {
      if (cancelled || listenerFired) return;
      // eslint-disable-next-line no-console
      console.warn(
        "[useAuth] init timeout — onAuthStateChanged did not fire within " +
          AUTH_INIT_TIMEOUT_MS +
          "ms (likely Safari IndexedDB stall). Failing fast as anonymous.",
      );
      setUser(null);
      setClaims(EMPTY_CLAIMS);
      setLoading(false);
    }, AUTH_INIT_TIMEOUT_MS);

    const unsubscribe = onAuthStateChanged(auth, async (next) => {
      listenerFired = true;
      clearTimeout(initTimer);
      if (cancelled) return;

      setUser(next);
      if (next) {
        try {
          const tokenResult = await withTimeout(
            next.getIdTokenResult(),
            TOKEN_RESULT_TIMEOUT_MS,
            "getIdTokenResult",
          );
          if (cancelled) return;
          const c: any = tokenResult.claims || {};
          const orgIds = Array.isArray(c.orgIds)
            ? c.orgIds.map((v: any) => String(v))
            : [];
          const role = String(c.role || "").toLowerCase();
          setClaims({ role, orgIds });
        } catch {
          if (!cancelled) setClaims(EMPTY_CLAIMS);
        }
      } else {
        setClaims(EMPTY_CLAIMS);
      }
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      clearTimeout(initTimer);
      unsubscribe();
    };
  }, []);

  return { user, loading, claims };
}
