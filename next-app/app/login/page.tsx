"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { completeSignIn, sendMagicLink, signOutUser } from "../../lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  // PEAKOPS_LOGIN_NO_ORG_V1 (2026-04-27)
  // Set when the magic-link sign-in succeeds but the user has no
  // `orgIds` custom claim, so we cannot route them to an org-scoped
  // /incidents URL. Renders an explicit blocker instead of a redirect.
  const [signedInNoOrg, setSignedInNoOrg] = useState(false);
  // PEAKOPS_LOGIN_RETURN_TO_V1 (2026-04-28)
  // Set when authedFetch captured the originally-requested URL before
  // bouncing the user here. Surfaces "Sign in to continue…" copy and
  // routes the user back to the deep link on successful sign-in
  // instead of the default org redirect.
  const [pendingReturnTo, setPendingReturnTo] = useState<string>("");
  useEffect(() => {
    try {
      const v = window.sessionStorage.getItem("peakops_return_to") || "";
      if (v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/login")) {
        setPendingReturnTo(v);
      }
    } catch {
      /* sessionStorage unavailable */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cred = await completeSignIn();
        if (!cancelled && cred) {
          window.history.replaceState({}, "", "/login");
          // PEAKOPS_LOGIN_ROUTE_TO_ORG_V1 (2026-04-27)
          // Pull orgIds from the verified ID token claims and route to
          // /incidents?orgId=<first>. /incidents itself now requires
          // orgId in the URL — without this, every user lands on an
          // "Org context required" blocker.
          let firstOrgId = "";
          try {
            const tokenResult = await cred.user.getIdTokenResult();
            const claimsOrgIds = (tokenResult.claims as any)?.orgIds;
            if (Array.isArray(claimsOrgIds) && claimsOrgIds.length > 0) {
              firstOrgId = String(claimsOrgIds[0] || "").trim();
            }
          } catch {
            // fall through to no-org branch
          }
          if (cancelled) return;
          // PEAKOPS_LOGIN_RETURN_TO_V1 (2026-04-28)
          // Prefer the captured return-to URL when authedFetch
          // bounced the user here from a protected deep link.
          // Validate same-origin shape defensively before redirecting.
          let returnTo = "";
          try {
            const v = window.sessionStorage.getItem("peakops_return_to") || "";
            if (v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/login")) {
              returnTo = v;
            }
            window.sessionStorage.removeItem("peakops_return_to");
          } catch {
            /* sessionStorage unavailable; fall back to org redirect */
          }
          if (returnTo) {
            router.push(returnTo);
          } else if (firstOrgId) {
            router.push(`/incidents?orgId=${encodeURIComponent(firstOrgId)}`);
          } else {
            setSignedInNoOrg(true);
          }
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message || e || "Sign-in failed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleNoOrgSignOut() {
    try {
      await signOutUser();
    } catch {
      /* swallow — the next reload will recover */
    }
    setSignedInNoOrg(false);
    setSent(false);
    setEmail("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email.");
      return;
    }
    setSubmitting(true);
    try {
      await sendMagicLink(trimmed);
      setSent(true);
    } catch (e: any) {
      setError(String(e?.message || e || "Could not send login link."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          padding: "32px 28px",
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.03)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 60px rgba(0,0,0,0.5)",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          {signedInNoOrg ? "Account signed in" : "Sign in"}
        </h1>
        <p
          style={{
            fontSize: 13,
            color: "rgba(255,255,255,0.6)",
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          {signedInNoOrg
            ? "We couldn't route you to a workspace."
            : sent
            ? "Check your inbox for a login link."
            : pendingReturnTo
            ? "Sign in to continue to the page you requested."
            : "We'll email you a one-time link to sign in."}
        </p>
        {/* PEAKOPS_LOGIN_DEV_SESSION_CHIP_V1 (2026-04-28)
            Dev-only QA hint surfacing the "not signed in" state and
            (when present) the captured return-to. Hidden in prod. */}
        {process.env.NODE_ENV !== "production" ? (
          <div
            style={{
              marginTop: 8,
              fontSize: 10,
              color: "rgba(255,255,255,0.45)",
              fontFamily: "ui-monospace, monospace",
              wordBreak: "break-all",
            }}
          >
            Session: not signed in
            {pendingReturnTo ? ` · returning to ${pendingReturnTo}` : ""}
          </div>
        ) : null}

        {signedInNoOrg ? (
          <div style={{ marginTop: 18 }}>
            <div
              role="alert"
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                border: "1px solid rgba(220,60,60,0.25)",
                background: "rgba(220,60,60,0.08)",
                color: "#fca5a5",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              Your account is signed in, but no organization access has been
              assigned yet. Contact your PeakOps administrator to request
              access, then sign in again.
            </div>
            <button
              type="button"
              onClick={handleNoOrgSignOut}
              style={{
                marginTop: 16,
                width: "100%",
                padding: "11px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent",
                color: "rgba(255,255,255,0.85)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Sign out and try a different email
            </button>
          </div>
        ) : !sent ? (
          <form onSubmit={handleSubmit} style={{ marginTop: 20 }}>
            <label
              htmlFor="login-email"
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.5)",
                marginBottom: 6,
              }}
            >
              Email
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
              value={email}
              onChange={(ev) => {
                if (error) setError("");
                setEmail(ev.target.value);
              }}
              disabled={submitting}
              style={{
                width: "100%",
                padding: "11px 13px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.04)",
                color: "#fff",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />

            {error ? (
              <div
                role="alert"
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: "#fca5a5",
                  lineHeight: 1.4,
                }}
              >
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              style={{
                marginTop: 16,
                width: "100%",
                padding: "11px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: submitting ? "rgba(255,255,255,0.05)" : "#fff",
                color: submitting ? "rgba(255,255,255,0.5)" : "#000",
                fontSize: 14,
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                transition: "background 120ms ease, color 120ms ease",
              }}
            >
              {submitting ? "Sending…" : "Send Login Link"}
            </button>
          </form>
        ) : (
          <div
            style={{
              marginTop: 18,
              padding: "12px 14px",
              borderRadius: 8,
              border: "1px solid rgba(34,197,94,0.25)",
              background: "rgba(34,197,94,0.08)",
              color: "#86efac",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            Login link sent to <strong style={{ color: "#fff" }}>{email}</strong>.
            Open it on this device to finish signing in.
          </div>
        )}
      </div>
    </main>
  );
}
