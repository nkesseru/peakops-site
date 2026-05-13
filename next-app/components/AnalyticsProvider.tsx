"use client";

// PEAKOPS_ANALYTICS_PROVIDER_V1 (2026-05-13)
// Mounted once at the root layout. Listens for client-side route
// changes and emits a single PAGE_VIEW per distinct pathname, gated
// on an authenticated user (the analytics_events Firestore rule
// requires userId == request.auth.uid). Unauthenticated visits are
// no-ops; the gating avoids guaranteed-to-fail writes.
//
// Render output: null. The provider mounts purely for its effects
// and never participates in layout, paint, or user-blocking work.
// Errors from logAnalyticsEvent are swallowed inside that helper —
// analytics MUST NOT break product behavior.

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebaseClient";
import { logAnalyticsEvent } from "../lib/analytics";

export default function AnalyticsProvider() {
  const pathname = usePathname();
  const lastEmittedRef = useRef<string>("");
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [signedIn, setSignedIn] = useState<boolean>(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setSignedIn(!!u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!authReady || !signedIn) return;
    if (typeof window === "undefined") return;
    if (!pathname) return;
    if (pathname === lastEmittedRef.current) return;
    lastEmittedRef.current = pathname;
    void logAnalyticsEvent("PAGE_VIEW", { pathname });
  }, [authReady, signedIn, pathname]);

  return null;
}
