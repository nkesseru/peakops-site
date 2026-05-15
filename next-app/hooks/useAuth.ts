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

export function useAuth(): UseAuthState {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<UseAuthClaims>(EMPTY_CLAIMS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (next) => {
      setUser(next);
      if (next) {
        try {
          const tokenResult = await next.getIdTokenResult();
          const c: any = tokenResult.claims || {};
          const orgIds = Array.isArray(c.orgIds)
            ? c.orgIds.map((v: any) => String(v))
            : [];
          const role = String(c.role || "").toLowerCase();
          setClaims({ role, orgIds });
        } catch {
          setClaims(EMPTY_CLAIMS);
        }
      } else {
        setClaims(EMPTY_CLAIMS);
      }
      setLoading(false);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return { user, loading, claims };
}
