"use client";

// PEAKOPS_ORG_SETTINGS_V1 (2026-05-11) — Slice Branding 1.0.
//
// /settings/organization — admin-facing org-level settings page.
// v1 ships a single section: Branding (logo upload).
//
// Storage strategy:
//   The uploaded logo is encoded as a base64 data URL and persisted
//   to `orgs/{orgId}.branding.logoUrl`. Owner/admin can write this
//   field via the existing Firestore rule:
//     match /orgs/{orgId} {
//       allow update: if isOwnerOrAdmin(orgId);
//     }
//   No rule changes, no new API routes, no Storage upload pipeline.
//   A future slice can migrate to Firebase Storage + signed URLs
//   without changing the consumer contract (orgOnboardingView reads
//   the same `branding.logoUrl` field either way; the v1 data-URL
//   prefix and the future https: prefix are both accepted there).
//
// Size budget:
//   Cap raw input at 200 KB (≈ 270 KB base64). Firestore docs are
//   capped at 1 MB, so this leaves comfortable headroom for the
//   org's other fields (industry, members count, onboarding state).
//
// Role gate:
//   Non-admin members see the page but cannot upload. The save path
//   relies on Firestore rules for hard enforcement; the role gate
//   here is a UX affordance only.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { doc, getDoc, onSnapshot, updateDoc } from "firebase/firestore";
import { useAuth } from "@/hooks/useAuth";
import { db } from "../../../lib/firebaseClient";

const LOGO_MAX_BYTES = 200 * 1024; // 200 KB raw input cap
const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/jpg"]);

// Resolve the active orgId via the same priority the rest of /settings
// uses: URL query → localStorage → claims. Returns "" if no org is
// known yet; the UI shows a "Pick an org first" empty state.
function pickActiveOrgId(
  fromQuery: string,
  fromStorage: string,
  fromClaims: string,
): string {
  return (fromQuery || fromStorage || fromClaims || "").trim();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const out = String(reader.result || "");
      if (!out.startsWith("data:")) {
        reject(new Error("File could not be read as image data."));
        return;
      }
      resolve(out);
    };
    reader.onerror = () => reject(new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

export default function OrganizationClient() {
  const sp = useSearchParams();
  const { user, loading: authLoading, claims } = useAuth();

  // ---- Resolve active orgId -----------------------------------------------
  const fromQuery = String(sp?.get("orgId") || "").trim();
  const fromClaims = (claims.orgIds[0] || "").trim();
  const [fromStorage, setFromStorage] = useState<string>("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setFromStorage(String(window.localStorage.getItem("peakops_orgId") || "").trim());
    } catch {
      /* private mode etc. */
    }
  }, []);
  const orgId = pickActiveOrgId(fromQuery, fromStorage, fromClaims);

  // ---- Tab nav hrefs ------------------------------------------------------
  const tabQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const tabHrefs = {
    profile: `/settings${tabQuery}`,
    team: `/settings/team${tabQuery}`,
    vendors: `/settings/vendors${tabQuery}`,
  };

  // ---- Back href ----------------------------------------------------------
  const backHref = useMemo(() => {
    return orgId
      ? `/incidents?orgId=${encodeURIComponent(orgId)}`
      : "/incidents";
  }, [orgId]);

  // ---- Org doc subscription -----------------------------------------------
  const [orgLoaded, setOrgLoaded] = useState(false);
  const [orgName, setOrgName] = useState<string>("");
  const [currentLogoUrl, setCurrentLogoUrl] = useState<string>("");
  const [role, setRole] = useState<string>("");
  const [roleLoaded, setRoleLoaded] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!orgId) {
      setOrgLoaded(true);
      setRoleLoaded(true);
      return;
    }
    let cancelled = false;
    const unsub = onSnapshot(
      doc(db, "orgs", orgId),
      (snap) => {
        if (cancelled) return;
        const data = (snap.data() as any) || {};
        setOrgName(String(data.name || "").trim());
        const rawLogo =
          data && data.branding && typeof data.branding === "object"
            ? data.branding.logoUrl
            : undefined;
        const safeLogo =
          typeof rawLogo === "string" &&
          (rawLogo.startsWith("data:") || rawLogo.startsWith("https://"))
            ? rawLogo
            : "";
        setCurrentLogoUrl(safeLogo);
        setOrgLoaded(true);
      },
      (e) => {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[org-settings-load]", {
            path: `orgs/${orgId}`,
            code: (e as any)?.code || null,
            message: String((e as any)?.message || e),
          });
        }
        if (!cancelled) setOrgLoaded(true);
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [orgId, authLoading]);

  // Role lookup is a one-shot read of orgs/{orgId}/members/{uid}.
  // We deliberately don't subscribe — role changes are infrequent and
  // a snapshot listener would just cost connections.
  useEffect(() => {
    if (authLoading) return;
    if (!user?.uid || !orgId) {
      setRoleLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, "orgs", orgId, "members", user.uid));
        if (cancelled) return;
        const data = (snap.exists() ? snap.data() : {}) as any;
        setRole(String(data?.role || "").toLowerCase());
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[org-role-load]", {
            path: `orgs/${orgId}/members/${user?.uid}`,
            code: (e as any)?.code || null,
            message: String((e as any)?.message || e),
          });
        }
      } finally {
        if (!cancelled) setRoleLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, orgId, authLoading]);

  const isAdmin = role === "owner" || role === "admin";

  // ---- Upload state -------------------------------------------------------
  const [pendingDataUrl, setPendingDataUrl] = useState<string>("");
  const [pendingFileName, setPendingFileName] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string>("");

  function toast(msg: string, ms = 2400) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), ms);
  }

  async function handleFilePicked(file: File | null) {
    setUploadError("");
    setPendingDataUrl("");
    setPendingFileName("");
    if (!file) return;

    // Type check first — we want a clean error before reading bytes.
    if (!ACCEPTED_MIME.has(file.type.toLowerCase())) {
      setUploadError("Please choose a PNG or JPG image.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      const kb = Math.round(LOGO_MAX_BYTES / 1024);
      setUploadError(`That image is too large. Max ${kb} KB.`);
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      // Defensive double-check on the resulting payload size.
      // Base64 is ~33% larger than the raw bytes; keep the cap
      // generous but bounded to protect Firestore's 1 MB doc limit.
      if (dataUrl.length > LOGO_MAX_BYTES * 2) {
        setUploadError("That image is too large after encoding. Try a smaller file.");
        return;
      }
      setPendingDataUrl(dataUrl);
      setPendingFileName(String(file.name || "logo"));
    } catch (e: any) {
      setUploadError(String(e?.message || "Couldn't read that file."));
    }
  }

  async function handleSave() {
    if (!orgId || !pendingDataUrl || saving) return;
    setSaving(true);
    setUploadError("");
    try {
      await updateDoc(doc(db, "orgs", orgId), {
        "branding.logoUrl": pendingDataUrl,
      });
      setPendingDataUrl("");
      setPendingFileName("");
      toast("Logo saved.");
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[org-branding-save]", {
          path: `orgs/${orgId}`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      const code = String(e?.code || "");
      if (code === "permission-denied") {
        setUploadError("You don't have permission to update branding. Ask an organization admin.");
      } else {
        setUploadError("We couldn't save the logo. Try again in a moment.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!orgId || saving) return;
    if (!currentLogoUrl) return;
    setSaving(true);
    setUploadError("");
    try {
      await updateDoc(doc(db, "orgs", orgId), {
        "branding.logoUrl": "",
      });
      toast("Logo removed.");
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[org-branding-remove]", {
          path: `orgs/${orgId}`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      const code = String(e?.code || "");
      if (code === "permission-denied") {
        setUploadError("You don't have permission to update branding. Ask an organization admin.");
      } else {
        setUploadError("We couldn't remove the logo. Try again in a moment.");
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- Gate states --------------------------------------------------------
  if (authLoading || !orgLoaded || !roleLoaded) {
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
            You need to be signed in to view organization settings.
          </p>
          <div style={{ marginTop: 12 }}>
            <Link href="/login" style={primaryBtnStyle(true)}>Go to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!orgId) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>Settings</h1>
          <p style={{ marginTop: 8, fontSize: 13, color: "#b3b3b3" }}>
            We couldn&rsquo;t resolve which organization to show. Open the page
            from a job link that includes <code>?orgId=…</code>.
          </p>
        </div>
      </div>
    );
  }

  // ---- Render -------------------------------------------------------------
  return (
    <div style={pageStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={titleStyle}>Settings</h1>
        <Link href={backHref} style={secondaryBtnStyle}>
          ← Back to Jobs
        </Link>
      </div>

      <nav style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <Link href={tabHrefs.profile} style={tabStyle(false)}>Profile</Link>
        <Link href="#" aria-current="page" style={tabStyle(true)}>Organization</Link>
        <Link href={tabHrefs.team} style={tabStyle(false)}>Team</Link>
        <Link href={tabHrefs.vendors} style={tabStyle(false)}>Vendors</Link>
      </nav>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Branding</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "#6f6f6f", lineHeight: 1.55 }}>
          Your organization&rsquo;s logo appears on generated reports. PNG or
          JPG, up to 200&nbsp;KB. Transparent PNGs work cleanly against the
          dark report header.
        </p>

        {/* Current state row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "14px 14px",
            border: "1px solid #1c1c1c",
            borderRadius: 8,
            background: "#0b0b0b",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: 8,
              border: "1px solid #1c1c1c",
              background: "rgba(255,255,255,0.02)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            {currentLogoUrl ? (
              <img
                src={currentLogoUrl}
                alt={orgName ? `${orgName} logo` : "Organization logo"}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : (
              <span style={{ fontSize: 10, color: "#6f6f6f", letterSpacing: "0.08em" }}>
                LOGO
              </span>
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5" }}>
              {orgName || "Your organization"}
            </div>
            <div style={{ fontSize: 11, color: "#6f6f6f", marginTop: 2 }}>
              {currentLogoUrl ? "Logo on file." : "No logo uploaded yet."}
            </div>
          </div>
          {currentLogoUrl && isAdmin ? (
            <button
              type="button"
              onClick={handleRemove}
              disabled={saving}
              style={ghostBtnStyle(!saving)}
            >
              Remove
            </button>
          ) : null}
        </div>

        {/* Upload row */}
        <div style={{ marginTop: 14 }}>
          {isAdmin ? (
            <>
              <label
                htmlFor="org-logo-input"
                style={{
                  display: "inline-block",
                  padding: "10px 14px",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#f5f5f5",
                  border: "1px solid #1c1c1c",
                  borderRadius: 6,
                  background: "#0b0b0b",
                  cursor: "pointer",
                }}
              >
                Choose image…
              </label>
              <input
                id="org-logo-input"
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  void handleFilePicked(f);
                  // Reset the input so picking the same filename twice
                  // still fires onChange.
                  e.target.value = "";
                }}
                style={{ display: "none" }}
              />
              {pendingFileName ? (
                <span style={{ marginLeft: 12, fontSize: 12, color: "#b3b3b3" }}>
                  {pendingFileName}
                </span>
              ) : null}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "#6f6f6f", lineHeight: 1.55 }}>
              Only organization admins can change the logo. Ask an admin if you
              need branding updated.
            </div>
          )}

          {uploadError ? (
            <div
              role="alert"
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "#fca5a5",
                lineHeight: 1.5,
              }}
            >
              {uploadError}
            </div>
          ) : null}

          {pendingDataUrl ? (
            <div
              style={{
                marginTop: 12,
                padding: "12px 12px",
                border: "1px dashed #1c1c1c",
                borderRadius: 8,
                background: "rgba(200,168,78,0.04)",
                display: "flex",
                alignItems: "center",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 8,
                  border: "1px solid #1c1c1c",
                  background: "rgba(255,255,255,0.02)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                <img
                  src={pendingDataUrl}
                  alt="Logo preview"
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                />
              </div>
              <div style={{ minWidth: 0, flex: 1, fontSize: 12, color: "#b3b3b3" }}>
                Preview. Save to apply across reports.
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={primaryBtnStyle(!saving)}
              >
                {saving ? "Saving…" : "Save logo"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPendingDataUrl("");
                  setPendingFileName("");
                  setUploadError("");
                }}
                disabled={saving}
                style={ghostBtnStyle(!saving)}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {toastMsg ? (
        <div style={toastStyle}>{toastMsg}</div>
      ) : null}
    </div>
  );
}

// ---- Styles (mirror /settings) ---------------------------------------------

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

function ghostBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "9px 14px",
    fontSize: 12, fontWeight: 600,
    color: enabled ? "#b3b3b3" : "#6f6f6f",
    border: "1px solid #1c1c1c",
    borderRadius: 6,
    background: "transparent",
    cursor: enabled ? "pointer" : "not-allowed",
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
