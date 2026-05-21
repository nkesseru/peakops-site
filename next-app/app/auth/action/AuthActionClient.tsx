"use client";

// PEAKOPS_AUTH_ACTION_IN_APP_V1 (PR 49 Phase B)
//
// In-app handler for Firebase Auth out-of-band action codes. Today
// it implements password reset; structured so email verification or
// magic-link landings can be added beside it later without a route
// rename.
//
// Flow (mode=resetPassword):
//   1. verifyPasswordResetCode(auth, oobCode) → returns the email
//      attached to the code. Used both as a sanity check and as
//      header text ("Reset password for jane@example.com").
//   2. User picks a new password (min 8 chars, confirm field).
//   3. confirmPasswordReset(auth, oobCode, newPassword) → server
//      revokes the code and updates the credential.
//   4. Redirect to /login so they can sign in with the new password.
//
// Any other mode value (email verification, signin-with-link) falls
// through to a calm "this link isn't supported here" panel rather
// than a stack trace — gives us a clean place to add handlers
// incrementally.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  confirmPasswordReset,
  verifyPasswordResetCode,
} from "firebase/auth";
import { auth } from "../../../lib/firebaseClient";

type Phase =
  | "boot"
  | "ready"
  | "submitting"
  | "done"
  | "expired"
  | "invalid"
  | "unsupported"
  | "error";

const colors = {
  background: "#000",
  card: "rgba(255,255,255,0.03)",
  border: "rgba(255,255,255,0.08)",
  fg: "#fff",
  fgMuted: "rgba(255,255,255,0.6)",
  fgSubtle: "rgba(255,255,255,0.42)",
  accent: "#C8A84E",
  ok: "#86efac",
  okBg: "rgba(34,197,94,0.10)",
  okBorder: "rgba(34,197,94,0.30)",
  err: "#fca5a5",
};

function classifyError(err: unknown): "expired" | "invalid" | "error" {
  const code = String((err as { code?: string })?.code || "").toLowerCase();
  const msg = String((err as { message?: string })?.message || err || "").toLowerCase();
  if (code.includes("expired-action-code") || msg.includes("expired")) {
    return "expired";
  }
  if (
    code.includes("invalid-action-code") ||
    code.includes("user-disabled") ||
    code.includes("user-not-found") ||
    msg.includes("invalid")
  ) {
    return "invalid";
  }
  return "error";
}

export default function AuthActionClient({
  mode,
  oobCode,
  continueUrl,
}: {
  mode: string;
  oobCode: string;
  continueUrl: string;
}) {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("boot");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [error, setError] = useState("");

  // PEAKOPS_AUTH_ACTION_RETURN_TO_V1 (PR 49)
  // If Firebase preserved a continueUrl that points back into our
  // own app, drop it into peakops_return_to so the standard
  // post-login routing picks it up after the user signs in with
  // their new password. We mirror the same hardening checks the
  // /login page applies: local path only, no protocol-relative,
  // no /login self-loop.
  useEffect(() => {
    if (!continueUrl) return;
    if (typeof window === "undefined") return;
    try {
      // continueUrl is an absolute URL pointing at our origin or a
      // path. Normalize to a path-only string.
      let pathOnly = continueUrl;
      try {
        const u = new URL(continueUrl, window.location.origin);
        // Only honor same-origin returnTos — Firebase already
        // restricts to authorized domains, but defense in depth.
        if (u.origin === window.location.origin) {
          pathOnly = u.pathname + u.search + u.hash;
        } else {
          pathOnly = "";
        }
      } catch {
        // Not a parseable URL — treat as path.
      }
      if (
        pathOnly &&
        pathOnly.startsWith("/") &&
        !pathOnly.startsWith("//") &&
        !pathOnly.startsWith("/login") &&
        !pathOnly.startsWith("/auth/")
      ) {
        window.sessionStorage.setItem("peakops_return_to", pathOnly);
      }
    } catch {
      /* sessionStorage unavailable */
    }
  }, [continueUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mode !== "resetPassword") {
        if (!cancelled) setPhase("unsupported");
        return;
      }
      if (!oobCode) {
        if (!cancelled) setPhase("invalid");
        return;
      }
      try {
        const verifiedEmail = await verifyPasswordResetCode(auth, oobCode);
        if (cancelled) return;
        setEmail(verifiedEmail);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        const kind = classifyError(err);
        setPhase(kind);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode]);

  const canSubmit = useMemo(() => {
    if (phase !== "ready" && phase !== "submitting") return false;
    if (password.length < 8) return false;
    if (password !== confirmPwd) return false;
    return phase === "ready";
  }, [phase, password, confirmPwd]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPwd) {
      setError("The two passwords don't match.");
      return;
    }
    setPhase("submitting");
    try {
      await confirmPasswordReset(auth, oobCode, password);
      setPhase("done");
    } catch (err) {
      const kind = classifyError(err);
      if (kind === "expired" || kind === "invalid") {
        setPhase(kind);
        return;
      }
      setError(
        "We couldn't set your new password. Try again, or ask your administrator for a fresh recovery link.",
      );
      setPhase("ready");
    }
  }

  function goToLogin() {
    router.replace("/login");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: colors.background,
        color: colors.fg,
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
          border: `1px solid ${colors.border}`,
          background: colors.card,
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 60px rgba(0,0,0,0.5)",
        }}
      >
        <Eyebrow />

        {phase === "boot" ? (
          <CalmPanel
            heading="Verifying your link"
            body="One moment — checking the recovery link."
          />
        ) : null}

        {phase === "ready" || phase === "submitting" ? (
          <form onSubmit={handleSubmit} style={{ marginTop: 12 }}>
            <h1 style={headingStyle}>Set a new password</h1>
            <p style={subheadStyle}>
              for <strong style={{ color: colors.fg }}>{email}</strong>
            </p>

            <Field
              id="new-password"
              label="New password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(v) => {
                if (error) setError("");
                setPassword(v);
              }}
              disabled={phase === "submitting"}
              hint="At least 8 characters."
            />
            <Field
              id="confirm-password"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirmPwd}
              onChange={(v) => {
                if (error) setError("");
                setConfirmPwd(v);
              }}
              disabled={phase === "submitting"}
            />

            {error ? (
              <div
                role="alert"
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: colors.err,
                  lineHeight: 1.4,
                }}
              >
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                marginTop: 16,
                width: "100%",
                padding: "11px 0",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                background: canSubmit ? colors.fg : "rgba(255,255,255,0.05)",
                color: canSubmit ? "#000" : colors.fgSubtle,
                fontSize: 14,
                fontWeight: 600,
                cursor: canSubmit ? "pointer" : "not-allowed",
              }}
            >
              {phase === "submitting" ? "Setting password…" : "Set new password"}
            </button>
          </form>
        ) : null}

        {phase === "done" ? (
          <CalmPanel
            heading="Password updated"
            body="You can now sign in with your new password."
            cta={{ label: "Go to sign-in", onClick: goToLogin }}
            tone="ok"
          />
        ) : null}

        {phase === "expired" ? (
          <CalmPanel
            heading="Recovery link expired"
            body="This recovery link has expired. Use 'Forgot password' on the sign-in screen to send yourself a fresh one, or ask your supervisor to send a new one."
            cta={{ label: "Back to sign-in", onClick: goToLogin }}
          />
        ) : null}

        {phase === "invalid" ? (
          <CalmPanel
            heading="Recovery link no longer valid"
            body="This link may have already been used. Request a fresh recovery link from 'Forgot password' on the sign-in screen, or ask your supervisor to send a new one."
            cta={{ label: "Back to sign-in", onClick: goToLogin }}
          />
        ) : null}

        {phase === "unsupported" ? (
          <CalmPanel
            heading="Link not supported here"
            body="This recovery link wasn't recognized. Head back to sign in and request a fresh one."
            cta={{ label: "Back to sign-in", onClick: goToLogin }}
          />
        ) : null}

        {phase === "error" ? (
          <CalmPanel
            heading="Something went wrong"
            body="We couldn't verify the recovery link. Try again, or request a fresh one."
            cta={{ label: "Back to sign-in", onClick: goToLogin }}
          />
        ) : null}
      </div>
    </main>
  );
}

const headingStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
};
const subheadStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.fgMuted,
  marginTop: 6,
  marginBottom: 16,
  lineHeight: 1.5,
};

function Eyebrow() {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.18em",
        color: colors.accent,
        textTransform: "uppercase",
        marginBottom: 10,
      }}
    >
      Rapid Access Recovery
    </div>
  );
}

function CalmPanel({
  heading,
  body,
  cta,
  tone,
}: {
  heading: string;
  body: string;
  cta?: { label: string; onClick: () => void };
  tone?: "ok";
}) {
  return (
    <div>
      <h1 style={headingStyle}>{heading}</h1>
      <p style={subheadStyle}>{body}</p>
      {tone === "ok" ? (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${colors.okBorder}`,
            background: colors.okBg,
            color: colors.ok,
            fontSize: 12,
            lineHeight: 1.5,
            marginBottom: 12,
          }}
        >
          Recovery complete.
        </div>
      ) : null}
      {cta ? (
        <button
          type="button"
          onClick={cta.onClick}
          style={{
            width: "100%",
            padding: "11px 0",
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            background: colors.fg,
            color: "#000",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {cta.label}
        </button>
      ) : null}
    </div>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  value,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <label
        htmlFor={id}
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.fgSubtle,
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "11px 13px",
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
          background: "rgba(255,255,255,0.04)",
          color: colors.fg,
          fontSize: 14,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      {hint ? (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: colors.fgSubtle,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}
