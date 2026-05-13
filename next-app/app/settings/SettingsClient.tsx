"use client";

// PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
// /settings — user-owned profile preferences. Read-only mirrors of
// auth fields (email/role/orgId) plus a small set of editable
// preferences. Storage: users/{uid}/settings/profile (single doc per
// user). Security: rules gate read+write to request.auth.uid == uid.
//
// Styling is intentionally inline + matches the Mission Control
// header/cards (black background, #1c1c1c borders, #b3b3b3 text,
// gold gradient CTA). No tailwind theme tokens to lean on; copy-paste
// of the same hex constants used elsewhere keeps the surface coherent.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { logAnalyticsEvent } from "@/lib/analytics";
import {
  DEFAULT_USER_SETTINGS,
  loadUserSettings,
  saveUserSettings,
  type DefaultLandingPage,
  type UserSettings,
} from "@/lib/userSettings";

const LANDING_OPTIONS: { value: DefaultLandingPage; label: string }[] = [
  { value: "mission_control", label: "Jobs" },
  { value: "my_active_work", label: "My Active Work" },
  { value: "review_queue",    label: "Review Queue" },
];

function prettyRole(role: string): string {
  const r = String(role || "").toLowerCase();
  if (r === "supervisor") return "Supervisor";
  if (r === "admin") return "Admin";
  if (r === "field") return "Field crew";
  if (r) return r.charAt(0).toUpperCase() + r.slice(1);
  return "—";
}

export default function SettingsClient() {
  const sp = useSearchParams();
  const { user, loading: authLoading, claims } = useAuth();
  const uid = user?.uid || "";

  // PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
  // Preserve orgId on the way back to Mission Control. Priority:
  // (1) URL query param (set when the user came from a page that had
  // it), (2) localStorage hint (set elsewhere in the app), (3) the
  // first orgId in the auth claim. None of these can produce an
  // unsafe URL since orgId is always a server-validated claim.
  const backHref = useMemo(() => {
    const fromQuery = String(sp?.get("orgId") || "").trim();
    let fromStorage = "";
    if (typeof window !== "undefined") {
      try {
        fromStorage = String(window.localStorage.getItem("peakops_orgId") || "").trim();
      } catch { /* private mode etc. — fall through */ }
    }
    const fromClaims = (claims.orgIds[0] || "").trim();
    const orgId = fromQuery || fromStorage || fromClaims;
    return orgId
      ? `/incidents?orgId=${encodeURIComponent(orgId)}`
      : "/incidents";
  }, [sp, claims.orgIds]);

  const [settings, setSettings] = useState<UserSettings>(DEFAULT_USER_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string>("");

  useEffect(() => {
    if (authLoading) return;
    void logAnalyticsEvent("SETTINGS_OPENED");
  }, [authLoading]);

  // Load settings once auth has resolved + we have a uid.
  useEffect(() => {
    let cancelled = false;
    if (authLoading) return;
    if (!uid) {
      setLoaded(true);
      return;
    }
    (async () => {
      try {
        const loadedSettings = await loadUserSettings(uid);
        if (cancelled) return;
        setSettings(loadedSettings);
      } catch (e: any) {
        // PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
        // Firebase errors carry a stable .code (e.g.
        // "permission-denied", "unavailable", "unauthenticated").
        // Surface it in the dev console so deploy/auth issues
        // (notably "rules not deployed") are diagnosable at a glance
        // without parsing free-text messages.
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[settings-load]", {
            path: `users/${uid}/settings/profile`,
            code: e?.code || null,
            message: String(e?.message || e),
          });
        }
        // Leave defaults in place; user can still edit + save.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, authLoading]);

  function toast(msg: string, ms = 2200) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), ms);
  }

  async function handleSave() {
    if (!uid || saving) return;
    if (displayNameError) return; // PEAKOPS_USER_SETTINGS_V1 — block on validation
    setSaving(true);
    try {
      // Trim whitespace before persisting so the saved value matches
      // what the validator allowed.
      const toSave: UserSettings = {
        ...settings,
        displayName: settings.displayName.trim(),
      };
      await saveUserSettings(uid, toSave);
      // Reflect the trim back into local state.
      setSettings(toSave);
      toast("Settings saved.");
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[settings-save]", {
          path: `users/${uid}/settings/profile`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't save your settings. Please try again.", 3500);
    } finally {
      setSaving(false);
    }
  }

  // PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
  // Display-name validation. Trim before counting so a field full of
  // spaces doesn't pass; cap at 64 to match the spec. Save is gated
  // on this being null.
  const DISPLAY_NAME_MAX = 64;
  const trimmedName = settings.displayName.trim();
  const displayNameError =
    trimmedName.length > DISPLAY_NAME_MAX
      ? `Display name is too long. Max ${DISPLAY_NAME_MAX} characters.`
      : null;

  // ---- Gate states ---------------------------------------------------------

  if (authLoading || !loaded) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: "#6f6f6f" }}>Loading…</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>Settings</h1>
          <p style={{ marginTop: 8, fontSize: 13, color: "#b3b3b3" }}>
            You need to be signed in to view your settings.
          </p>
          <div style={{ marginTop: 12 }}>
            <Link href="/login" style={primaryBtnStyle(true)}>Go to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  // ---- Render --------------------------------------------------------------

  const defaultOrg = claims.orgIds[0] || "—";
  const role = prettyRole(claims.role);

  // PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
  // Tab nav between Profile (this page), Organization, Team, and
  // Vendors. orgId carried through links for context preservation.
  // PEAKOPS_ORG_SETTINGS_V1 (2026-05-11) — Slice Branding 1.0 added
  // the Organization tab for branding (logo upload).
  const tabHrefs = (() => {
    const fromQuery = String(sp?.get("orgId") || "").trim();
    let fromStorage = "";
    if (typeof window !== "undefined") {
      try { fromStorage = String(window.localStorage.getItem("peakops_orgId") || "").trim(); } catch { /* ignore */ }
    }
    const fromClaims = (claims.orgIds[0] || "").trim();
    const oid = fromQuery || fromStorage || fromClaims;
    const q = oid ? `?orgId=${encodeURIComponent(oid)}` : "";
    return {
      organization: `/settings/organization${q}`,
      team:         `/settings/team${q}`,
      vendors:      `/settings/vendors${q}`,
    };
  })();

  return (
    <div style={pageStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={titleStyle}>Settings</h1>
        <Link href={backHref} style={secondaryBtnStyle}>
          ← Back to Jobs
        </Link>
      </div>

      <nav style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <Link href="#" aria-current="page" style={tabStyle(true)}>Profile</Link>
        <Link href={tabHrefs.organization} style={tabStyle(false)}>Organization</Link>
        <Link href={tabHrefs.team} style={tabStyle(false)}>Team</Link>
        <Link href={tabHrefs.vendors} style={tabStyle(false)}>Vendors</Link>
      </nav>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Profile</h2>

        <Field label="Display name">
          <input
            type="text"
            value={settings.displayName}
            onChange={(e) => setSettings((s) => ({ ...s, displayName: e.target.value }))}
            placeholder="How you'd like your name to appear"
            maxLength={DISPLAY_NAME_MAX}
            style={{
              ...inputStyle,
              borderColor: displayNameError ? "#a44" : "#1c1c1c",
            }}
          />
          {displayNameError && (
            <span style={{ fontSize: 11, color: "#e08383" }}>
              {displayNameError}
            </span>
          )}
        </Field>

        <Field label="Email">
          <ReadOnlyValue>{user.email || "—"}</ReadOnlyValue>
        </Field>

        <Field label="Role">
          <ReadOnlyValue>{role}</ReadOnlyValue>
        </Field>

        <Field label="Default org">
          <ReadOnlyValue>{defaultOrg}</ReadOnlyValue>
        </Field>
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Notifications</h2>

        <ToggleRow
          label="Email updates"
          help="Periodic email digests about your jobs."
          checked={settings.emailUpdatesEnabled}
          onChange={(v) => setSettings((s) => ({ ...s, emailUpdatesEnabled: v }))}
        />

        <ToggleRow
          label="Report ready alerts"
          help="In-app alert when a report finishes generating."
          checked={settings.reportReadyAlertsEnabled}
          onChange={(v) => setSettings((s) => ({ ...s, reportReadyAlertsEnabled: v }))}
        />
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Default landing page</h2>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#6f6f6f" }}>
          The page you land on after signing in.
        </p>
        <div style={{ display: "grid", gap: 6 }}>
          {LANDING_OPTIONS.map((opt) => {
            const active = settings.defaultLandingPage === opt.value;
            return (
              <label
                key={opt.value}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px",
                  border: `1px solid ${active ? "#C8A84E" : "#1c1c1c"}`,
                  borderRadius: 6,
                  background: active ? "rgba(200,168,78,0.06)" : "#0b0b0b",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "#f5f5f5",
                }}
              >
                <input
                  type="radio"
                  name="defaultLandingPage"
                  checked={active}
                  onChange={() => setSettings((s) => ({ ...s, defaultLandingPage: opt.value }))}
                  style={{ accentColor: "#C8A84E" }}
                />
                <span>{opt.label}</span>
              </label>
            );
          })}
        </div>
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !!displayNameError}
          style={primaryBtnStyle(!saving && !displayNameError)}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      {toastMsg && (
        <div style={toastStyle}>{toastMsg}</div>
      )}
    </div>
  );
}

// ---- Subcomponents ---------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
    </div>
  );
}

function ReadOnlyValue({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: "10px 12px",
      border: "1px solid #1c1c1c",
      borderRadius: 6,
      background: "#0b0b0b",
      color: "#b3b3b3",
      fontSize: 13,
    }}>{children}</div>
  );
}

function ToggleRow({
  label, help, checked, onChange,
}: {
  label: string; help: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      padding: "12px 0",
      borderTop: "1px solid #161616",
      cursor: "pointer",
    }}>
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 13, color: "#f5f5f5" }}>{label}</span>
        <span style={{ fontSize: 11, color: "#6f6f6f" }}>{help}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "#C8A84E", width: 18, height: 18 }}
      />
    </label>
  );
}

// ---- Styles ----------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#000",
  color: "#f5f5f5",
  padding: "24px 20px 64px",
  maxWidth: 720,
  margin: "0 auto",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const titleStyle: React.CSSProperties = {
  margin: 0, fontSize: 22, fontWeight: 700, color: "#f5f5f5",
};

const cardStyle: React.CSSProperties = {
  background: "#050505",
  border: "1px solid #1c1c1c",
  borderRadius: 8,
  padding: "16px 18px",
  marginBottom: 12,
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 12px", fontSize: 11, fontWeight: 700,
  letterSpacing: "0.10em", textTransform: "uppercase",
  color: "#6f6f6f",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11, color: "#6f6f6f", letterSpacing: "0.04em",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #1c1c1c",
  borderRadius: 6,
  background: "#0b0b0b",
  color: "#f5f5f5",
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 11, fontWeight: 600,
  background: "transparent",
  color: "#b3b3b3",
  border: "1px solid #1c1c1c",
  borderRadius: 6,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};

// PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
// Shared with /settings/team — same shape, kept inline because there's
// no styling primitives module in the app.
function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: 12, fontWeight: 600,
    background: active ? "#0b0b0b" : "transparent",
    color: active ? "#f5f5f5" : "#b3b3b3",
    border: "1px solid #1c1c1c",
    borderBottomColor: active ? "#C8A84E" : "#1c1c1c",
    borderRadius: 6,
    cursor: "pointer",
    textDecoration: "none",
  };
}

function primaryBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "10px 18px",
    fontSize: 13, fontWeight: 700,
    border: 0,
    borderRadius: 6,
    cursor: enabled ? "pointer" : "not-allowed",
    color: enabled ? "#050505" : "#6f6f6f",
    background: enabled
      ? "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)"
      : "#1c1c1c",
    boxShadow: enabled
      ? "0 2px 12px rgba(200,168,78,0.20), inset 0 1px 0 rgba(255,255,255,0.08)"
      : "none",
    textDecoration: "none",
    display: "inline-block",
  };
}

const toastStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0b0b0b",
  color: "#f5f5f5",
  border: "1px solid #1c1c1c",
  borderRadius: 6,
  padding: "10px 14px",
  fontSize: 12,
  zIndex: 50,
};
