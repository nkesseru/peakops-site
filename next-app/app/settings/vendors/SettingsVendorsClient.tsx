"use client";

// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
// /settings/vendors — view + (admin only) manage vendors of the
// active org. Mirrors the team-archive pattern: soft archive (no
// hard delete), audit metadata, partitioned active/archived display.
// Click row → edit modal (admin only). Archive button per row
// (admin only). Non-admin sees a read-only roster.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import {
  addVendor,
  archiveVendor,
  findDuplicateVendor,
  isValidVendorEmail,
  isValidVendorName,
  loadVendors,
  prettyOnboardingStatus,
  prettyVendorStatus,
  reactivateVendor,
  updateVendor,
  type OnboardingStatus,
  type Vendor,
  type VendorInput,
  type VendorStatus,
} from "@/lib/orgVendors";

export default function SettingsVendorsClient() {
  const sp = useSearchParams();
  const { user, loading: authLoading, claims } = useAuth();
  const uid = user?.uid || "";
  const myRole = String(claims.role || "").toLowerCase();

  const orgId = useMemo(() => {
    const fromQuery = String(sp?.get("orgId") || "").trim();
    let fromStorage = "";
    if (typeof window !== "undefined") {
      try {
        fromStorage = String(window.localStorage.getItem("peakops_orgId") || "").trim();
      } catch { /* ignore */ }
    }
    const fromClaims = (claims.orgIds[0] || "").trim();
    return fromQuery || fromStorage || fromClaims;
  }, [sp, claims.orgIds]);

  // PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
  // Same membership + admin gate as the team page. A user must
  // belong to the org first; admin claim adds write privileges.
  //
  // PEAKOPS_VENDOR_OWNER_PRIV_V1 (2026-05-07)
  // Slice 17 internal-alpha smoke caught that owners (role: "owner",
  // set by bootstrapPilotOrgV1) were UI-blocked from the vendor
  // controls — the Add Vendor button was hidden and the row Edit/
  // Archive buttons were suppressed. Firestore rules already grant
  // owners the same vendor write privileges as admins
  // (isOwnerOrAdmin in firestore.rules:155), so this was a UI-only
  // misalignment, not a data-layer change. Extending the predicate
  // here keeps `isAdmin` as the boolean privilege gate name (used
  // in 14+ sites incl. the VendorRow prop) but its semantic now
  // reads "admin-equivalent vendor management privilege" — owner
  // OR admin. Viewer / field / supervisor remain read-only,
  // unchanged.
  const isMemberOfOrg = !!orgId && claims.orgIds.includes(orgId);
  const isAdmin = isMemberOfOrg && (myRole === "admin" || myRole === "owner");

  const backHref = orgId ? `/incidents?orgId=${encodeURIComponent(orgId)}` : "/incidents";
  const profileHref = orgId ? `/settings?orgId=${encodeURIComponent(orgId)}` : "/settings";
  const teamHref = orgId ? `/settings/team?orgId=${encodeURIComponent(orgId)}` : "/settings/team";

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<string>("");
  const [archivedSectionOpen, setArchivedSectionOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string>("");
  // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
  const [archivingVendor, setArchivingVendor] = useState<Vendor | null>(null);

  // Partition once. The data is loaded together; the UI just slices.
  const activeVendors = vendors.filter((v) => v.status !== "archived");
  const archivedVendors = vendors.filter((v) => v.status === "archived");

  function toast(msg: string, ms = 2200) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), ms);
  }

  async function refresh() {
    if (!orgId) {
      setVendors([]);
      setLoaded(true);
      return;
    }
    try {
      const list = await loadVendors(orgId);
      setVendors(list);
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[vendors-load]", {
          path: `orgs/${orgId}/vendors`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't load vendors. Please refresh and try again.", 3500);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setLoaded(true); return; }
    if (!isMemberOfOrg) { setLoaded(true); return; }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, orgId, isMemberOfOrg]);

  // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
  // Dedup branching shared by create + update. If a match exists and
  // it's archived, surface the actionable "Reactivate instead" copy
  // (parallel to the team-archive flow). If active, surface the
  // standard "duplicate" copy. excludeId is passed by update so the
  // edited row doesn't match itself.
  function detectDuplicate(input: VendorInput, excludeId?: string): boolean {
    const dup = findDuplicateVendor(vendors, {
      name: input.name,
      email: input.email,
      excludeId,
    });
    if (!dup) return false;
    if (dup.status === "archived") {
      toast("This vendor is archived. Reactivate instead.", 4500);
    } else {
      toast("A vendor with this name or email already exists.", 3500);
    }
    return true;
  }

  async function handleCreate(input: VendorInput) {
    if (!isAdmin) return;
    if (detectDuplicate(input)) return;
    try {
      await addVendor(orgId, input);
      toast("Vendor added.");
      setCreateOpen(false);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[vendors-create]", { code: e?.code || null, message: String(e?.message || e) });
      }
      toast("We couldn't add that vendor. Please try again.", 3500);
    }
  }

  async function handleUpdate(input: VendorInput) {
    if (!isAdmin || !editingVendor) return;
    if (detectDuplicate(input, editingVendor.id)) return;
    try {
      await updateVendor(orgId, editingVendor.id, input);
      toast(`${input.name} updated.`);
      setEditingVendor(null);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[vendors-update]", { code: e?.code || null, message: String(e?.message || e) });
      }
      toast("We couldn't save those changes. Please try again.", 3500);
    }
  }

  // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
  // Custom archive modal replaces the v1 window.confirm. Captures
  // archivedAt + archivedBy + optional archiveReason. The flow:
  //   row Archive button → setArchivingVendor(v) → modal opens
  //   → user submits → handleArchiveSubmit → archiveVendor() write.
  async function handleArchiveSubmit(reason: string) {
    if (!isAdmin || !archivingVendor) return;
    setPendingArchive(archivingVendor.id);
    try {
      await archiveVendor(orgId, archivingVendor.id, {
        archivedBy: uid,
        archiveReason: reason,
      });
      toast("Vendor archived.");
      setArchivingVendor(null);
      setEditingVendor(null);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[vendors-archive]", {
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't archive that vendor. Please try again.", 3500);
    } finally {
      setPendingArchive("");
    }
  }

  // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
  // Reactivate uses window.confirm — there's no extra input to
  // collect, so a custom modal is overkill for v1.
  async function handleReactivate(vendor: Vendor) {
    if (!isAdmin) return;
    const confirmed = typeof window !== "undefined"
      ? window.confirm(`Reactivate ${vendor.name || "this vendor"}?`)
      : false;
    if (!confirmed) return;
    setPendingArchive(vendor.id);
    try {
      await reactivateVendor(orgId, vendor.id);
      toast("Vendor reactivated.");
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[vendors-reactivate]", {
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't reactivate that vendor. Please try again.", 3500);
    } finally {
      setPendingArchive("");
    }
  }

  // ---- Gate states ---------------------------------------------------------

  if (authLoading || !loaded) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} teamHref={teamHref} active="vendors" />
        <div style={cardStyle}><div style={{ fontSize: 12, color: "#6f6f6f" }}>Loading…</div></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} teamHref={teamHref} active="vendors" />
        <div style={cardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#b3b3b3" }}>
            You need to be signed in to view vendors.
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
        <Header backHref={backHref} profileHref={profileHref} teamHref={teamHref} active="vendors" />
        <div style={cardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#b3b3b3" }}>
            No organization selected. Open Mission Control once to set your active org, then come back.
          </p>
        </div>
      </div>
    );
  }

  if (!isMemberOfOrg) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} teamHref={teamHref} active="vendors" />
        <div style={cardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#b3b3b3" }}>
            You don't have access to this organization's vendors.
          </p>
        </div>
      </div>
    );
  }

  // ---- Render --------------------------------------------------------------

  return (
    <div style={pageStyle}>
      <Header backHref={backHref} profileHref={profileHref} teamHref={teamHref} active="vendors" />

      <section style={cardStyle}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 12, gap: 12,
        }}>
          <div>
            <h2 style={sectionHeadingStyle}>Vendors</h2>
            <div style={{ fontSize: 12, color: "#6f6f6f" }}>
              {activeVendors.length === 0
                ? "No vendors yet."
                : `${activeVendors.length} vendor${activeVendors.length === 1 ? "" : "s"}`}
            </div>
          </div>
          {isAdmin && (
            <button type="button" onClick={() => setCreateOpen(true)} style={primaryBtnStyle(true)}>
              Add vendor
            </button>
          )}
        </div>

        {!isAdmin && (
          <div style={readOnlyBannerStyle}>
            View only — only owners or admins can add or edit vendors.
          </div>
        )}

        {activeVendors.length === 0 ? (
          <div style={{ fontSize: 13, color: "#6f6f6f", padding: "12px 0" }}>
            {/* PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04) Spec copy. */}
            No vendors yet. Add your first vendor.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {activeVendors.map((v) => (
              <VendorRow
                key={v.id}
                vendor={v}
                isAdmin={isAdmin}
                archiving={pendingArchive === v.id}
                onOpen={() => isAdmin && setEditingVendor(v)}
                onArchive={() => setArchivingVendor(v)}
                onReactivate={() => handleReactivate(v)}
              />
            ))}
          </div>
        )}
      </section>

      {/* PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
          Archived section — collapsed by default, hidden entirely
          when zero archived. Now shows archive date + reason and a
          Reactivate button (admin only). */}
      {archivedVendors.length > 0 && (
        <section style={cardStyle}>
          <button
            type="button"
            onClick={() => setArchivedSectionOpen((vv) => !vv)}
            style={{
              width: "100%",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: 0, background: "transparent", border: 0,
              cursor: "pointer", color: "#b3b3b3",
            }}
          >
            <div style={{ textAlign: "left" }}>
              <h2 style={sectionHeadingStyle}>Archived vendors</h2>
              <div style={{ fontSize: 12, color: "#6f6f6f" }}>
                {archivedVendors.length} archived
              </div>
            </div>
            <span style={{ fontSize: 12, color: "#6f6f6f" }}>
              {archivedSectionOpen ? "Hide" : "Show"}
            </span>
          </button>
          {archivedSectionOpen && (
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {archivedVendors.map((v) => (
                <VendorRow
                  key={v.id}
                  vendor={v}
                  isAdmin={isAdmin}
                  archiving={pendingArchive === v.id}
                  onOpen={() => {}}
                  onArchive={() => {}}
                  onReactivate={() => handleReactivate(v)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {createOpen && (
        <VendorModal
          mode="create"
          onCancel={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      )}

      {editingVendor && (
        <VendorModal
          mode="edit"
          initial={editingVendor}
          onCancel={() => setEditingVendor(null)}
          onSubmit={handleUpdate}
        />
      )}

      {/* PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04) */}
      {archivingVendor && (
        <ArchiveVendorModal
          vendor={archivingVendor}
          onCancel={() => setArchivingVendor(null)}
          onSubmit={handleArchiveSubmit}
        />
      )}

      {toastMsg && <div style={toastStyle}>{toastMsg}</div>}
    </div>
  );
}

// ---- Header (tab nav) ------------------------------------------------------

function Header({
  backHref, profileHref, teamHref, active,
}: {
  backHref: string; profileHref: string; teamHref: string;
  active: "profile" | "team" | "vendors";
}) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={titleStyle}>Settings</h1>
        <Link href={backHref} style={secondaryBtnStyle}>← Back to Jobs</Link>
      </div>
      <nav style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <Link href={active === "profile" ? "#" : profileHref} style={tabStyle(active === "profile")}>Profile</Link>
        <Link href={active === "team" ? "#" : teamHref} style={tabStyle(active === "team")}>Team</Link>
        <Link href={active === "vendors" ? "#" : "/settings/vendors"} style={tabStyle(active === "vendors")}>Vendors</Link>
      </nav>
    </>
  );
}

// ---- Vendor row ------------------------------------------------------------

// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04) /
// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Click anywhere on the row (except the action buttons) → opens the
// edit modal. Action buttons stop propagation so they don't also
// open the modal. Non-admin: row is non-interactive. Archived rows
// show archive metadata (date + reason) and a Reactivate button
// (admin only). All admin rows expose an explicit Edit button for
// visual clarity in addition to the click-row affordance.
function VendorRow({
  vendor, isAdmin, archiving, onOpen, onArchive, onReactivate,
}: {
  vendor: Vendor;
  isAdmin: boolean;
  archiving: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onReactivate: () => void;
}) {
  const isArchived = vendor.status === "archived";
  const interactive = isAdmin && !isArchived;

  function handleRowClick() {
    if (!interactive) return;
    onOpen();
  }
  function handleRowKey(e: React.KeyboardEvent) {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
  // Render archive metadata for archived rows. Date is formatted
  // short; reason is truncated by ellipsis if long.
  const archivedAtIso = (() => {
    if (!isArchived) return "";
    const v: any = vendor.archivedAt;
    try {
      const iso = v?.toDate?.().toISOString?.() || (typeof v === "string" ? v : null);
      if (!iso) return "";
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return "";
      return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    } catch { return ""; }
  })();
  const reason = String(vendor.archiveReason || "").trim();

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleRowClick}
      onKeyDown={handleRowKey}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 12px",
        border: "1px solid #1c1c1c", borderRadius: 6,
        background: "#0b0b0b",
        opacity: isArchived ? 0.7 : 1,
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <div style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: "#f5f5f5", fontWeight: 500,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {vendor.name || "(no name)"}
        </div>
        <div style={{
          fontSize: 11, color: "#6f6f6f",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {[vendor.contactName, vendor.email, vendor.phone].filter(Boolean).join(" · ") || "—"}
        </div>
        {!isArchived && (
          <OnboardingBadge status={vendor.onboardingStatus} />
        )}
        {isArchived && (archivedAtIso || reason) && (
          <div style={{ fontSize: 10, color: "#6f6f6f", fontStyle: "italic" }}>
            Archived{archivedAtIso ? ` ${archivedAtIso}` : ""}{reason ? ` — ${reason}` : ""}
          </div>
        )}
      </div>
      <StatusBadge status={vendor.status} />
      {isAdmin && !isArchived && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            disabled={archiving}
            style={secondaryBtnStyle}
            title="Edit this vendor"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            disabled={archiving}
            style={dangerBtnStyle(!archiving)}
            title="Archive this vendor"
          >
            {archiving ? "Archiving…" : "Archive"}
          </button>
        </>
      )}
      {isAdmin && isArchived && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReactivate(); }}
          disabled={archiving}
          style={secondaryBtnStyle}
          title="Reactivate this vendor"
        >
          {archiving ? "Reactivating…" : "Reactivate"}
        </button>
      )}
    </div>
  );
}

// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Small subtle badge under the row meta line. Field is a placeholder
// for a future onboarding workflow — visible in the UI so operators
// know it exists, but no actions tied to it yet.
function OnboardingBadge({ status }: { status: OnboardingStatus }) {
  return (
    <div style={{ fontSize: 10, color: "#6f6f6f", marginTop: 2 }}>
      Onboarding: <span style={{ color: "#b3b3b3" }}>{prettyOnboardingStatus(status)}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: VendorStatus }) {
  const palette = STATUS_PALETTE[status];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
      textTransform: "uppercase",
      padding: "3px 8px", borderRadius: 999,
      background: palette.bg, color: palette.fg,
      border: `1px solid ${palette.border}`,
    }}>
      {prettyVendorStatus(status)}
    </span>
  );
}

const STATUS_PALETTE: Record<VendorStatus, { bg: string; fg: string; border: string }> = {
  active:   { bg: "rgba(126,232,141,0.08)", fg: "#86efac", border: "rgba(126,232,141,0.30)" },
  archived: { bg: "rgba(180,180,180,0.06)", fg: "#b3b3b3", border: "#1c1c1c" },
};

// ---- Vendor modal (Add + Edit) ---------------------------------------------

// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
// Single modal serves both Add and Edit. Status is intentionally
// not editable here — lifecycle changes go through Add (initial
// active) and Archive (one-way for v1). Validation: name required,
// email optional but shape-checked when present.
function VendorModal({
  mode, initial, onCancel, onSubmit,
}: {
  mode: "create" | "edit";
  initial?: Vendor;
  onCancel: () => void;
  onSubmit: (input: VendorInput) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [contactName, setContactName] = useState(initial?.contactName || "");
  const [email, setEmail] = useState(initial?.email || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const nameValid = isValidVendorName(trimmedName);
  const emailValid = isValidVendorEmail(trimmedEmail);
  const canSubmit = !busy && nameValid && emailValid;

  async function handle() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit({
        name: trimmedName,
        contactName: contactName.trim(),
        email: trimmedEmail,
        phone: phone.trim(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div style={{
        background: "#050505",
        border: "1px solid #1c1c1c",
        borderRadius: 8,
        padding: 20,
        width: "100%", maxWidth: 440,
      }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
          {mode === "create" ? "Add a vendor" : "Edit vendor"}
        </h3>

        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Name <span style={{ color: "#a44" }}>*</span></span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company or vendor name"
              maxLength={120}
              style={{ ...inputStyle, borderColor: !nameValid && name ? "#a44" : "#1c1c1c" }}
              autoFocus
            />
            {!nameValid && name && (
              <span style={{ fontSize: 11, color: "#e08383" }}>Name is required.</span>
            )}
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Contact name</span>
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Primary contact"
              maxLength={120}
              style={inputStyle}
            />
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@vendor.com"
              style={{ ...inputStyle, borderColor: !emailValid ? "#a44" : "#1c1c1c" }}
            />
            {!emailValid && (
              <span style={{ fontSize: 11, color: "#e08383" }}>Email doesn't look right.</span>
            )}
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Phone</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 555-5555"
              maxLength={32}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtnStyle}>Cancel</button>
          <button type="button" onClick={handle} disabled={!canSubmit} style={primaryBtnStyle(canSubmit)}>
            {busy ? "Saving…" : (mode === "create" ? "Add vendor" : "Save changes")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Archive vendor modal --------------------------------------------------

// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Custom confirm modal with optional reason input. Replaces the v2
// window.confirm. Title + body match the spec exactly. Reason is
// captured even though it's optional — useful for the audit trail
// when an admin remembers to add context.
function ArchiveVendorModal({
  vendor, onCancel, onSubmit,
}: {
  vendor: Vendor;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function handle() {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(reason.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div style={{
        background: "#050505",
        border: "1px solid #1c1c1c",
        borderRadius: 8,
        padding: 20,
        width: "100%", maxWidth: 420,
      }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
          Archive this vendor?
        </h3>
        <p style={{ margin: "0 0 4px", fontSize: 13, color: "#b3b3b3" }}>
          {vendor.name ? `${vendor.name} ` : "They "}will no longer be selectable, but history is preserved.
        </p>

        <div style={{ display: "grid", gap: 6, marginTop: 14 }}>
          <span style={fieldLabelStyle}>Reason (optional)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Contract ended"
            maxLength={120}
            style={inputStyle}
            autoFocus
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtnStyle}>
            Cancel
          </button>
          <button type="button" onClick={handle} disabled={busy} style={primaryBtnStyle(!busy)}>
            {busy ? "Archiving…" : "Archive vendor"}
          </button>
        </div>
      </div>
    </div>
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
const titleStyle: React.CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700, color: "#f5f5f5" };
const cardStyle: React.CSSProperties = {
  background: "#050505", border: "1px solid #1c1c1c", borderRadius: 8,
  padding: "16px 18px", marginBottom: 12,
};
const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 4px", fontSize: 11, fontWeight: 700,
  letterSpacing: "0.10em", textTransform: "uppercase", color: "#6f6f6f",
};
const fieldLabelStyle: React.CSSProperties = { fontSize: 11, color: "#6f6f6f", letterSpacing: "0.04em" };
const inputStyle: React.CSSProperties = {
  padding: "10px 12px", border: "1px solid #1c1c1c", borderRadius: 6,
  background: "#0b0b0b", color: "#f5f5f5", fontSize: 13, outline: "none", fontFamily: "inherit",
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 12px", fontSize: 11, fontWeight: 600,
  background: "transparent", color: "#b3b3b3",
  border: "1px solid #1c1c1c", borderRadius: 6,
  cursor: "pointer", textDecoration: "none", display: "inline-block",
};
const readOnlyBannerStyle: React.CSSProperties = {
  marginBottom: 12, padding: "8px 10px",
  border: "1px solid #1c1c1c", borderRadius: 6,
  background: "#0b0b0b",
  fontSize: 11, color: "#6f6f6f",
};
function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 14px", fontSize: 12, fontWeight: 600,
    background: active ? "#0b0b0b" : "transparent",
    color: active ? "#f5f5f5" : "#b3b3b3",
    border: "1px solid #1c1c1c",
    borderBottomColor: active ? "#C8A84E" : "#1c1c1c",
    borderRadius: 6, cursor: "pointer", textDecoration: "none",
  };
}
function primaryBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px", fontSize: 12, fontWeight: 700, border: 0, borderRadius: 6,
    cursor: enabled ? "pointer" : "not-allowed",
    color: enabled ? "#050505" : "#6f6f6f",
    background: enabled ? "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)" : "#1c1c1c",
    boxShadow: enabled ? "0 2px 12px rgba(200,168,78,0.20), inset 0 1px 0 rgba(255,255,255,0.08)" : "none",
    textDecoration: "none", display: "inline-block",
  };
}
function dangerBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "6px 12px", fontSize: 11, fontWeight: 600,
    background: "transparent",
    color: enabled ? "#e08383" : "#6f6f6f",
    border: `1px solid ${enabled ? "rgba(224,131,131,0.35)" : "#1c1c1c"}`,
    borderRadius: 6,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}
const toastStyle: React.CSSProperties = {
  position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0b0b0b", color: "#f5f5f5",
  border: "1px solid #1c1c1c", borderRadius: 6,
  padding: "10px 14px", fontSize: 12, zIndex: 50,
};
