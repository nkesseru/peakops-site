"use client";

// PEAKOPS_DIAGNOSTICS_PANEL_V1 (2026-05-15)
//
// Operator/debug diagnostics surface for the migration and onboarding
// period. Renders ONLY when `?debug=1` is in the URL — invisible in
// every other case, in production or otherwise.
//
// SECURITY POSTURE:
//   - Never displays or copies the Firebase ID token JWT string.
//   - Never includes API keys, service account creds, or any other
//     server-side secret in the copy payload.
//   - The whitelisted fields below are the ONLY values exposed; this
//     is enforced by hand-building the payload object rather than
//     spreading auth state. PR review should verify the whitelist.
//
// RENDER GATE:
//   - Outer component returns null when `?debug=1` is absent — does
//     NOT call useAuth or any Firebase SDK code on that path, so
//     non-debug renders pay zero auth-subscription cost.
//   - Inner component mounts only when debug=1, and only there does
//     it subscribe to useAuth + read token metadata.

import { useEffect, useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { useAuth } from "../hooks/useAuth";
import { auth } from "../lib/firebaseClient";

export default function DiagnosticsPanel() {
  const sp = useSearchParams();
  const debug = sp?.get("debug") === "1";
  if (!debug) return null;
  return <DiagnosticsPanelInner />;
}

type TokenMetadata = {
  present: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  remainingSec: number | null;
};

function DiagnosticsPanelInner() {
  const { user, claims, loading } = useAuth();
  const pathname = usePathname();
  const sp = useSearchParams();
  const orgIdFromSearch = String(sp?.get("orgId") || "");
  const searchString = sp ? `?${sp.toString()}` : "";

  const [token, setToken] = useState<TokenMetadata>({
    present: false,
    issuedAt: null,
    expiresAt: null,
    remainingSec: null,
  });
  const [tick, setTick] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok" | "err">("idle");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Server-side / no-user → empty token metadata.
    if (typeof window === "undefined") return;
    if (!user) {
      setToken({ present: false, issuedAt: null, expiresAt: null, remainingSec: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cur = auth.currentUser;
        if (!cur) return;
        // getIdTokenResult returns { token, expirationTime, issuedAtTime, claims, ... }.
        // We deliberately destructure ONLY the timestamps and never read .token here.
        const result = await cur.getIdTokenResult(false);
        if (cancelled) return;
        const issuedAt = String(result.issuedAtTime || "");
        const expiresAt = String(result.expirationTime || "");
        const expMs = expiresAt ? Date.parse(expiresAt) : NaN;
        const remainingSec = Number.isFinite(expMs)
          ? Math.max(0, Math.floor((expMs - Date.now()) / 1000))
          : null;
        setToken({ present: true, issuedAt, expiresAt, remainingSec });
      } catch {
        if (cancelled) return;
        setToken({ present: false, issuedAt: null, expiresAt: null, remainingSec: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, tick]);

  // Refresh the remainingSec readout each second without re-fetching the token.
  useEffect(() => {
    if (!token.expiresAt) return;
    const interval = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(interval);
  }, [token.expiresAt]);

  const functionsBase =
    process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE ||
    process.env.NEXT_PUBLIC_FUNCTIONS_BASE ||
    process.env.FUNCTIONS_BASE ||
    "(unset)";
  const environment = process.env.NODE_ENV || "(unknown)";
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV || "(unset)";
  const buildCommit =
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_BUILD_VERSION ||
    "(unset)";

  // Whitelisted copy payload — never spread auth or token results here.
  function buildCopyPayload() {
    return {
      timestamp: new Date().toISOString(),
      auth: {
        email: user?.email || null,
        uid: user?.uid || null,
        tokenPresent: token.present,
        tokenIssuedAt: token.issuedAt,
        tokenExpiresAt: token.expiresAt,
        tokenRemainingSec: token.remainingSec,
      },
      claims: {
        role: claims?.role || null,
        orgIds: Array.isArray(claims?.orgIds) ? claims.orgIds : [],
      },
      route: {
        pathname: pathname || null,
        search: searchString,
        orgIdFromSearch: orgIdFromSearch || null,
      },
      runtime: {
        environment,
        vercelEnv,
        functionsBase,
        buildCommit,
      },
    };
  }

  async function handleCopy() {
    try {
      const payload = JSON.stringify(buildCopyPayload(), null, 2);
      await navigator.clipboard.writeText(payload);
      setCopyStatus("ok");
      window.setTimeout(() => setCopyStatus("idle"), 1800);
    } catch {
      setCopyStatus("err");
      window.setTimeout(() => setCopyStatus("idle"), 2400);
    }
  }

  if (dismissed) return null;

  function truncate(value: string | null | undefined, len = 16): string {
    const s = String(value || "");
    if (!s) return "(none)";
    if (s.length <= len) return s;
    return s.slice(0, len) + "…";
  }

  function fmtTime(iso: string | null): string {
    if (!iso) return "(none)";
    try {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "(invalid)" : d.toISOString().slice(11, 19) + " UTC";
    } catch {
      return "(invalid)";
    }
  }

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 11,
    lineHeight: 1.6,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  };
  const labelStyle: React.CSSProperties = { color: "rgba(255,255,255,0.55)" };
  const valueStyle: React.CSSProperties = { color: "rgba(255,255,255,0.92)", textAlign: "right" };
  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.12em",
    color: "rgba(255,193,7,0.85)",
    textTransform: "uppercase",
    marginTop: 10,
    marginBottom: 4,
  };

  return (
    <div
      role="complementary"
      aria-label="Operator diagnostics"
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 9999,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
        background: "rgba(20,20,20,0.96)",
        border: "1px solid rgba(255,193,7,0.35)",
        borderRadius: 10,
        padding: "10px 12px 12px 12px",
        color: "rgba(255,255,255,0.92)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.16em",
            color: "rgba(255,193,7,0.85)",
          }}
        >
          DIAGNOSTICS · ?debug=1
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Close diagnostics panel"
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.55)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ fontSize: 10, color: "rgba(255,193,7,0.7)", marginTop: 4, lineHeight: 1.4 }}>
        Operator diagnostics — don&apos;t share these values publicly.
      </div>

      <div style={sectionHeaderStyle}>Auth</div>
      <div style={rowStyle}>
        <span style={labelStyle}>email:</span>
        <span style={valueStyle}>{loading ? "(loading)" : truncate(user?.email, 24)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>uid:</span>
        <span style={valueStyle}>{loading ? "(loading)" : truncate(user?.uid, 18)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>token:</span>
        <span style={valueStyle}>{token.present ? "present ✓" : loading ? "(loading)" : "absent"}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>issued:</span>
        <span style={valueStyle}>{fmtTime(token.issuedAt)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>expires:</span>
        <span style={valueStyle}>
          {fmtTime(token.expiresAt)}
          {token.remainingSec != null ? ` (${Math.floor(token.remainingSec / 60)}m${token.remainingSec % 60}s)` : ""}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>role claim:</span>
        <span style={valueStyle}>{claims?.role || "(none)"}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>orgIds claim:</span>
        <span style={valueStyle}>
          {claims?.orgIds && claims.orgIds.length > 0 ? truncate(claims.orgIds.join(","), 22) : "(none)"}
        </span>
      </div>

      <div style={sectionHeaderStyle}>Route</div>
      <div style={rowStyle}>
        <span style={labelStyle}>path:</span>
        <span style={valueStyle}>{truncate(pathname, 28)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>orgId (url):</span>
        <span style={valueStyle}>{orgIdFromSearch ? truncate(orgIdFromSearch, 22) : "(none)"}</span>
      </div>

      <div style={sectionHeaderStyle}>Runtime</div>
      <div style={rowStyle}>
        <span style={labelStyle}>env:</span>
        <span style={valueStyle}>{environment}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>vercelEnv:</span>
        <span style={valueStyle}>{vercelEnv}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>functions:</span>
        <span style={valueStyle}>{truncate(functionsBase.replace(/^https?:\/\//, ""), 26)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>build:</span>
        <span style={valueStyle}>{truncate(buildCommit, 12)}</span>
      </div>

      <button
        type="button"
        onClick={handleCopy}
        style={{
          marginTop: 10,
          width: "100%",
          padding: "7px 10px",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          color:
            copyStatus === "ok"
              ? "rgba(46,213,115,0.95)"
              : copyStatus === "err"
              ? "rgba(255,107,107,0.95)"
              : "rgba(255,193,7,0.95)",
          background: "rgba(255,193,7,0.06)",
          border: "1px solid rgba(255,193,7,0.25)",
          borderRadius: 6,
          cursor: "pointer",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {copyStatus === "ok" ? "Copied ✓" : copyStatus === "err" ? "Copy failed — see console" : "Copy diagnostics"}
      </button>
    </div>
  );
}
