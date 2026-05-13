"use client";

// PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
// Shared vendor picker for job/task panels. Three behaviors:
//   - canEdit=false → read-only text. Shows the assigned vendor's
//     name (or "No vendor assigned"). If the assignment points to
//     an archived vendor, that name still renders with an
//     "(archived)" suffix.
//   - canEdit=true, current vendor active or unassigned → dropdown
//     with "No vendor" + active vendors.
//   - canEdit=true, current vendor archived → dropdown shows the
//     archived vendor as the current selection (suffixed) plus the
//     active options. Choosing anything else clears the archived
//     reference. The archived vendor is NOT a selectable option for
//     a fresh task.
//
// Loads its own vendor list (one read per mount per orgId).
// Memoizing across instances would shave reads but isn't worth the
// state management for v1; vendor lists are small.

import { useEffect, useState } from "react";
import { loadActiveVendorsForOrg } from "@/lib/jobVendor";
import type { Vendor } from "@/lib/orgVendors";

export type VendorPickerProps = {
  orgId: string;
  currentVendorId: string;       // empty string when unassigned
  currentVendorName: string;     // empty string when unassigned
  canEdit: boolean;
  // null clears the assignment; otherwise picks a real active vendor.
  onChange: (vendor: { vendorId: string; vendorName: string } | null) => void | Promise<void>;
  // Compact (inline) layout for use inside meta lines (e.g. on
  // Summary / Review). Default is the full row layout used in the
  // primary assignment surface.
  compact?: boolean;
};

const NO_VENDOR_VALUE = "__none__";

export default function VendorPicker({
  orgId,
  currentVendorId,
  currentVendorName,
  canEdit,
  onChange,
  compact = false,
}: VendorPickerProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Load active vendors when the picker can edit. For read-only
  // mode we don't need the list — the displayed name comes from the
  // job doc directly.
  useEffect(() => {
    let cancelled = false;
    if (!canEdit) {
      setLoading(false);
      return;
    }
    if (!orgId) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const list = await loadActiveVendorsForOrg(orgId);
        if (!cancelled) setVendors(list);
      } catch (e: any) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[vendor-picker-load]", { orgId, code: e?.code || null, message: String(e?.message || e) });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, canEdit]);

  const hasAssignment = !!currentVendorId;
  // The assignment is to a currently-archived vendor when the id
  // points at someone NOT in the active list. Active list is the
  // source of truth for "assignable now" — we don't need to round-
  // trip the full vendor doc to know the archived state.
  const currentInActiveList = vendors.some((v) => v.id === currentVendorId);
  const isArchivedAssignment = canEdit && hasAssignment && !loading && !currentInActiveList;

  // ---- Read-only render ----------------------------------------------------

  if (!canEdit) {
    return (
      <span style={readOnlyStyle(compact)}>
        {hasAssignment
          ? currentVendorName || "(unknown vendor)"
          : compact ? "—" : NO_VENDOR_LABEL}
        {/* When read-only we have no signal that the vendor is
            archived (would need the active list); display the name
            verbatim. The audit/customer reports use the stored name
            directly too — same trade-off. */}
      </span>
    );
  }

  // ---- Editable render -----------------------------------------------------

  // Value mapped to the <select>. Special cases:
  //  - empty string → "No vendor" picked
  //  - id present, in active list → that vendor selected
  //  - id present, NOT in active list (archived) → leave on the
  //    archived sentinel so the user can choose "keep archived
  //    vendor" or pick another. We model that as a synthetic option.
  const selectedValue = !hasAssignment
    ? NO_VENDOR_VALUE
    : currentVendorId;

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const raw = e.target.value;
    setBusy(true);
    try {
      if (raw === NO_VENDOR_VALUE) {
        await onChange(null);
        return;
      }
      // Keep current archived assignment unchanged when the user
      // re-selects the synthetic "(archived)" sentinel.
      if (raw === currentVendorId && isArchivedAssignment) {
        return;
      }
      const picked = vendors.find((v) => v.id === raw);
      if (!picked) return;
      await onChange({ vendorId: picked.id, vendorName: picked.name });
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      value={selectedValue}
      onChange={handleChange}
      disabled={loading || busy}
      style={selectStyle(compact)}
      title={isArchivedAssignment ? "Currently assigned to an archived vendor." : "Select a vendor"}
    >
      <option value={NO_VENDOR_VALUE}>No vendor</option>
      {/* Show the archived assignment as a synthetic option so the
          user sees what they're keeping. Selecting any active option
          clears it. */}
      {isArchivedAssignment && (
        <option value={currentVendorId}>{currentVendorName || "(unknown)"} (archived)</option>
      )}
      {vendors.map((v) => (
        <option key={v.id} value={v.id}>{v.name || "(no name)"}</option>
      ))}
    </select>
  );
}

const NO_VENDOR_LABEL = "No vendor assigned";

function readOnlyStyle(compact: boolean): React.CSSProperties {
  return {
    fontSize: compact ? 11 : 13,
    color: "#b3b3b3",
  };
}

function selectStyle(compact: boolean): React.CSSProperties {
  return {
    padding: compact ? "4px 8px" : "8px 10px",
    fontSize: compact ? 11 : 13,
    background: "#0b0b0b",
    color: "#f5f5f5",
    border: "1px solid #1c1c1c",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    minWidth: 140,
  };
}
