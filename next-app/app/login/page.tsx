"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isSignInWithEmailLink } from "firebase/auth";
import { auth } from "../../lib/firebaseClient";
import { completeSignIn, sendMagicLink, signOutUser } from "../../lib/auth";
import { useAuth } from "../../hooks/useAuth";
import { logAnalyticsEvent } from "../../lib/analytics";

// PEAKOPS_LOGIN_FRIENDLY_AUTH_ERRORS_V1 (2026-05-11)
// Map raw Firebase Auth error codes to calm, operational copy that
// reads as product instead of stack trace. Falls through to a
// sanitized default so unknown codes never surface as
// "Firebase: Error (auth/internal-error)" in the UI.
function friendlyAuthError(err: unknown): string {
  const code = String((err as any)?.code || "").toLowerCase();
  const msg = String((err as any)?.message || err || "");
  const blob = `${code} ${msg}`.toLowerCase();
  if (blob.includes("expired-action-code") || blob.includes("expired")) {
    return "This sign-in link has expired. Send yourself a new one below.";
  }
  if (blob.includes("invalid-action-code")) {
    return "This sign-in link is no longer valid — it may have already been used. Send yourself a new one below.";
  }
  if (blob.includes("invalid-email")) {
    return "That email address doesn't look right. Double-check and try again.";
  }
  if (blob.includes("quota-exceeded") || blob.includes("too-many-requests")) {
    return "Too many sign-in attempts in a short window. Wait a minute and try again.";
  }
  if (blob.includes("user-disabled")) {
    return "This account has been disabled. Contact your PeakOps administrator.";
  }
  if (blob.includes("network-request-failed") || blob.includes("network error")) {
    return "Network unavailable. Check your connection and try again.";
  }
  if (blob.includes("missing-email")) {
    return "Please confirm the email associated with this link.";
  }
  if (blob.includes("unauthorized-continue-uri") || blob.includes("invalid-continue-uri")) {
    return "Sign-in isn't configured for this domain yet. Contact your PeakOps administrator.";
  }
  return "Sign-in didn't complete. Request a new login link below.";
}

function readReturnTo(): string {
  if (typeof window === "undefined") return "";
  try {
    const v = window.sessionStorage.getItem("peakops_return_to") || "";
    if (v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/login")) {
      return v;
    }
  } catch {
    /* sessionStorage unavailable */
  }
  return "";
}

function clearReturnTo() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem("peakops_return_to");
  } catch {
    /* sessionStorage unavailable */
  }
}

export default function LoginPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  // PEAKOPS_LOGIN_NO_ORG_V1 (2026-04-27)
  const [signedInNoOrg, setSignedInNoOrg] = useState(false);
  // PEAKOPS_LOGIN_RETURN_TO_V1 (2026-04-28)
  const [pendingReturnTo, setPendingReturnTo] = useState<string>("");

  // PEAKOPS_LOGIN_CONTINUE_AS_V1 (2026-05-11)
  // Synchronously detect on mount whether the URL is a magic-link
  // completion. We render different UI for a fresh sign-in
  // attempt (URL contains the link) versus an already-authenticated
  // session landing on /login (Continue-as panel).
  // `null` = not yet evaluated (SSR / first render), so we render a
  // calm loading panel rather than flashing either branch.
  const [hasIncomingLink, setHasIncomingLink] = useState<boolean | null>(null);
  const [completing, setCompleting] = useState(false);
  // Re-route in flight for the "Continue as" CTA so we can disable
  // the button and show a calm in-progress label.
  const [continuing, setContinuing] = useState(false);

  useEffect(() => {
    setPendingReturnTo(readReturnTo());
    if (typeof window !== "undefined") {
      try {
        setHasIncomingLink(isSignInWithEmailLink(auth, window.location.href));
      } catch {
        setHasIncomingLink(false);
      }
    } else {
      setHasIncomingLink(false);
    }
  }, []);

  // Route the user post-sign-in. Prefers the captured return-to URL
  // (set by RequireAuth / authedFetch when bouncing through /login),
  // falls back to /incidents?orgId=<first> from the verified token
  // claims, and finally surfaces the no-org blocker.
  function routeAfterSignIn(firstOrgId: string) {
    const returnTo = readReturnTo();
    clearReturnTo();
    if (returnTo) {
      router.push(returnTo);
      return;
    }
    if (firstOrgId) {
      router.push(`/incidents?orgId=${encodeURIComponent(firstOrgId)}`);
      return;
    }
    setSignedInNoOrg(true);
  }

  // Magic-link completion. Only runs when the URL actually contains
  // an incoming link; otherwise we let the continue-as / form UI
  // take over.
  useEffect(() => {
    if (hasIncomingLink !== true) return;
    let cancelled = false;
    setCompleting(true);
    (async () => {
      try {
        const cred = await completeSignIn();
        if (cancelled) return;
        if (cred) {
          void logAnalyticsEvent("USER_SIGNED_IN", { source: "magic_link" });
          // Strip the now-consumed magic-link query off the URL so a
          // refresh doesn't try to redeem the same code again.
          try {
            window.history.replaceState({}, "", "/login");
          } catch {
            /* history API blocked */
          }
          let firstOrgId = "";
          try {
            const tokenResult = await cred.user.getIdTokenResult();
            const orgIds = (tokenResult.claims as any)?.orgIds;
            if (Array.isArray(orgIds) && orgIds.length > 0) {
              firstOrgId = String(orgIds[0] || "").trim();
            }
          } catch {
            /* fall through to no-org branch */
          }
          if (cancelled) return;
          routeAfterSignIn(firstOrgId);
        }
      } catch (e) {
        if (!cancelled) {
          setError(friendlyAuthError(e));
          // Strip the link params so the user can request a fresh
          // link without the failed code re-triggering on refresh.
          try {
            window.history.replaceState({}, "", "/login");
          } catch {
            /* history API blocked */
          }
          setHasIncomingLink(false);
        }
      } finally {
        if (!cancelled) setCompleting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasIncomingLink]);

  async function handleContinueAs() {
    if (!user || continuing) return;
    setError("");
    setContinuing(true);
    try {
      // Pull fresh claims from the token rather than relying on the
      // useAuth claims cache — useAuth resolves them asynchronously
      // after the user object lands, and we want to be authoritative
      // about orgIds at the moment of the click.
      const tokenResult = await user.getIdTokenResult();
      const orgIds = (tokenResult.claims as any)?.orgIds;
      let firstOrgId = "";
      if (Array.isArray(orgIds) && orgIds.length > 0) {
        firstOrgId = String(orgIds[0] || "").trim();
      }
      void logAnalyticsEvent("USER_SIGNED_IN", { source: "continue_as" });
      routeAfterSignIn(firstOrgId);
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setContinuing(false);
    }
  }

  async function handleSwitchAccount() {
    setError("");
    try {
      await signOutUser();
    } catch {
      /* surface via auth state change */
    }
    setEmail("");
    setSent(false);
  }

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
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setSubmitting(false);
    }
  }

  // PEAKOPS_LOGIN_VIEW_PHASE_V1 (2026-05-11)
  // Single derived view phase keeps the JSX below readable. Order
  // matters: completing wins over continue-as so a click on a fresh
  // magic link never flashes the previous session's "Continue as".
  type Phase = "boot" | "completing" | "no-org" | "sent" | "continue" | "form";
  const phase: Phase = (() => {
    if (hasIncomingLink === null) return "boot";
    if (completing) return "completing";
    if (signedInNoOrg) return "no-org";
    if (sent) return "sent";
    if (!authLoading && user && hasIncomingLink === false) return "continue";
    if (authLoading && !error) return "boot";
    return "form";
  })();

  const heading =
    phase === "no-org"
      ? "Account signed in"
      : phase === "continue"
      ? "Welcome back"
      : phase === "completing"
      ? "Signing you in"
      : phase === "boot"
      ? "PeakOps"
      : "Sign in";

  const subhead = (() => {
    if (phase === "no-org") return "We couldn't route you to a workspace.";
    if (phase === "continue") {
      return pendingReturnTo
        ? "You're already signed in. Continue to the page you requested, or use a different account."
        : "You're already signed in. Continue to PeakOps, or use a different account.";
    }
    if (phase === "completing") return "Verifying your sign-in link…";
    if (phase === "boot") return "Checking session…";
    if (phase === "sent") return "Check your inbox for a login link.";
    if (pendingReturnTo) return "Sign in to continue to the page you requested.";
    return "We'll email you a one-time link to sign in.";
  })();

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
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 60px rgba(0,0,0,0.5)",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{heading}</h1>
        <p
          style={{
            fontSize: 13,
            color: "rgba(255,255,255,0.6)",
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          {subhead}
        </p>

        {/* Secondary reassurance / session hint */}
        {phase === "form" || phase === "sent" ? (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: "rgba(255,255,255,0.55)",
              lineHeight: 1.45,
            }}
          >
            {pendingReturnTo
              ? "After sign-in, we'll take you back to your requested page."
              : "Sign in to continue to PeakOps."}
          </div>
        ) : null}

        {/* Dev-only return-to diagnostics — never shown to buyers */}
        {process.env.NODE_ENV !== "production" &&
        pendingReturnTo &&
        (phase === "form" || phase === "sent" || phase === "continue") ? (
          <div
            aria-hidden
            style={{
              marginTop: 4,
              fontSize: 10,
              color: "rgba(255,255,255,0.28)",
              fontFamily: "ui-monospace, monospace",
              letterSpacing: "0.02em",
              wordBreak: "break-all",
            }}
          >
            Dev diagnostics · returnTo={pendingReturnTo}
          </div>
        ) : null}

        {phase === "boot" || phase === "completing" ? (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginTop: 22,
              padding: "14px 14px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.02)",
              color: "rgba(255,255,255,0.7)",
              fontSize: 13,
              lineHeight: 1.5,
              textAlign: "center",
              letterSpacing: "0.01em",
            }}
          >
            {phase === "completing"
              ? "One moment — finishing sign-in."
              : "Restoring your session…"}
          </div>
        ) : null}

        {phase === "no-org" ? (
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
        ) : null}

        {phase === "continue" && user ? (
          <div style={{ marginTop: 20 }}>
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.02)",
                fontSize: 13,
                lineHeight: 1.5,
                color: "rgba(255,255,255,0.85)",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,0.45)",
                  marginBottom: 4,
                }}
              >
                Signed in as
              </div>
              <div
                style={{
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  wordBreak: "break-all",
                }}
              >
                {user.email || "this account"}
              </div>
            </div>

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
              type="button"
              onClick={handleContinueAs}
              disabled={continuing}
              style={{
                marginTop: 16,
                width: "100%",
                padding: "11px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: continuing ? "rgba(255,255,255,0.05)" : "#fff",
                color: continuing ? "rgba(255,255,255,0.5)" : "#000",
                fontSize: 14,
                fontWeight: 600,
                cursor: continuing ? "not-allowed" : "pointer",
                transition: "background 120ms ease, color 120ms ease",
              }}
            >
              {continuing
                ? "Continuing…"
                : pendingReturnTo
                ? `Continue as ${user.email || "this account"}`
                : `Continue as ${user.email || "this account"}`}
            </button>
            <button
              type="button"
              onClick={handleSwitchAccount}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "11px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent",
                color: "rgba(255,255,255,0.75)",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Use a different email
            </button>
          </div>
        ) : null}

        {phase === "form" ? (
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
            <div
              style={{
                marginTop: 12,
                fontSize: 11,
                color: "rgba(255,255,255,0.42)",
                lineHeight: 1.5,
                textAlign: "center",
              }}
            >
              You&apos;ll stay signed in on this device until you sign out.
            </div>
          </form>
        ) : null}

        {phase === "sent" ? (
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                border: "1px solid rgba(34,197,94,0.25)",
                background: "rgba(34,197,94,0.08)",
                color: "#86efac",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              Login link sent to{" "}
              <strong style={{ color: "#fff" }}>{email}</strong>. Open it on
              this device to finish signing in. The link is good for one use.
            </div>
            <button
              type="button"
              onClick={() => {
                setSent(false);
                setError("");
              }}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "10px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Use a different email
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
