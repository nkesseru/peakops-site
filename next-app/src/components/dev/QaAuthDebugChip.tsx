"use client";

/**
 * PEAKOPS_QA_AUTH_DEBUG_V1 (2026-04-28)
 *
 * Dev/QA-only chip that surfaces the *force-refreshed* Firebase Auth
 * claims for the current user, plus a "Refresh permissions" button
 * that calls getIdToken(true) and reloads the page.
 *
 * Why it exists: the cached useAuth().claims reads the ID token that
 * Firebase decided to give us at sign-in. When custom claims change
 * server-side (setCustomUserClaims), the cached token doesn't notice
 * until the next refresh. This chip:
 *   1. Calls user.getIdTokenResult(true) on mount to *force* a token
 *      refresh and show the truly-current role + orgIds.
 *   2. Provides an explicit "Refresh permissions" button so a tester
 *      can re-fetch + reload after running setCustomUserClaims server-
 *      side, without manually signing out and back in.
 *
 * Hidden in production — guarded on process.env.NODE_ENV. Renders
 * nothing in prod and is dead-code-eliminated by Next.js.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

type FreshClaims = {
  email: string;
  role: string;
  orgIds: string[];
};

export default function QaAuthDebugChip() {
  const { user } = useAuth();
  const [fresh, setFresh] = useState<FreshClaims | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // PEAKOPS_QA_CHIP_GATE_V2 (2026-04-29)
  // Render only when NODE_ENV !== "production" *and* the URL carries
  // ?dev=1. Customers can hit production with no chip in sight; QA
  // testers add ?dev=1 to surface it. Reading window.location directly
  // (instead of useSearchParams) keeps the chip render-cheap and
  // independent of the parent's Suspense tree.
  const isDev = process.env.NODE_ENV !== "production";
  const [devFlag, setDevFlag] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = String(sp.get("dev") || "").trim();
      setDevFlag(v === "1" || v.toLowerCase() === "true");
    } catch {
      setDevFlag(false);
    }
  }, []);
  const visible = isDev && devFlag;

  useEffect(() => {
    if (!visible || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const tr = await user.getIdTokenResult(true);
        if (cancelled) return;
        const c: any = tr.claims || {};
        setFresh({
          email: String(user.email || ""),
          role: String(c.role || "").toLowerCase(),
          orgIds: Array.isArray(c.orgIds) ? c.orgIds.map((v: any) => String(v)) : [],
        });
      } catch {
        /* silent — falls through to cached useAuth().claims display */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, visible]);

  if (!visible) return null;
  if (!user) return null;

  async function refreshPermissions() {
    if (!user) return;
    setRefreshing(true);
    try {
      await user.getIdToken(true);
    } catch {
      /* swallow — reload below will re-run the auth init */
    }
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  const email = fresh?.email || String(user.email || "");
  const role = fresh?.role || "(loading…)";
  const orgIds = fresh?.orgIds || [];

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px dashed rgba(200,168,78,0.45)",
        background: "rgba(200,168,78,0.06)",
        fontSize: 10,
        color: "#C8A84E",
        fontFamily: "ui-monospace, monospace",
        flexWrap: "wrap",
        maxWidth: "100%",
      }}
      title="QA-only debug chip (visible in dev/local only). Force-refreshed Firebase Auth claims for the current user."
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const }}>
        QA
      </span>
      <span style={{ color: "#b3b3b3" }}>{email || "(no email)"}</span>
      <span style={{ color: "#6f6f6f" }}>·</span>
      <span>
        role: <b style={{ color: "#f5f5f5" }}>{role || "(none)"}</b>
      </span>
      <span style={{ color: "#6f6f6f" }}>·</span>
      <span>
        orgs: <b style={{ color: "#f5f5f5" }}>[{orgIds.join(", ") || "(none)"}]</b>
      </span>
      <button
        type="button"
        disabled={refreshing}
        onClick={refreshPermissions}
        style={{
          marginLeft: 4,
          padding: "2px 8px",
          borderRadius: 4,
          border: "1px solid rgba(200,168,78,0.35)",
          background: "rgba(200,168,78,0.10)",
          color: "#C8A84E",
          cursor: refreshing ? "wait" : "pointer",
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        {refreshing ? "Refreshing…" : "Refresh permissions"}
      </button>
    </div>
  );
}
