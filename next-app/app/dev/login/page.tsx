"use client";

// PEAKOPS_DEV_LOGIN_V1 (2026-05-06)
//
// Phase 1 Slice 10: dev-only sign-in helper. Lists the demo seed
// uids and signs the browser in via custom token against the local
// Auth Emulator. Companion to:
//   - /api/dev/mintCustomToken         (mints the custom token)
//   - functions_clean/_authz.js        (rules-side authoritative
//                                        gate post sign-in)
//   - firestore.rules Slice 8/9        (default-deny against the
//                                        signed-in uid)
//   - next-app/scripts/seedDemoMembership.ts +
//     seedDemoRoleMembers.ts           (creates the matching member
//                                        docs the rules require)
//
// Hard-gated to dev:
//   - "use client" + a 404 fallback when NODE_ENV === "production"
//     and ?dev=1 isn't set.
//   - Will refuse to operate if NEXT_PUBLIC_USE_FIREBASE_EMULATORS
//     is not "1" — without that, the Firebase client SDK is pointed
//     at production Auth, and we don't want to surprise anyone by
//     signing them into a real Firebase project as a demo uid.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signInWithCustomToken, signOut, type User } from "firebase/auth";
import { auth } from "../../../lib/firebaseClient";

type DemoActor = {
  uid: string;
  role: "admin" | "supervisor" | "field" | "viewer";
  label: string;
};

const DEMO_ACTORS: ReadonlyArray<DemoActor> = [
  { uid: "dev-admin",    role: "admin",      label: "Dev Admin (admin)" },
  { uid: "tech_web",     role: "admin",      label: "Tech Web (admin)" },
  { uid: "supe_smoke",   role: "supervisor", label: "Supe Smoke (supervisor)" },
  { uid: "field_smoke",  role: "field",      label: "Field Smoke (field)" },
  { uid: "viewer_smoke", role: "viewer",     label: "Viewer Smoke (viewer)" },
];

export default function DevLoginPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [busyUid, setBusyUid] = useState<string>("");
  const [error, setError] = useState<string>("");

  const emulatorMode = useMemo(
    () => process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "1",
    [],
  );
  const isProd = process.env.NODE_ENV === "production";

  // PEAKOPS_SLICE10_1_PROJECT_LABEL_V1 (2026-05-06)
  // Slice 10.1 routes the browser through the peakops-demo project
  // when emulator mode is on. Showing the resolved project here so
  // a developer can confirm at a glance that the page is wired to
  // the local-only project, not production peakops-pilot.
  const projectId = useMemo(() => {
    const emuProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID_EMULATOR || "";
    const baseProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "(unset)";
    return emulatorMode && emuProject ? emuProject : baseProject;
  }, [emulatorMode]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setCurrentUser(u));
    return () => unsub();
  }, []);

  // Hard gate. In production, the page renders a generic 404-shaped
  // blocker. The /api/dev/mintCustomToken endpoint independently
  // returns 404 in production, so even a forged client can't drive
  // this flow against prod.
  if (isProd) {
    return (
      <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <h1>404</h1>
        <p>This page does not exist.</p>
      </main>
    );
  }

  async function signInAs(actor: DemoActor) {
    setError("");
    if (!emulatorMode) {
      setError(
        "NEXT_PUBLIC_USE_FIREBASE_EMULATORS is not 1. The browser is wired to real Firebase Auth — refusing to sign in as a demo uid.",
      );
      return;
    }
    setBusyUid(actor.uid);
    try {
      const res = await fetch("/api/dev/mintCustomToken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: actor.uid }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({} as { error?: string; detail?: string }));
        throw new Error(detail?.detail || detail?.error || `HTTP ${res.status}`);
      }
      const { token } = (await res.json()) as { token: string };
      await signInWithCustomToken(auth, token);
      // Land on /incidents — the demo-org's lifecycle entry point.
      router.push("/incidents?orgId=demo-org");
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusyUid("");
    }
  }

  async function handleSignOut() {
    setError("");
    try {
      await signOut(auth);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }

  const tokens = {
    bg: "#050505",
    panel: "#0b0b0b",
    border: "#1c1c1c",
    text: "#f5f5f5",
    muted: "#9a9a9a",
    accent: "#86efac",
    danger: "#fca5a5",
    gold: "#C8A84E",
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: tokens.bg,
        color: tokens.text,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: "32px 16px",
      }}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.18em", color: tokens.gold, textTransform: "uppercase" }}>
            Dev only · emulator
          </span>
          <span style={{
            fontSize: 11, fontWeight: 600,
            padding: "3px 8px", borderRadius: 999,
            border: `1px solid ${emulatorMode ? "rgba(134,239,172,0.3)" : "rgba(252,165,165,0.3)"}`,
            background: emulatorMode ? "rgba(134,239,172,0.08)" : "rgba(252,165,165,0.08)",
            color: emulatorMode ? tokens.accent : tokens.danger,
            letterSpacing: "0.02em",
          }}>
            project: <code style={{ fontFamily: "ui-monospace, monospace" }}>{projectId}</code>
          </span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 6px" }}>Sign in as a demo actor</h1>
        <p style={{ margin: "0 0 18px", color: tokens.muted, fontSize: 13, lineHeight: 1.55 }}>
          Mints a custom token via the local Auth Emulator and signs the browser in
          as the chosen uid. Each uid corresponds to a seeded member doc at
          <code style={{ marginLeft: 4 }}>orgs/demo-org/members/&#123;uid&#125;</code>,
          so the new default-deny Firestore rules permit reads/writes through the
          lifecycle UI.
        </p>

        {!emulatorMode ? (
          <div
            role="alert"
            style={{
              marginBottom: 18,
              padding: "12px 14px",
              borderRadius: 8,
              border: "1px solid rgba(252,165,165,0.3)",
              background: "rgba(252,165,165,0.08)",
              color: tokens.danger,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong>Emulator mode is OFF.</strong> Set
            <code style={{ margin: "0 4px" }}>NEXT_PUBLIC_USE_FIREBASE_EMULATORS=1</code>
            in <code>.env.local</code> and restart the dev server before signing in.
            This page refuses to call real Firebase Auth.
          </div>
        ) : null}

        <section
          style={{
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
            background: tokens.panel,
            padding: 14,
            marginBottom: 18,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: tokens.muted, textTransform: "uppercase", marginBottom: 10 }}>
            Current session
          </div>
          {currentUser ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>
                Signed in as <strong style={{ color: tokens.accent }}>{currentUser.uid}</strong>
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: `1px solid ${tokens.border}`,
                  background: "transparent",
                  color: tokens.text,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: tokens.muted }}>Not signed in.</div>
          )}
        </section>

        <div style={{ display: "grid", gap: 8 }}>
          {DEMO_ACTORS.map((actor) => {
            const busy = busyUid === actor.uid;
            const isCurrent = currentUser?.uid === actor.uid;
            return (
              <button
                key={actor.uid}
                type="button"
                onClick={() => signInAs(actor)}
                disabled={busy || !emulatorMode}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: `1px solid ${isCurrent ? tokens.accent : tokens.border}`,
                  background: tokens.panel,
                  color: tokens.text,
                  cursor: busy || !emulatorMode ? "not-allowed" : "pointer",
                  opacity: !emulatorMode ? 0.5 : 1,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{actor.label}</div>
                  <div style={{ fontSize: 12, color: tokens.muted, marginTop: 2 }}>
                    uid: <code>{actor.uid}</code>
                  </div>
                </div>
                <span style={{ fontSize: 11, color: isCurrent ? tokens.accent : tokens.muted }}>
                  {busy ? "Signing in…" : isCurrent ? "current" : "Sign in →"}
                </span>
              </button>
            );
          })}
        </div>

        {error ? (
          <div
            role="alert"
            style={{
              marginTop: 16,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid rgba(252,165,165,0.3)",
              background: "rgba(252,165,165,0.08)",
              color: tokens.danger,
              fontSize: 12,
              lineHeight: 1.5,
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}
