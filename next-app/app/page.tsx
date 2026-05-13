"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RootPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const trimmed = email.trim();
  const emailLooksValid = EMAIL_RE.test(trimmed);
  const canSubmit = emailLooksValid && !submitting;

  function handleContinue(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setError("");
    if (!emailLooksValid) {
      setError("Enter a valid work email (you@company.com).");
      return;
    }
    setSubmitting(true);
    // PEAKOPS_PORTAL_IDENTITY_V1
    // Front-door identity capture. Stashes the entered email client-side so
    // downstream pages can treat it as the current user until real auth is
    // wired in. No backend call, no redirect side effects other than the
    // in-app route push.
    try {
      localStorage.setItem("peakops_user_email", trimmed.toLowerCase());
      localStorage.setItem("peakops_user_email_at", String(Date.now()));
    } catch {}
    router.push("/incidents");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(ellipse at 50% 0%, #111 0%, #000 70%)",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: 24,
      }}
    >
      {/* Eyebrow */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          color: "#666",
          textTransform: "uppercase" as const,
          marginBottom: 10,
        }}
      >
        Operational Record System
      </div>

      {/* Wordmark */}
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: "0.22em",
          color: "#C8A84E",
          marginBottom: 24,
        }}
      >
        PEAKOPS
      </div>

      {/* Headline */}
      <h1
        style={{
          fontSize: 26,
          fontWeight: 600,
          color: "#fff",
          textAlign: "center",
          margin: "0 0 8px",
          lineHeight: 1.35,
        }}
      >
        Operational records built in real time.
      </h1>
      <p
        style={{
          fontSize: 14,
          color: "#777",
          textAlign: "center",
          maxWidth: 440,
          lineHeight: 1.6,
          margin: "0 0 28px",
        }}
      >
        PeakOps turns field work into audit-ready, filing-ready records without
        reconstruction.
      </p>

      {/* Email entry — primary CTA */}
      <form
        onSubmit={handleContinue}
        style={{
          width: "100%",
          maxWidth: 380,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <label
          htmlFor="peakops-email"
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.12em",
            textTransform: "uppercase" as const,
            color: "#6f6f6f",
          }}
        >
          Work email
        </label>
        <input
          id="peakops-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          value={email}
          onChange={(event) => {
            if (error) setError("");
            setEmail(event.target.value);
          }}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid #1c1c1c",
            background: "#0b0b0b",
            color: "#f5f5f5",
            fontSize: 14,
            outline: "none",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
          }}
        />

        {error ? (
          <div
            style={{
              fontSize: 11,
              color: "#e6a96a",
              lineHeight: 1.4,
            }}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            marginTop: 4,
            padding: "12px 0",
            borderRadius: 8,
            border: "none",
            background: canSubmit
              ? "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)"
              : "#1c1c1c",
            color: canSubmit ? "#050505" : "#6f6f6f",
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.02em",
            cursor: canSubmit ? "pointer" : "not-allowed",
            boxShadow: canSubmit
              ? "0 2px 12px rgba(200,168,78,0.20), inset 0 1px 0 rgba(255,255,255,0.08)"
              : "none",
            transition: "background 120ms ease",
          }}
        >
          {submitting ? "Continuing…" : "Continue"}
        </button>

        <p
          style={{
            fontSize: 11,
            color: "#555",
            textAlign: "center",
            lineHeight: 1.5,
            margin: "6px 0 0",
          }}
        >
          New to PeakOps? Your administrator will send an invite.
        </p>
      </form>

      {/* Secondary path — operator / admin sign in */}
      <Link
        href="/admin/login"
        style={{
          marginTop: 20,
          fontSize: 12,
          color: "#888",
          textDecoration: "none",
          letterSpacing: "0.02em",
          borderBottom: "1px dotted #333",
          paddingBottom: 1,
        }}
      >
        Admin / operator sign in →
      </Link>

      {/* Trust line */}
      <p
        style={{
          fontSize: 12,
          color: "#555",
          textAlign: "center",
          marginTop: 48,
          letterSpacing: "0.01em",
        }}
      >
        Built for field operations, infrastructure, and compliance-sensitive
        teams.
      </p>

      {/* Footer microcopy */}
      <div
        style={{
          position: "absolute",
          bottom: 24,
          fontSize: 10,
          color: "#333",
          letterSpacing: "0.02em",
        }}
      >
        Secure access to operational records and workflows.
      </div>
    </main>
  );
}
