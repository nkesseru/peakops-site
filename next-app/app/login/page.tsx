"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isSignInWithEmailLink } from "firebase/auth";
import { auth } from "../../lib/firebaseClient";
import {
  completeSignIn,
  sendMagicLink,
  sendPasswordReset,
  signInWithPassword,
  signOutUser,
} from "../../lib/auth";
import { useAuth } from "../../hooks/useAuth";
import { logAnalyticsEvent } from "../../lib/analytics";

// PEAKOPS_LOGIN_FRIENDLY_AUTH_ERRORS_V1 (2026-05-11)
// Map raw Firebase Auth error codes to calm, operational copy that
// reads as product instead of stack trace. Falls through to a
// sanitized default so unknown codes never surface as
// "Firebase: Error (auth/internal-error)" in the UI.
//
// PR 48 (2026-05-20): added password + reset error codes so the
// new email/password primary flow gets the same calm treatment.
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
  // Password-flow specific codes (PR 48).
  if (blob.includes("user-not-found")) {
    return "We couldn't find an account with that email. Check the spelling, or contact your PeakOps administrator.";
  }
  if (
    blob.includes("wrong-password") ||
    blob.includes("invalid-credential") ||
    blob.includes("invalid-login-credentials")
  ) {
    return "That email and password don't match. Try again, or use 'Forgot password' to reset.";
  }
  if (blob.includes("missing-password")) {
    return "Enter your password to sign in.";
  }
  if (blob.includes("weak-password")) {
    return "That password is too weak. Choose at least 6 characters.";
  }
  if (blob.includes("operation-not-allowed")) {
    return "This sign-in method isn't enabled yet. Contact your PeakOps administrator.";
  }
  return "Sign-in didn't complete. Try again, or use a different method below.";
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

  // PEAKOPS_LOGIN_PASSWORD_PRIMARY_V1 (PR 48)
  // Mode toggles which form is shown in the "form" phase. Password
  // is the primary path; magic-link is kept as a fallback for users
  // who don't have a password set yet.
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [password, setPassword] = useState("");
  // Forgot-password panel. Treated as its own phase below so the
  // primary form can disappear cleanly while the user is in the
  // reset flow.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

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
    // PEAKOPS_LOGIN_RETURN_TO_QUERY_V1 (PR 48)
    // Consume ?returnTo= from the URL so external "sign in" links
    // (e.g. emails or partner integrations) can deep-link straight
    // into the user's intended page after sign-in. Mirrors the
    // hardening that RequireAuth / authedFetch already apply when
    // they write to sessionStorage: must be a local path, no
    // protocol-relative URLs, no /login self-loop.
    if (typeof window !== "undefined") {
      try {
        const params = new URLSearchParams(window.location.search);
        const q = String(params.get("returnTo") || "").trim();
        if (
          q &&
          q.startsWith("/") &&
          !q.startsWith("//") &&
          !q.startsWith("/login")
        ) {
          window.sessionStorage.setItem("peakops_return_to", q);
        }
      } catch {
        /* sessionStorage unavailable (private mode) — fall through */
      }
    }
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

  // PEAKOPS_LOGIN_PASSWORD_PRIMARY_V1 (PR 48)
  // Mode-aware submit handler. Password sign-in is the primary
  // path; magic-link stays as a secondary affordance for users who
  // don't yet have a password set.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (mode === "password") {
      await handleSignInPassword();
      return;
    }
    await handleSendMagic();
  }

  async function handleSignInPassword() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email.");
      return;
    }
    if (!password) {
      setError("Enter your password to sign in.");
      return;
    }
    setSubmitting(true);
    try {
      const cred = await signInWithPassword(trimmed, password);
      void logAnalyticsEvent("USER_SIGNED_IN", { source: "password" });
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
      // Leave `submitting` true on the success path — the button
      // stays disabled and we don't flash a re-enabled form before
      // the route swap lands.
      routeAfterSignIn(firstOrgId);
    } catch (e) {
      setError(friendlyAuthError(e));
      setSubmitting(false);
    }
  }

  async function handleSendMagic() {
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

  // PEAKOPS_LOGIN_FORGOT_PASSWORD_V1 (PR 48)
  // Forgot-password handler. Deliberately uniform: on any outcome
  // that could leak whether a given email is registered
  // (auth/user-not-found, generic failures), we surface the same
  // "we've sent a link" view. Only operational errors that the
  // user can act on (bad email shape, network, rate limit, provider
  // disabled) are surfaced.
  async function handleSendReset(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const trimmed = (forgotEmail || email).trim();
    if (!trimmed) {
      setError("Enter your email to reset your password.");
      return;
    }
    setForgotSubmitting(true);
    try {
      await sendPasswordReset(trimmed);
    } catch (err: any) {
      const code = String(err?.code || "").toLowerCase();
      if (code.includes("invalid-email")) {
        setError(
          "That email address doesn't look right. Double-check and try again.",
        );
        setForgotSubmitting(false);
        return;
      }
      if (
        code.includes("network") ||
        code.includes("too-many-requests") ||
        code.includes("quota") ||
        code.includes("operation-not-allowed")
      ) {
        setError(friendlyAuthError(err));
        setForgotSubmitting(false);
        return;
      }
      // user-not-found / unknown: swallow to avoid email enumeration
      // and fall through to the uniform "sent" view.
    }
    setForgotEmail(trimmed);
    setForgotSent(true);
    setForgotSubmitting(false);
  }

  function openForgotPassword() {
    setError("");
    setForgotEmail(email);
    setForgotOpen(true);
  }

  function closeForgotPassword() {
    setError("");
    setForgotOpen(false);
    setForgotSent(false);
    setForgotSubmitting(false);
  }

  // PEAKOPS_LOGIN_VIEW_PHASE_V1 (2026-05-11)
  // Single derived view phase keeps the JSX below readable. Order
  // matters: completing wins over continue-as so a click on a fresh
  // magic link never flashes the previous session's "Continue as".
  //
  // PR 48 added "forgot" + "forgot-sent" for the password-reset
  // panel. They sit between `sent` and `continue` so that a signed-in
  // user landing on /login still sees the Continue-as panel by
  // default, but the reset flow takes precedence over a stale
  // magic-link "sent" view if the user explicitly opens it.
  type Phase =
    | "boot"
    | "completing"
    | "no-org"
    | "sent"
    | "forgot-sent"
    | "forgot"
    | "continue"
    | "form";
  const phase: Phase = (() => {
    if (hasIncomingLink === null) return "boot";
    if (completing) return "completing";
    if (signedInNoOrg) return "no-org";
    if (forgotSent) return "forgot-sent";
    if (forgotOpen) return "forgot";
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
      : phase === "forgot"
      ? "Reset password"
      : phase === "forgot-sent"
      ? "Check your inbox"
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
    if (phase === "forgot") {
      return "Enter the email for your account and we'll send a reset link.";
    }
    if (phase === "forgot-sent") {
      return "If an account exists for that email, we've sent a reset link.";
    }
    if (pendingReturnTo) return "Sign in to continue to the page you requested.";
    return "Sign in with your email and password.";
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

            {mode === "password" ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginTop: 14,
                    marginBottom: 6,
                  }}
                >
                  <label
                    htmlFor="login-password"
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "rgba(255,255,255,0.5)",
                    }}
                  >
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={openForgotPassword}
                    disabled={submitting}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      fontSize: 11,
                      color: "rgba(255,255,255,0.55)",
                      textDecoration: "underline",
                      cursor: submitting ? "not-allowed" : "pointer",
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={password}
                  onChange={(ev) => {
                    if (error) setError("");
                    setPassword(ev.target.value);
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
              </>
            ) : null}

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
              {submitting
                ? mode === "password"
                  ? "Signing in…"
                  : "Sending…"
                : mode === "password"
                ? "Sign in"
                : "Send Login Link"}
            </button>

            {/* PEAKOPS_LOGIN_MODE_TOGGLE_V1 (PR 48)
                Secondary affordance to switch between password and
                magic-link sign-in. Magic-link stays available as a
                fallback for users who don't have a password set
                yet (existing pilot accounts) — but it's no longer
                the primary call to action. */}
            <button
              type="button"
              onClick={() => {
                if (submitting) return;
                setError("");
                setPassword("");
                setMode(mode === "password" ? "magic" : "password");
              }}
              disabled={submitting}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                fontSize: 12,
                fontWeight: 500,
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {mode === "password"
                ? "Sign in with a one-time email link instead"
                : "Sign in with a password instead"}
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

        {phase === "forgot" ? (
          <form onSubmit={handleSendReset} style={{ marginTop: 20 }}>
            <label
              htmlFor="forgot-email"
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
              id="forgot-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
              value={forgotEmail}
              onChange={(ev) => {
                if (error) setError("");
                setForgotEmail(ev.target.value);
              }}
              disabled={forgotSubmitting}
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
              disabled={forgotSubmitting}
              style={{
                marginTop: 16,
                width: "100%",
                padding: "11px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: forgotSubmitting ? "rgba(255,255,255,0.05)" : "#fff",
                color: forgotSubmitting ? "rgba(255,255,255,0.5)" : "#000",
                fontSize: 14,
                fontWeight: 600,
                cursor: forgotSubmitting ? "not-allowed" : "pointer",
                transition: "background 120ms ease, color 120ms ease",
              }}
            >
              {forgotSubmitting ? "Sending…" : "Send reset link"}
            </button>
            <button
              type="button"
              onClick={closeForgotPassword}
              disabled={forgotSubmitting}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 0",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                fontSize: 12,
                fontWeight: 500,
                cursor: forgotSubmitting ? "not-allowed" : "pointer",
              }}
            >
              Back to sign in
            </button>
          </form>
        ) : null}

        {phase === "forgot-sent" ? (
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
              {forgotEmail ? (
                <>
                  If an account exists for{" "}
                  <strong style={{ color: "#fff" }}>{forgotEmail}</strong>, a
                  password reset link is on the way. Follow it to set a new
                  password, then return here to sign in.
                </>
              ) : (
                "If an account exists for that email, a password reset link is on the way. Follow it to set a new password, then return here to sign in."
              )}
            </div>
            <button
              type="button"
              onClick={closeForgotPassword}
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
              Back to sign in
            </button>
          </div>
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
