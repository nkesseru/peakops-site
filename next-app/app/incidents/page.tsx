"use client";

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signOutUser } from "@/lib/auth";
import { useAuth } from "@/hooks/useAuth";
import { incidentPath } from "@/lib/navigation/incidentRoutes";
import { authedFetch } from "@/lib/apiClient";
import { logAnalyticsEvent } from "@/lib/analytics";
import { resolveJobDisplayState, jobDisplayStateKey, type JobDisplayState } from "@/lib/incidents/resolveJobDisplayState";
import NotificationsBell from "@/components/NotificationsBell";
import RequireAuth from "@/components/RequireAuth";
// PEAKOPS_ONBOARDING_DOWNSTREAM_VIEW_V1 (2026-05-08)
// Slice Onboarding 1.2 — wire onboarding selections into Mission
// Control so the empty state + Start Job panel reflect the
// industry/workflow the buyer picked during /onboarding.
import {
  DEFAULT_ORG_ONBOARDING_VIEW,
  loadOrgOnboardingView,
  type OrgOnboardingView,
} from "@/lib/onboarding/orgOnboardingView";
import { loadActiveVendorsForOrg } from "@/lib/jobVendor";
import {
  buildVendorSlugMap,
  resolveVendorByParam,
  type Vendor,
} from "@/lib/orgVendors";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";
import {
  MAX_SAVED_VIEWS,
  SavedViewsDuplicateError,
  SavedViewsLimitError,
  deleteView,
  filtersEqual,
  loadSavedViews,
  saveView,
  type SavedView,
} from "@/lib/savedViews";

// PEAKOPS_MISSION_CONTROL_V1 (2026-04-29)
// Operator dashboard for /incidents. Replaces the static "Recent
// Examples" launcher with three live sections (Resume Active Work,
// Supervisor Review Queue, My Incidents) sourced from listIncidentsV1.
type IncidentRow = {
  id: string;
  incidentId?: string;
  orgId?: string;
  title?: string;
  // PEAKOPS_INCIDENT_IDENTITY_V1 (2026-04-30) — canonical identity
  // resolved server-side. ONE label per incident, used by every
  // surface (dashboard rows, search index, future detail header).
  // The frontend never re-derives — `displayTitle` is the answer.
  displayTitle?: string;
  primaryTaskTitle?: string;
  titleSource?: "title" | "task" | "description" | "location" | "fallback";
  name?: string;
  description?: string;
  status?: string;
  location?: string;
  priority?: string;
  evidenceCount?: number;
  taskCount?: number;
  approvedTaskCount?: number;
  completedTaskCount?: number;
  packetReady?: boolean;
  reportReady?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  submittedAt?: string | null;
  closedAt?: string | null;
};

function reviewPath(id: string, orgId: string): string {
  const idEnc = encodeURIComponent(id);
  const orgEnc = encodeURIComponent(orgId);
  return `/incidents/${idEnc}/review?orgId=${orgEnc}`;
}

function fmtRelative(iso?: string | null): string {
  const v = String(iso || "").trim();
  if (!v) return "";
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "";
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`;
  try {
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

const SUPERVISOR_ROLES = new Set(["supervisor", "admin"]);

// PEAKOPS_INDUSTRY_AWARE_CHIPS_V1 (2026-05-11) — Slice Onboarding
// Recap + Industry-Aware Start Job 1.0.
//
// Industry-keyed chip presets for the Start Job job-type picker. Each
// chip declares:
//   - slug: identity for the chip; persisted as the active-chip
//     state so two chips that normalize to the same backend type
//     (e.g. muni "Stormwater" + "Sidewalk / ROW" both → inspection)
//     remain distinguishable in the UI.
//   - label: visible chip text. Also sent as `displayType` on the
//     create-incident payload so the picked phrase is preserved
//     server-side without changing the legacy `jobType` field.
//   - normalized: backend-stable jobType value. createIncidentV1
//     receives this in `jobType` unchanged. Downstream consumers
//     (reports, dashboards, lifecycle helpers) keep working as-is.
//
// Industries fall back to the default set when their key isn't in
// the map (covers "contractor", "other", or any unknown industry).
type IndustryChip = {
  slug: string;
  label: string;
  normalized: "repair" | "damage" | "inspection" | "other";
};

const JOB_TYPE_CHIPS_DEFAULT: ReadonlyArray<IndustryChip> = [
  { slug: "repair",     label: "Repair",     normalized: "repair" },
  { slug: "damage",     label: "Damage",     normalized: "damage" },
  { slug: "inspection", label: "Inspection", normalized: "inspection" },
  { slug: "other",      label: "Other",      normalized: "other" },
];

const JOB_TYPE_CHIPS_BY_INDUSTRY: Readonly<Record<string, ReadonlyArray<IndustryChip>>> = {
  municipality: [
    { slug: "stormwater",  label: "Stormwater",      normalized: "inspection" },
    { slug: "road_damage", label: "Road damage",     normalized: "damage" },
    { slug: "signal",      label: "Signal",          normalized: "repair" },
    { slug: "row",         label: "Sidewalk / ROW",  normalized: "inspection" },
    { slug: "contractor",  label: "Contractor",      normalized: "inspection" },
    { slug: "other",       label: "Other",           normalized: "other" },
  ],
  telecom: [
    { slug: "splice",      label: "Splice",     normalized: "inspection" },
    { slug: "osp",         label: "OSP",        normalized: "inspection" },
    { slug: "outage",      label: "Outage",     normalized: "damage" },
    { slug: "inspection",  label: "Inspection", normalized: "inspection" },
    { slug: "other",       label: "Other",      normalized: "other" },
  ],
  // PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 (2026-05-11) added Damage.
  utilities: [
    { slug: "outage",      label: "Outage",      normalized: "damage" },
    { slug: "pole",        label: "Pole",        normalized: "repair" },
    { slug: "transformer", label: "Transformer", normalized: "repair" },
    { slug: "vegetation",  label: "Vegetation",  normalized: "inspection" },
    { slug: "safety",      label: "Safety",      normalized: "inspection" },
    { slug: "damage",      label: "Damage",      normalized: "damage" },
    { slug: "other",       label: "Other",       normalized: "other" },
  ],
  // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — Slice Infrastructure
  // Contractor 1.0 chip set. Proof / Closeout / Safety /
  // Change order / Site condition / Client handoff each carry a
  // unique slug so they remain visually independent even though
  // several normalize to the same backend jobType.
  contractor: [
    { slug: "proof",          label: "Proof",          normalized: "inspection" },
    { slug: "closeout",       label: "Closeout",       normalized: "inspection" },
    { slug: "safety",         label: "Safety",         normalized: "inspection" },
    { slug: "change_order",   label: "Change order",   normalized: "other" },
    { slug: "site_condition", label: "Site condition", normalized: "inspection" },
    { slug: "client_handoff", label: "Client handoff", normalized: "other" },
    { slug: "other",          label: "Other",          normalized: "other" },
  ],
};

function getJobTypeChips(industry: string | null | undefined): ReadonlyArray<IndustryChip> {
  const key = String(industry || "").trim().toLowerCase();
  return JOB_TYPE_CHIPS_BY_INDUSTRY[key] || JOB_TYPE_CHIPS_DEFAULT;
}

// PEAKOPS_MISSION_CONTROL_V3 (2026-04-30)
// Single status normalizer. Every chip count, every section filter,
// and every search match runs through this function — guarantees
// the chip total always equals the section count, no drift between
// "Awaiting review · 1" and a Review Queue list of 10.
type NormalizedStatus = "open" | "in_progress" | "awaiting_review" | "approved" | "closed" | "sent_back" | "other";
// PEAKOPS_CANONICAL_STATE_V1 (2026-05-05)
// Mission Control's chip counts and per-row status pill now route
// through the shared `resolveJobDisplayState` helper. The helper
// treats Closed > Approved > Sent Back > Awaiting Review > In
// Progress > Open as the canonical priority, so a row that's been
// closed never reads as "awaiting review" because the Firestore
// status flipped late, and an approved row never gets a stale
// "submitted" pill. Listed below as a thin compat wrapper for the
// callers that already key off the lowercase chip slug.
function normalizeIncidentStatus(rowOrRawStatus: unknown): NormalizedStatus {
  // Accept both the legacy "raw status string" call shape and the
  // newer "incident row" call shape — the chip filter passes a row,
  // the search predicate passes raw status. The resolver tolerates
  // both because it reads from `status` and a handful of other
  // fields when present.
  const input = (rowOrRawStatus && typeof rowOrRawStatus === "object")
    ? rowOrRawStatus as Record<string, unknown>
    : { status: rowOrRawStatus };
  const display = resolveJobDisplayState(input as any);
  const key = jobDisplayStateKey(display);
  // Sent Back collapses into "awaiting_review" for chip-bucketing
  // purposes today (the Jobs page chip strip doesn't have a
  // dedicated Sent Back chip yet); it still renders distinctly on
  // the per-row pill via normalizedStatusLabel.
  if (key === "sent_back") return "awaiting_review";
  return key;
}

type ChipKey = "open" | "in_progress" | "awaiting_review" | "approved" | "closed";

// URL slug ↔ ChipKey roundtrip so the filter survives reloads and
// can be deep-linked from email / Slack / a saved bookmark.
const CHIP_KEY_TO_SLUG: Record<ChipKey, string> = {
  open: "open",
  in_progress: "in-progress",
  awaiting_review: "awaiting-review",
  approved: "approved",
  closed: "closed",
};
const SLUG_TO_CHIP_KEY: Record<string, ChipKey> = {
  open: "open",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  "awaiting-review": "awaiting_review",
  awaiting_review: "awaiting_review",
  approved: "approved",
  closed: "closed",
};

type ChipDef = { key: ChipKey; label: string };
const STATUS_CHIPS: ChipDef[] = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In Progress" },
  { key: "awaiting_review", label: "Awaiting Supervisor Review" },
  { key: "approved", label: "Approved" },
  { key: "closed", label: "Closed" },
];

// PEAKOPS_CANONICAL_STATE_V1 (2026-05-05) /
// PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
// Per-row status pill text. If the caller has already attached a
// pre-resolved `displayState` (from `jobsWithUiState`), trust it
// verbatim — that's the canonical pre-computed value, and rerunning
// the resolver per-render is wasteful. Otherwise resolve the input
// fresh. Legacy callers passing a bare status string still work.
function normalizedStatusLabel(rowOrRawStatus: unknown): string {
  if (rowOrRawStatus && typeof rowOrRawStatus === "object") {
    const obj = rowOrRawStatus as Record<string, unknown>;
    const pre = obj.displayState;
    if (typeof pre === "string" && pre) return pre;
    return resolveJobDisplayState(obj as any);
  }
  return resolveJobDisplayState({ status: rowOrRawStatus });
}

function priorityPill(priority?: string): { label: string; color: string; bg: string; border: string } | null {
  const p = String(priority || "").trim().toLowerCase();
  if (!p) return null;
  if (p === "urgent")
    return { label: "Urgent", color: "#fca5a5", bg: "rgba(220,60,60,0.10)", border: "rgba(220,60,60,0.35)" };
  if (p === "low")
    return { label: "Low", color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.35)" };
  if (p === "normal")
    return { label: "Normal", color: "#b3b3b3", bg: "transparent", border: "#1c1c1c" };
  return { label: p[0].toUpperCase() + p.slice(1), color: "#b3b3b3", bg: "transparent", border: "#1c1c1c" };
}

// PEAKOPS_INCIDENTS_INDEX_SUSPENSE_V1 (2026-04-27)
// useSearchParams() opts the route into dynamic rendering, but Next 16
// requires a Suspense boundary around any client tree that calls it,
// otherwise the prerender-time CSR bailout fails the build. The default
// export wraps the inner component in <Suspense> so prerender + runtime
// both work.
export default function IncidentsIndexPage() {
  return (
    <Suspense fallback={null}>
      <RequireAuth>
        <IncidentsIndexBody />
      </RequireAuth>
    </Suspense>
  );
}

function IncidentsIndexBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = String(searchParams?.get?.("orgId") || "").trim();
  const { user, loading: authLoading, claims } = useAuth();
  const [incidentId, setIncidentId] = useState("");

  // PEAKOPS_MISSION_CONTROL_V1 (2026-04-29)
  // Live incidents feed. Loaded on mount, refreshed on focus and on
  // an explicit Retry click. Customer-clean error copy — no raw
  // endpoint or status leaks (the underlying Error is dev-only
  // console.warn'd).
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [incidentsLoading, setIncidentsLoading] = useState<boolean>(false);
  const [incidentsErr, setIncidentsErr] = useState<string>("");
  const [incidentsLoaded, setIncidentsLoaded] = useState<boolean>(false);
  // PEAKOPS_MISSION_CONTROL_V2 (2026-04-29)
  // Header chrome, filter chips, and live search. Updated-at ticks
  // every 30s so the relative timestamp doesn't go stale on a tab
  // left open.
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNowTick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);
  // PEAKOPS_MISSION_CONTROL_V3 (2026-04-30)
  // Status filter is URL-persisted so a filtered view can be shared
  // by URL and survives a reload. ?status=awaiting-review, ?status=
  // approved, etc. Missing/all/unrecognized → null (All). Chip clicks
  // call setStatusFilterUrl() which both updates state and pushes the
  // new query string.
  const initialStatusFilter = (() => {
    const raw = String(searchParams?.get?.("status") || "").trim().toLowerCase();
    if (!raw || raw === "all") return null;
    return SLUG_TO_CHIP_KEY[raw] ?? null;
  })();
  const [statusFilter, setStatusFilter] = useState<ChipKey | null>(initialStatusFilter);
  // Keep state in sync with the URL on back/forward navigation.
  useEffect(() => {
    const raw = String(searchParams?.get?.("status") || "").trim().toLowerCase();
    const next = !raw || raw === "all" ? null : SLUG_TO_CHIP_KEY[raw] ?? null;
    setStatusFilter(next);
  }, [searchParams]);
  const setStatusFilterUrl = useCallback(
    (next: ChipKey | null) => {
      setStatusFilter(next);
      try {
        const sp = new URLSearchParams(window.location.search);
        if (orgId) sp.set("orgId", orgId); // preserve orgId
        if (next) sp.set("status", CHIP_KEY_TO_SLUG[next]);
        else sp.delete("status");
        const qs = sp.toString();
        const url = `/incidents${qs ? `?${qs}` : ""}`;
        // Use replace so back-button doesn't accumulate filter taps.
        router.replace(url);
      } catch {
        /* ignore — state already updated */
      }
    },
    [orgId, router],
  );
  const [searchTerm, setSearchTerm] = useState<string>("");

  // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
  // Date + vendor filters mirror the URL-persistence pattern used by
  // the status chips above. Source of truth lives in the URL so a
  // filtered view is shareable; back/forward navigation re-syncs
  // state via the same searchParams effect that drives status.
  type DateRangeKey = "today" | "7d" | "30d";
  function isDateRangeKey(v: unknown): v is DateRangeKey {
    return v === "today" || v === "7d" || v === "30d";
  }
  const initialDateFilter = (() => {
    const raw = String(searchParams?.get?.("date") || "").trim().toLowerCase();
    return isDateRangeKey(raw) ? raw : null;
  })();
  const initialVendorFilter = (() => {
    const raw = String(searchParams?.get?.("vendor") || "").trim();
    return raw || null;
  })();
  const [dateFilter, setDateFilter] = useState<DateRangeKey | null>(initialDateFilter);
  const [vendorFilter, setVendorFilter] = useState<string | null>(initialVendorFilter);

  useEffect(() => {
    const raw = String(searchParams?.get?.("date") || "").trim().toLowerCase();
    setDateFilter(isDateRangeKey(raw) ? raw : null);
  }, [searchParams]);

  // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
  // Active-vendors list for the dropdown. Loaded once per orgId.
  // Declared up here (before setFiltersUrl) because vendorSlugMaps
  // depends on it and setFiltersUrl depends on the slug map.
  const [activeVendors, setActiveVendors] = useState<Vendor[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!orgId) return;
    (async () => {
      try {
        const list = await loadActiveVendorsForOrg(orgId);
        if (!cancelled) setActiveVendors(list);
      } catch (e: any) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[mc-vendor-load]", { orgId, code: e?.code || null, message: String(e?.message || e) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // PEAKOPS_MC_FILTERS_V1_1 (2026-05-04)
  // Slug ↔ id maps. Rebuild whenever the active-vendor list changes.
  // Empty maps render harmlessly (the URL→state resolver returns
  // null and we fall through to the back-compat id check, which
  // also fails — net effect: vendor filter clears, which is the
  // right thing on an empty vendor list).
  const vendorSlugMaps = useMemo(
    () => buildVendorSlugMap(activeVendors),
    [activeVendors],
  );

  // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
  // One URL-update helper covers all three filters so callers don't
  // have to assemble URLSearchParams by hand at every chip/click site.
  // Pass `undefined` to leave a key alone, `null` to clear.
  const setFiltersUrl = useCallback(
    (next: { status?: ChipKey | null; date?: DateRangeKey | null; vendor?: string | null }) => {
      // PEAKOPS_MC_FILTERS_V1_2 (2026-05-04)
      // Any UI-driven filter change clears the unknown-vendor notice
      // — the user has acknowledged it implicitly by interacting.
      setUnknownVendorNotice("");
      if (next.status !== undefined) setStatusFilter(next.status);
      if (next.date !== undefined) setDateFilter(next.date);
      if (next.vendor !== undefined) setVendorFilter(next.vendor);
      try {
        const sp = new URLSearchParams(window.location.search);
        if (orgId) sp.set("orgId", orgId);
        if (next.status !== undefined) {
          if (next.status) sp.set("status", CHIP_KEY_TO_SLUG[next.status]);
          else sp.delete("status");
        }
        if (next.date !== undefined) {
          if (next.date) sp.set("date", next.date);
          else sp.delete("date");
        }
        if (next.vendor !== undefined) {
          if (next.vendor) {
            // PEAKOPS_MC_FILTERS_V1_1 (2026-05-04)
            // The internal vendor state is a vendorId; the URL
            // carries the friendly slug. Look up the slug for the
            // chosen vendor; fall back to the raw value if the
            // vendor isn't in our slug map (defensive — covers
            // race conditions where dropdown sets vendor before
            // the active list loaded).
            const slug = vendorSlugMaps.idToSlug.get(next.vendor) || next.vendor;
            sp.set("vendor", slug);
          } else {
            sp.delete("vendor");
          }
        }
        const qs = sp.toString();
        const url = `/incidents${qs ? `?${qs}` : ""}`;
        router.replace(url);
      } catch {
        /* state already updated */
      }
    },
    [orgId, router, vendorSlugMaps],
  );

  function clearAllFilters() {
    setFiltersUrl({ status: null, date: null, vendor: null });
  }
  const anyFilterActive = !!(statusFilter || dateFilter || vendorFilter);

  // PEAKOPS_MC_SAVED_VIEWS_V1 (2026-05-05)
  // Per-user saved filter configurations. Loaded once when uid is
  // available. Apply / save / delete go through the helpers in
  // lib/savedViews. Cap at MAX_SAVED_VIEWS — beyond that, the Save
  // button is disabled. Toast state is local to MC; no shared toast
  // infra elsewhere on this page.
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsLoaded, setSavedViewsLoaded] = useState(false);
  const [savedViewsToast, setSavedViewsToast] = useState<string>("");
  const uid = user?.uid || "";

  useEffect(() => {
    let cancelled = false;
    if (!uid) {
      setSavedViews([]);
      setSavedViewsLoaded(true);
      return;
    }
    (async () => {
      try {
        const list = await loadSavedViews(uid);
        if (!cancelled) setSavedViews(list);
      } catch (e: any) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[mc-saved-views-load]", { uid, code: e?.code || null, message: String(e?.message || e) });
        }
      } finally {
        if (!cancelled) setSavedViewsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [uid]);

  // Auto-dismiss the saved-views toast after ~3s. Each new toast
  // resets the window.
  useEffect(() => {
    if (!savedViewsToast) return;
    const t = window.setTimeout(() => setSavedViewsToast(""), 3000);
    return () => window.clearTimeout(t);
  }, [savedViewsToast]);

  // Active view = the saved view (if any) whose filters exactly
  // match the current URL state. Used to enable the Delete button
  // for a specific view.
  const activeSavedView = useMemo(() => {
    const current = {
      status: statusFilter || null,
      vendor: vendorFilter || null,
      date: dateFilter || null,
    };
    return savedViews.find((v) => filtersEqual(v.filters, current)) || null;
  }, [savedViews, statusFilter, vendorFilter, dateFilter]);

  async function refreshSavedViews() {
    if (!uid) return;
    try {
      const list = await loadSavedViews(uid);
      setSavedViews(list);
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[mc-saved-views-refresh]", { code: e?.code || null, message: String(e?.message || e) });
      }
    }
  }

  // PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
  // Modal state. saveModalOpen toggles SaveViewModal; deletingView
  // (a SavedView | null) drives the DeleteViewModal — using the
  // view itself rather than a boolean lets the modal display the
  // name and stay in sync if the dropdown selection changes mid-
  // flight. pendingSaveBusy / pendingDeleteBusy disable the modal
  // CTAs while the request is in flight, preventing the
  // double-click race the spec calls out.
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [deletingView, setDeletingView] = useState<SavedView | null>(null);
  const [pendingSaveBusy, setPendingSaveBusy] = useState(false);
  const [pendingDeleteBusy, setPendingDeleteBusy] = useState(false);

  // PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
  // Firestore SDK can throw an AbortError-shaped rejection during
  // listener teardown (component unmount mid-operation). Real
  // operational errors carry a Firestore code or a plain message;
  // those still need to surface as a toast. This guard lets us
  // silence ONLY the cleanup noise.
  function isAbortError(e: any): boolean {
    if (!e) return false;
    if (e?.name === "AbortError") return true;
    const code = String(e?.code || "").toLowerCase();
    if (code === "cancelled" || code === "aborted") return true;
    return false;
  }

  function openSaveViewModal() {
    if (!uid) return;
    if (savedViews.length >= MAX_SAVED_VIEWS) {
      // Cap check happens before the modal opens — no point letting
      // the user type a name they can't save.
      setSavedViewsToast(`Limit reached — ${MAX_SAVED_VIEWS} saved views max.`);
      return;
    }
    setSaveModalOpen(true);
  }

  async function handleSaveViewSubmit(name: string) {
    if (!uid || pendingSaveBusy) return;
    setPendingSaveBusy(true);
    try {
      await saveView(
        uid,
        name,
        {
          status: statusFilter || null,
          vendor: vendorFilter || null,
          date: dateFilter || null,
        },
        { existingViews: savedViews },
      );
      setSavedViewsToast("View saved.");
      setSaveModalOpen(false);
      await refreshSavedViews();
    } catch (e: any) {
      if (e instanceof SavedViewsLimitError) {
        setSavedViewsToast(`Limit reached — ${MAX_SAVED_VIEWS} saved views max.`);
        setSaveModalOpen(false);
        return;
      }
      if (e instanceof SavedViewsDuplicateError) {
        // Surfaced as a toast and ALSO returned to the modal as
        // an inline error via the throw — modal catches duplicate
        // before calling submit when possible (UI-side check).
        setSavedViewsToast("A view with this name already exists.");
        return;
      }
      if (isAbortError(e)) return; // listener teardown — silent
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[mc-saved-views-save]", { code: e?.code || null, message: String(e?.message || e) });
      }
      setSavedViewsToast("We couldn't save that view. Please try again.");
    } finally {
      setPendingSaveBusy(false);
    }
  }

  function handleApplySavedView(viewId: string) {
    const v = savedViews.find((sv) => sv.id === viewId);
    if (!v) return;
    // Validate types defensively before applying — saved view from
    // an older schema may carry unexpected values.
    const status = v.filters.status as ChipKey | null;
    const date = v.filters.date as DateRangeKey | null;
    const vendor = v.filters.vendor || null;
    setFiltersUrl({
      status: (status && SLUG_TO_CHIP_KEY[status]) ? status : (status as ChipKey) || null,
      date: isDateRangeKey(date) ? date : null,
      vendor,
    });
  }

  function openDeleteViewModal() {
    if (!uid || !activeSavedView) return;
    setDeletingView(activeSavedView);
  }

  async function handleDeleteViewConfirm() {
    if (!uid || !deletingView || pendingDeleteBusy) return;
    setPendingDeleteBusy(true);
    try {
      await deleteView(uid, deletingView.id);
      setSavedViewsToast("View deleted.");
      setDeletingView(null);
      await refreshSavedViews();
    } catch (e: any) {
      if (isAbortError(e)) return; // listener teardown — silent
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[mc-saved-views-delete]", { code: e?.code || null, message: String(e?.message || e) });
      }
      setSavedViewsToast("We couldn't delete that view. Please try again.");
    } finally {
      setPendingDeleteBusy(false);
    }
  }

  // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
  // Active-vendors list for the dropdown. Loaded once per orgId.
  // We don't refresh on vendor-archive elsewhere — the dropdown
  // reflects the snapshot at page load, which is fine because the
  // filter is a local UI affordance, not a real-time stream.
  // PEAKOPS_MC_FILTERS_V1_1 (2026-05-04) /
  // PEAKOPS_MC_FILTERS_V1_2 (2026-05-04)
  // Resolve `?vendor=<slug-or-id>` → vendorId, with two extra duties
  // beyond the raw resolution:
  //   1. URL canonicalization. When the param is a legacy raw id
  //      (or any non-canonical form) that resolves to a known
  //      vendor, rewrite the URL to the slug so the address bar
  //      reads cleanly. router.replace (not push) keeps the back
  //      button history clean. Other filter params are preserved.
  //   2. Unknown vendor handling. When the param doesn't resolve
  //      to any vendor at all, clear the param from the URL and
  //      surface a small inline notice in the filter bar so the
  //      user knows their filter was dropped.
  const [unknownVendorNotice, setUnknownVendorNotice] = useState<string>("");

  // PEAKOPS_MC_ADVANCED_FILTERS_V1 (2026-04-30)
  // Saved views + vendor + date filters live behind a "More filters"
  // disclosure so the operator front door doesn't read like an admin
  // dashboard. Defaults open if any of those filters is already
  // active (e.g., from a saved view URL) so the user can see what's
  // shaping their list.
  const [showMoreFilters, setShowMoreFilters] = useState<boolean>(false);
  useEffect(() => {
    const rawV = String(searchParams?.get?.("vendor") || "").trim();
    if (!rawV) {
      setVendorFilter(null);
      return;
    }
    if (activeVendors.length === 0) {
      // Vendors not loaded — wait for next pass.
      return;
    }
    const resolved = resolveVendorByParam(activeVendors, rawV);
    if (resolved) {
      setVendorFilter(resolved.id);
      const canonicalSlug = vendorSlugMaps.idToSlug.get(resolved.id) || rawV;
      // Canonicalize: if the URL's param differs from the canonical
      // slug, rewrite. Idempotent on subsequent runs.
      if (canonicalSlug && canonicalSlug !== rawV) {
        try {
          const sp = new URLSearchParams(window.location.search);
          sp.set("vendor", canonicalSlug);
          const qs = sp.toString();
          router.replace(`/incidents${qs ? `?${qs}` : ""}`);
        } catch {
          /* state already correct — URL update is best-effort */
        }
      }
      return;
    }
    // Unknown vendor — drop the filter, drop the param, notify.
    setVendorFilter(null);
    setUnknownVendorNotice("Vendor filter not found — showing all vendors.");
    try {
      const sp = new URLSearchParams(window.location.search);
      sp.delete("vendor");
      const qs = sp.toString();
      router.replace(`/incidents${qs ? `?${qs}` : ""}`);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, activeVendors, vendorSlugMaps]);

  // PEAKOPS_MC_FILTERS_V1_3 (2026-05-04)
  // Auto-dismiss the unknown-vendor notice ~6s after it's shown.
  // The timer is reset whenever the message is set again — so a
  // user who lands on two bad URLs in quick succession sees a
  // fresh 6s window each time, not a stale one. Cleared on unmount
  // and on explicit dismiss (the X button below) via the same
  // setUnknownVendorNotice("") path.
  useEffect(() => {
    if (!unknownVendorNotice) return;
    const t = window.setTimeout(() => setUnknownVendorNotice(""), 6000);
    return () => window.clearTimeout(t);
  }, [unknownVendorNotice]);

  // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
  // Vendor → incident IDs lookup. Built lazily when the vendor filter
  // is engaged: read each loaded incident's jobs subcollection in
  // parallel, build a Set<incidentId> of those that contain a job
  // assigned to the selected vendor. Cached per (orgId, vendorId)
  // pair so toggling vendor filters within one session is cheap
  // after first hit. The first time can fire up to N parallel reads
  // (one per loaded incident); fine for an org with ≤ 50 incidents
  // in the listing window. Larger orgs would benefit from a
  // server-side denormalization (vendorIds[] on the incident doc) —
  // out of scope for v1.
  const [incidentMatchesVendor, setIncidentMatchesVendor] = useState<Set<string>>(new Set());
  const [vendorMapLoading, setVendorMapLoading] = useState(false);
  const vendorMapKeyRef = useRef<string>("");

  useEffect(() => {
    if (!vendorFilter || incidents.length === 0) {
      setIncidentMatchesVendor(new Set());
      return;
    }
    const key = `${orgId}::${vendorFilter}::${incidents.length}`;
    if (vendorMapKeyRef.current === key) return; // cached
    vendorMapKeyRef.current = key;
    let cancelled = false;
    setVendorMapLoading(true);
    (async () => {
      try {
        const matches = new Set<string>();
        const checks = incidents.map(async (it) => {
          const id = String(it.id || "").trim();
          if (!id) return;
          try {
            const snap = await getDocs(collection(db, "incidents", id, "jobs"));
            for (const d of snap.docs) {
              const jv = String((d.data() as any)?.vendorId || "").trim();
              if (jv && jv === vendorFilter) {
                matches.add(id);
                return;
              }
            }
          } catch { /* one incident's failure shouldn't kill the rest */ }
        });
        await Promise.all(checks);
        if (!cancelled) setIncidentMatchesVendor(matches);
      } finally {
        if (!cancelled) setVendorMapLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorFilter, incidents, orgId]);

  // Dev-mode flag (?dev=1) — gates the Signed-in line and any
  // remaining engineering chrome. NODE_ENV alone is no longer enough.
  const devMode = useMemo(() => {
    try {
      const v = String(searchParams?.get?.("dev") || "").trim();
      return v === "1" || v.toLowerCase() === "true";
    } catch {
      return false;
    }
  }, [searchParams]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Cmd+/ or "/" anywhere on the page focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = String(t?.tagName || "").toLowerCase();
      const inField = tag === "input" || tag === "textarea" || (t as any)?.isContentEditable;
      if (e.key === "/" && !inField && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((e.key === "/" || e.key === "k") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadIncidents = useCallback(async () => {
    const oid = String(orgId || "").trim();
    if (!oid) return;
    setIncidentsLoading(true);
    setIncidentsErr("");
    try {
      const res = await authedFetch(
        `/api/fn/listIncidentsV1?orgId=${encodeURIComponent(oid)}&limit=50`,
        { cache: "no-store" },
      );
      const txt = await res.text().catch(() => "");
      let out: any = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch {}
      if (!res.ok || !out?.ok) {
        // PEAKOPS_MISSION_CONTROL_DEV_DIAG_V1 (2026-04-29)
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[mission-control] listIncidentsV1 non-ok", {
            httpStatus: res.status,
            error: String(out?.error || "").slice(0, 200),
            body: txt.slice(0, 240),
          });
        }
        // PEAKOPS_CLAIM_ACCESS_HARDENING_V1 (2026-05-11)
        // Attach the http status on the thrown error so the catch
        // block below can distinguish a real access denial (403,
        // post-retry — meaning authedFetch already attempted a
        // force-refreshed token and still got rejected) from a
        // generic transient failure. Customer copy below maps
        // them to two distinct, calm messages.
        const err: any = new Error(out?.error || `listIncidentsV1 failed: ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }
      const list = Array.isArray(out.incidents) ? (out.incidents as IncidentRow[]) : [];
      // PEAKOPS_MISSION_CONTROL_DEV_DIAG_V2 (2026-04-29)
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.debug("[mission-control] listIncidentsV1 ok", {
          count: list.length,
          sources: out?.sources || null,
          firstFew: list.slice(0, 3).map((it) => ({ id: it.id, status: it.status, title: it.title })),
        });
      }
      setIncidents(list);
      setIncidentsLoaded(true);
      setLastLoadedAt(Date.now());
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[mission-control] load failed", e);
      }
      // PEAKOPS_CLAIM_ACCESS_HARDENING_V1 (2026-05-11)
      // Distinguish access-denied from transient failure:
      //   - 401 → caller is signed out; authedFetch already routed
      //     them to /login, no extra copy needed (we still flip the
      //     err state so the row area shows something).
      //   - 403 (post-retry) → real access denial. The user has a
      //     valid signed-in session, but no access to this org.
      //     This is also the "claim just provisioned but token took
      //     longer than expected to propagate" terminal state, in
      //     which case the explicit "Refresh in a moment if access
      //     was just granted" hint is the right nudge.
      //   - anything else → generic transient retry copy.
      const status = Number(e?.httpStatus || 0);
      if (status === 403) {
        setIncidentsErr(
          "You don't have access to this workspace, or access is still finalizing. If access was just granted, refresh in a moment.",
        );
      } else if (status === 401) {
        setIncidentsErr("Your session expired. Sign in again to continue.");
      } else {
        setIncidentsErr("We couldn't load jobs. Try again.");
      }
    } finally {
      setIncidentsLoading(false);
    }
  }, [orgId]);

  // PEAKOPS_MC_AUTH_GATE_V1 (2026-05-06)
  // Slice 12.1: gate listIncidentsV1 on Firebase Auth state having
  // resolved. Previously this effect fired the call as soon as
  // orgId was present, which on cold load races the auth-restore
  // hydration in firebaseClient.ts and produces "Missing
  // Authorization header" 401 spikes before the token is hot. Now:
  //   - if authLoading → wait
  //   - if !authLoading && !user → no fetch; let useEffect below
  //     surface the signed-out state (or authedFetch redirect to
  //     /login on first attempt). The state is already covered by
  //     useAuth's onAuthStateChanged.
  //   - if !authLoading && user → fire normally.
  useEffect(() => {
    if (!orgId) return;
    if (authLoading) return;
    if (!user) return;
    void loadIncidents();
    const onFocus = () => { void loadIncidents(); };
    if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
    };
  }, [orgId, authLoading, user, loadIncidents]);

  // PEAKOPS_ONBOARDING_DOWNSTREAM_VIEW_V1 (2026-05-08)
  // Best-effort load of the org's onboarding view (industry,
  // selectedTemplate, copy hints). Failure mode is silent — the
  // view stays at DEFAULT and Mission Control falls back to its
  // hard-coded generic copy. Loaded once per orgId; same auth gate
  // pattern as loadIncidents.
  const [onboardingView, setOnboardingView] =
    useState<OrgOnboardingView>(DEFAULT_ORG_ONBOARDING_VIEW);
  useEffect(() => {
    if (!orgId) return;
    if (authLoading) return;
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const v = await loadOrgOnboardingView(orgId);
        if (!cancelled) setOnboardingView(v);
      } catch {
        /* swallow — fallback default already in state */
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, authLoading, user]);

  const role = String((claims as any)?.role || "").toLowerCase();
  const isSupervisor = SUPERVISOR_ROLES.has(role);
  const isAdmin = role === "admin";
  // PEAKOPS_SLICE12_2_VIEWER_GATE_V1 (2026-05-07)
  // Viewer is read-only across the lifecycle. Mission Control hides
  // the Start Job CTA and replaces the create-form expander with a
  // quiet view-only note so the page still reads as intentional
  // rather than broken. The createIncidentV1 callable is itself
  // role-gated server-side; this is the matching UI affordance.
  const isViewer = role === "viewer";

  // PEAKOPS_NOTIFICATIONS_DEBUG_TRIGGER_V1 (2026-05-05)
  // Admin-only, dev-only one-click test write. Hits the existing
  // /api/dev/createTestNotification endpoint (firebase-admin write to
  // users/{uid}/notifications) so the bell's onSnapshot listener
  // proves end-to-end without standing up a producer trigger. The
  // endpoint is itself gated on dev, but we double-gate the button
  // on devMode + admin role so a non-admin can't even see it.
  const [testNotifBusy, setTestNotifBusy] = useState<boolean>(false);
  // PEAKOPS_NOTIFICATIONS_DEBUG_TOAST_V2 (2026-05-05)
  // Dedicated toast state for the test-notification trigger.
  // Previously we reused savedViewsToast, but that toast renders
  // inside the saved-views row which is collapsed by default — so
  // QA never saw the "Test notification sent." confirmation. This
  // state has its own renderer next to the trigger button so the
  // success/failure feedback lands wherever the button does.
  const [testNotifToast, setTestNotifToast] = useState<string>("");
  useEffect(() => {
    if (!testNotifToast) return;
    const t = window.setTimeout(() => setTestNotifToast(""), 3000);
    return () => window.clearTimeout(t);
  }, [testNotifToast]);
  const handleSendTestNotification = useCallback(async () => {
    if (testNotifBusy) return;
    setTestNotifBusy(true);
    try {
      const res = await authedFetch("/api/dev/createTestNotification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: orgId || undefined,
          targetUrl: orgId ? `/incidents?orgId=${encodeURIComponent(orgId)}` : undefined,
        }),
      });
      const txt = await res.text().catch(() => "");
      let out: any = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch { /* ignore */ }
      if (!res.ok || !out?.ok) {
        throw new Error(out?.error || `createTestNotification failed: ${res.status}`);
      }
      setTestNotifToast("Test notification sent.");
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[notify-debug] dev test trigger failed", String(e?.message || e));
      }
      setTestNotifToast("We couldn't send the test notification.");
    } finally {
      setTestNotifBusy(false);
    }
  }, [orgId, testNotifBusy]);

  // PEAKOPS_MISSION_CONTROL_V3 (2026-04-30)
  // Chip-aware + search-aware filtering. Every count + every section
  // filter runs through the same `normalizeIncidentStatus()`, so chip
  // counts and section row counts can never disagree. Search now also
  // matches incidentId / id fragments / priority — operators can paste
  // a partial ID from email and find the row immediately.
  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05) /
  // PEAKOPS_JOBS_DEDUPE_V1 (2026-05-05)
  // The Jobs page derives every shortcut, chip count, and per-row
  // pill from a single annotated array. Two hard guarantees:
  //   1. Each incident appears AT MOST ONCE in this array — keyed by
  //      stable Firestore doc id. Belt-and-braces: the backend
  //      `listIncidentsV1` already de-duplicates the top-level vs
  //      org-scoped paths, but if a regression slips through we'd
  //      rather drop the second copy than ship duplicate rows.
  //   2. Each row carries a pre-resolved `displayState` so shortcuts
  //      and All Jobs read the same value — drift is impossible.
  const jobsWithUiState = useMemo<(IncidentRow & { displayState: JobDisplayState })[]>(
    () => {
      const list = Array.isArray(incidents) ? incidents : [];
      const byId = new Map<string, IncidentRow & { displayState: JobDisplayState }>();
      for (const it of list) {
        if (!it) continue;
        const key = String(it.id || it.incidentId || "").trim();
        if (!key) continue;
        if (byId.has(key)) continue;
        byId.set(key, { ...it, displayState: resolveJobDisplayState(it as any) });
      }
      return Array.from(byId.values());
    },
    [incidents],
  );

  // PEAKOPS_JOBS_DEDUPE_V1 (2026-05-05)
  // Dev-only page assertions. Surface every cross-section
  // contradiction to the console so QA can spot a regression in
  // the network tab + console pair without re-running the demo.
  // Production builds skip the check entirely.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const seen = new Map<string, JobDisplayState>();
    const titleSeen = new Map<string, string>(); // title → first id
    for (const j of jobsWithUiState) {
      const key = String(j.id || j.incidentId || "");
      if (!key) continue;
      const prior = seen.get(key);
      if (prior && prior !== j.displayState) {
        // eslint-disable-next-line no-console
        console.error("[PEAKOPS_STATE_CONFLICT]", key, [prior, j.displayState]);
      }
      seen.set(key, j.displayState);
      // (b) same normalized title appearing on different ids is
      //     usually fine (legitimate repeated work in demo data),
      //     but flag it so QA can confirm intent.
      const t = String(j.title || j.displayTitle || "").trim().toLowerCase();
      if (t) {
        const firstId = titleSeen.get(t);
        if (firstId && firstId !== key) {
          // eslint-disable-next-line no-console
          console.warn("[PEAKOPS_DUPLICATE_TITLE]", t, [firstId, key]);
        } else if (!firstId) {
          titleSeen.set(t, key);
        }
      }
    }
  }, [jobsWithUiState]);

  const matchesFilters = useCallback(
    (it: IncidentRow & { displayState?: JobDisplayState }): boolean => {
      // Use the pre-computed displayState when available, falling
      // back to a fresh resolve so callers that pass a raw row still
      // get the right answer.
      const display: JobDisplayState = it.displayState || resolveJobDisplayState(it as any);
      const norm = jobDisplayStateKey(display) === "sent_back" ? "awaiting_review" : jobDisplayStateKey(display);
      if (statusFilter && norm !== statusFilter) return false;

      // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
      // Date filter against `updatedAt`. "Today" = since local
      // midnight; 7d/30d = ms-window from now. Missing/invalid
      // updatedAt → row is excluded when a date filter is active —
      // can't claim it falls into a window we can't measure.
      if (dateFilter) {
        const ts = (() => {
          const v: any = it.updatedAt;
          if (!v) return NaN;
          const ms = Date.parse(String(v));
          return Number.isFinite(ms) ? ms : NaN;
        })();
        if (!Number.isFinite(ts)) return false;
        const now = Date.now();
        if (dateFilter === "today") {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          if (ts < startOfDay.getTime()) return false;
        } else if (dateFilter === "7d") {
          if (ts < now - 7 * 24 * 60 * 60 * 1000) return false;
        } else if (dateFilter === "30d") {
          if (ts < now - 30 * 24 * 60 * 60 * 1000) return false;
        }
      }

      // PEAKOPS_MC_FILTERS_V1 (2026-05-04)
      // Vendor filter: lazy-built set keyed by (orgId, vendorId).
      // While the lookup is in flight, the set is still empty — we
      // hide everything until it resolves so the user doesn't see
      // stale rows. Could flicker briefly; acceptable trade-off
      // versus showing rows that don't match the filter.
      if (vendorFilter) {
        if (!incidentMatchesVendor.has(String(it.id || ""))) return false;
      }

      const q = searchTerm.trim().toLowerCase();
      if (q) {
        // PEAKOPS_INCIDENT_IDENTITY_V1 (2026-04-30)
        // Search uses the same canonical identity as the rendered row.
        // Operators type what they SEE (`displayTitle`); power users
        // can also paste an id fragment, type the priority, or type
        // a status word. `primaryTaskTitle` is included so a typed
        // term still hits when displayTitle was resolved from a task.
        const fields = [
          it.displayTitle,
          it.title,
          it.primaryTaskTitle,
          it.name,
          it.description,
          it.location,
          it.priority,
          it.id,
          it.incidentId,
          String(it.status || "").trim().toLowerCase(),
          normalizedStatusLabel(it),
        ];
        const matched = fields.some((f) => String(f || "").toLowerCase().includes(q));
        if (!matched) return false;
      }
      return true;
    },
    [statusFilter, dateFilter, vendorFilter, incidentMatchesVendor, searchTerm],
  );

  const filteredIncidents = useMemo(
    () => jobsWithUiState.filter(matchesFilters),
    [jobsWithUiState, matchesFilters],
  );
  // PEAKOPS_JOBS_DEDUPE_V2 (2026-05-05)
  // All buyer-facing surfaces (All Jobs, Continue Work, Needs
  // Supervisor Review, Recently Closed) render ONE canonical row
  // per job. The demo data has legitimate repetition — many
  // incidents share a template title ("Storm damage inspection —
  // Utility Corridor 7" applied 4–6 times across separate Firestore
  // docs to populate history). Each doc is its own job at the
  // backend; the UI collapses them so the buyer sees a single live
  // row per work item.
  //
  // Group by normalized title. Within each group, the canonical row
  // is whichever incident is currently "live" — using this priority:
  //
  //   1. Non-closed display state (the active job for that title)
  //   2. Most recent updatedAt
  //   3. Most recent createdAt as final tiebreaker
  //
  // The closed/historical copies stay in Firestore unchanged but
  // don't surface anywhere on Mission Control today. A future
  // "History" disclosure can re-expose them; for the demo the live
  // row is the single source of truth per title. Chip counts run
  // off the deduped scope too so they agree with the rendered list.
  const dedupeByCanonical = useMemo(() => {
    const ts = (v: unknown): number => {
      if (!v) return 0;
      const ms = Date.parse(String(v));
      return Number.isFinite(ms) ? ms : 0;
    };
    const stateRank: Record<JobDisplayState, number> = {
      "In Progress": 6,
      "Open": 5,
      "Awaiting Supervisor Review": 4,
      "Sent Back": 3,
      "Approved": 2,
      "Closed": 1,
    };
    return (rows: ReadonlyArray<IncidentRow & { displayState: JobDisplayState }>): (IncidentRow & { displayState: JobDisplayState })[] => {
      const groups = new Map<string, IncidentRow & { displayState: JobDisplayState }>();
      for (const it of rows) {
        const norm = String(it.displayTitle || it.title || it.id || "").trim().toLowerCase();
        if (!norm) continue;
        const prev = groups.get(norm);
        if (!prev) { groups.set(norm, it); continue; }
        if (stateRank[it.displayState] !== stateRank[prev.displayState]) {
          if (stateRank[it.displayState] > stateRank[prev.displayState]) groups.set(norm, it);
          continue;
        }
        const aUpd = ts(it.updatedAt);
        const bUpd = ts(prev.updatedAt);
        if (aUpd !== bUpd) {
          if (aUpd > bUpd) groups.set(norm, it);
          continue;
        }
        if (ts(it.createdAt) > ts(prev.createdAt)) groups.set(norm, it);
      }
      return Array.from(groups.values()).sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
    };
  }, []);
  const dedupedFilteredIncidents = useMemo(
    () => dedupeByCanonical(filteredIncidents),
    [dedupeByCanonical, filteredIncidents],
  );
  const myIncidents = dedupedFilteredIncidents;

  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05) /
  // PEAKOPS_JOBS_DEDUPE_V2 (2026-05-05)
  // Every shortcut filter reads from the deduped canonical list so
  // shortcuts and All Jobs always agree on which row represents a
  // given title.
  //   Continue Work             — Open + In Progress
  //   Needs Supervisor Review   — Awaiting Supervisor Review
  //   Recently Closed           — Closed
  // Sent Back rows surface in All Jobs but don't get a dedicated
  // shortcut tile in v1.
  const activeIncidents = useMemo(
    () => dedupedFilteredIncidents.filter((it) => it.displayState === "Open" || it.displayState === "In Progress"),
    [dedupedFilteredIncidents],
  );
  const resumeIncident = activeIncidents[0]; // list is updatedAt desc
  const reviewQueue = useMemo(
    () => dedupedFilteredIncidents.filter((it) => it.displayState === "Awaiting Supervisor Review"),
    [dedupedFilteredIncidents],
  );

  const recentlyClosed = useMemo(
    () => dedupeByCanonical(jobsWithUiState).filter((it) => it.displayState === "Closed").slice(0, 5),
    [dedupeByCanonical, jobsWithUiState],
  );

  // PEAKOPS_JOBS_DEDUPE_V1 (2026-05-05) /
  // PEAKOPS_JOBS_DEDUPE_V2 (2026-05-05)
  // Dev-only page assertions on the rendered All Jobs list.
  //   (1) Each shortcut row is also in All Jobs.
  //   (2) No normalized title appears more than once in All Jobs
  //       (post-dedupe should be empty; the assertion fires only on
  //       a regression).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const allIds = new Set(myIncidents.map((it) => String(it.id || it.incidentId || "")));
    const checks: [string, ReadonlyArray<{ id?: string; incidentId?: string }>][] = [
      ["Continue Work", activeIncidents.slice(0, 3)],
      ["Needs Supervisor Review", reviewQueue.slice(0, 5)],
      ["Recently Closed", recentlyClosed],
    ];
    for (const [label, rows] of checks) {
      for (const r of rows) {
        const k = String(r.id || r.incidentId || "");
        if (!k) continue;
        if (!allIds.has(k)) {
          // PEAKOPS_SHORTCUT_DEBUG_DOWNGRADE_V1 (2026-05-08)
          // Downgraded from console.error to console.debug. The
          // shortcut shelves (Continue Work / Needs Supervisor
          // Review / Recently Closed) are intentionally drawn from
          // the unfiltered incident set and can legitimately
          // contain ids that are not in the user's currently
          // filtered All Jobs view. Treating that as an error
          // produced false-positive red console output during
          // normal filter changes. console.debug keeps the signal
          // available behind DevTools' Verbose level so engineers
          // chasing a real integrity drift can still see it.
          // eslint-disable-next-line no-console
          console.debug("[PEAKOPS_SHORTCUT_NOT_IN_ALL_JOBS]", label, k);
        }
      }
    }
    // Title-uniqueness assertion on the rendered table.
    const titleSeen = new Map<string, string>();
    for (const it of myIncidents) {
      const t = String(it.displayTitle || it.title || "").trim().toLowerCase();
      if (!t) continue;
      const firstId = titleSeen.get(t);
      if (firstId) {
        // eslint-disable-next-line no-console
        console.error("[PEAKOPS_DUPLICATE_TITLE_IN_ALL_JOBS]", t, [firstId, String(it.id || it.incidentId || "")]);
      } else {
        titleSeen.set(t, String(it.id || it.incidentId || ""));
      }
    }
  }, [myIncidents, activeIncidents, reviewQueue, recentlyClosed]);

  // PEAKOPS_MISSION_CONTROL_LAYOUT_V2 (2026-04-30)
  // Hide the Location column when fewer than half of the visible rows
  // have a non-empty location. Avoids rendering a mostly-empty column
  // for orgs that don't capture location, while still showing it when
  // the data is meaningful. Computed per-section so My Incidents and
  // Recently Closed can decide independently.
  function locationsMostlyEmpty(rows: IncidentRow[]): boolean {
    if (rows.length === 0) return true;
    const withLocation = rows.filter((r) => String(r.location || "").trim().length > 0).length;
    return withLocation < Math.ceil(rows.length / 2);
  }
  const myIncidentsHideLocation = useMemo(
    () => locationsMostlyEmpty(myIncidents),
    [myIncidents],
  );
  const recentlyClosedHideLocation = useMemo(
    () => locationsMostlyEmpty(recentlyClosed),
    [recentlyClosed],
  );

  // PEAKOPS_MC_FILTERS_V1_1 (2026-05-04)
  // Chip counts now reflect the CURRENT vendor + date scope, not the
  // raw incident list. Search and the status filter itself stay out
  // of the count input — the chip's job is to show "if I clicked
  // this status, how many would I get inside the active vendor/date
  // window?" Excluding the status filter from the count input is
  // what makes other chips remain non-zero while one is selected.
  // PEAKOPS_JOBS_DEDUPE_V2 (2026-05-05) — chip totals run off the
  // canonical (deduped) row set so the chip counts agree with the
  // rendered shortcuts and All Jobs.
  const incidentsInVendorDateScope = useMemo(() => {
    return dedupeByCanonical(jobsWithUiState).filter((it) => {
      // Date gate
      if (dateFilter) {
        const v: any = it.updatedAt;
        const ms = v ? Date.parse(String(v)) : NaN;
        if (!Number.isFinite(ms)) return false;
        const now = Date.now();
        if (dateFilter === "today") {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          if (ms < startOfDay.getTime()) return false;
        } else if (dateFilter === "7d") {
          if (ms < now - 7 * 24 * 60 * 60 * 1000) return false;
        } else if (dateFilter === "30d") {
          if (ms < now - 30 * 24 * 60 * 60 * 1000) return false;
        }
      }
      // Vendor gate
      if (vendorFilter) {
        if (!incidentMatchesVendor.has(String(it.id || ""))) return false;
      }
      return true;
    });
  }, [dedupeByCanonical, jobsWithUiState, dateFilter, vendorFilter, incidentMatchesVendor]);

  const chipCounts = useMemo(() => {
    const counts: Record<ChipKey, number> = {
      open: 0,
      in_progress: 0,
      awaiting_review: 0,
      approved: 0,
      closed: 0,
    };
    for (const it of incidentsInVendorDateScope) {
      // Read the pre-computed displayState; bucket Sent Back into
      // awaiting_review for chip totals (no dedicated chip in v1).
      const ds = it.displayState;
      if (ds === "Open") counts.open += 1;
      else if (ds === "In Progress") counts.in_progress += 1;
      else if (ds === "Awaiting Supervisor Review" || ds === "Sent Back") counts.awaiting_review += 1;
      else if (ds === "Approved") counts.approved += 1;
      else if (ds === "Closed") counts.closed += 1;
    }
    return counts;
  }, [incidentsInVendorDateScope]);

  // Recompute the relative-updated label every render so the 30s
  // tick interval (above) actually moves the displayed time forward.
  const updatedRelative = useMemo(() => {
    if (!lastLoadedAt) return "";
    return fmtRelative(new Date(lastLoadedAt).toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLoadedAt, /* nowTick triggers via setNowTick */]);

  // PEAKOPS_MISSION_CONTROL_LAYOUT_V1 (2026-04-30)
  // Compact one-line row for My Incidents + Recently Closed. CSS grid
  // gives a desktop table feel (Title · Status · Location · Counts ·
  // Updated · Action) while the same component collapses to a stacked
  // cluster on narrow viewports via grid-auto-flow + flex wrap.
  // Density: ~38px tall vs. ~70px for renderIncidentRow — roughly
  // 2× the rows visible per viewport.
  function renderCompactIncidentRow(
    it: IncidentRow,
    onActionClick: () => void,
    actionLabel: string = "Open →",
    opts?: { hideLocation?: boolean; muted?: boolean },
  ) {
    const statusLabel = normalizedStatusLabel(it);
    const counts: string[] = [];
    if (typeof it.evidenceCount === "number") {
      counts.push(`${it.evidenceCount} photo${it.evidenceCount === 1 ? "" : "s"}`);
    }
    if (typeof it.taskCount === "number") {
      counts.push(`${it.taskCount} task${it.taskCount === 1 ? "" : "s"}`);
    }
    const updated = it.updatedAt ? fmtRelative(it.updatedAt) : "";
    const label = String(it.displayTitle || "").trim() || "Untitled job";
    const hideLocation = !!opts?.hideLocation;
    const muted = !!opts?.muted;
    // PEAKOPS_MISSION_CONTROL_LAYOUT_V3 (2026-04-30)
    // Location column is omitted from the DOM entirely when
    // hideLocation is true — no display:none, so screen readers
    // don't announce a dead column. The grid template adjusts in
    // the same render to a 5-column layout matching the cells we
    // actually emit.
    const gridTemplate = hideLocation
      ? "minmax(0, 2.6fr) minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 0.9fr) auto"
      : "minmax(0, 2.4fr) minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1.1fr) minmax(0, 0.9fr) auto";
    return (
      <button
        key={it.id}
        type="button"
        onClick={onActionClick}
        title={label}
        className="peakops-mc-row"
        style={{
          width: "100%",
          textAlign: "left",
          display: "grid",
          gridTemplateColumns: gridTemplate,
          alignItems: "center",
          gap: 12,
          padding: "10px 12px",
          borderRadius: 6,
          border: muted ? "1px solid #161616" : "1px solid #1c1c1c",
          background: muted ? "transparent" : "#050505",
          color: muted ? "#8a8a8a" : "#b3b3b3",
          cursor: "pointer",
          fontSize: 12,
          lineHeight: 1.4,
          opacity: muted ? 0.85 : 1,
        }}
      >
        <span
          className="peakops-mc-row-title"
          style={{
            color: muted ? "#b3b3b3" : "#f5f5f5",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {label}
        </span>
        <span
          className="peakops-mc-row-status"
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 999,
            border: "1px solid #1c1c1c",
            background: muted ? "transparent" : "#0b0b0b",
            color: muted ? "#8a8a8a" : "#b3b3b3",
            justifySelf: "start",
            whiteSpace: "nowrap",
          }}
        >
          {statusLabel}
        </span>
        {hideLocation ? null : (
          <span
            className="peakops-mc-row-location"
            style={{
              color: "#6f6f6f",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {it.location || ""}
          </span>
        )}
        <span
          className="peakops-mc-row-counts"
          style={{ color: "#6f6f6f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {counts.join(" · ")}
        </span>
        <span className="peakops-mc-row-updated" style={{ color: "#6f6f6f", whiteSpace: "nowrap" }}>
          {updated}
        </span>
        <span
          className="peakops-mc-row-action"
          style={{
            color: muted ? "#8a8a8a" : "#C8A84E",
            fontWeight: 600,
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {actionLabel}
        </span>
      </button>
    );
  }

  // PEAKOPS_MISSION_CONTROL_V2 (2026-04-29)
  // Shared rich-row renderer for the hero/Resume + Review Queue
  // sections. Action label + handler is per-section.
  function renderIncidentRow(
    it: IncidentRow,
    actionLabel: string,
    onActionClick: () => void,
    opts?: { highlight?: boolean },
  ) {
    // PEAKOPS_MISSION_CONTROL_V4 (2026-04-30)
    // Badge label is sourced from `normalizedStatusLabel` so it
    // matches the chip filter exactly. Was previously
    // `incidentStatusLabel` which mapped `in_progress` → "Awaiting
    // review" — divergent from the chip's awaiting_review predicate.
    const statusLabel = normalizedStatusLabel(it);
    const pri = priorityPill(it.priority);
    const meta: Array<{ key: string; text: string }> = [];
    if (it.location) meta.push({ key: "loc", text: it.location });
    if (typeof it.evidenceCount === "number") {
      meta.push({ key: "ev", text: `${it.evidenceCount} photo${it.evidenceCount === 1 ? "" : "s"}` });
    }
    if (typeof it.taskCount === "number") {
      meta.push({ key: "tasks", text: `${it.taskCount} task${it.taskCount === 1 ? "" : "s"}` });
    }
    if (it.updatedAt) meta.push({ key: "upd", text: fmtRelative(it.updatedAt) });
    const highlight = !!opts?.highlight;
    return (
      <div
        key={it.id}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          borderRadius: 8,
          border: highlight ? "1px solid rgba(200,168,78,0.30)" : "1px solid #1c1c1c",
          background: highlight ? "rgba(200,168,78,0.04)" : "#050505",
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* PEAKOPS_INCIDENT_IDENTITY_V1 (2026-04-30)
                Canonical label: server-resolved displayTitle is the
                single source. No local fallback chain — backend is
                the only place this is computed, so every surface
                renders the same string. */}
            {(() => {
              const label = String(it.displayTitle || "").trim() || "Untitled job";
              return (
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#f5f5f5",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                  }}
                  title={label}
                >
                  {label}
                </div>
              );
            })()}
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: "#b3b3b3",
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid #1c1c1c",
                background: "#0b0b0b",
                whiteSpace: "nowrap",
              }}
            >
              {statusLabel}
            </span>
            {pri ? (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: pri.color,
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: `1px solid ${pri.border}`,
                  background: pri.bg,
                  whiteSpace: "nowrap",
                }}
              >
                {pri.label}
              </span>
            ) : null}
          </div>
          {meta.length > 0 ? (
            <div style={{ marginTop: 4, fontSize: 11, color: "#6f6f6f", display: "flex", flexWrap: "wrap", gap: 8 }}>
              {meta.map((m, i) => (
                <span key={m.key}>{i === 0 ? m.text : `· ${m.text}`}</span>
              ))}
            </div>
          ) : null}
        </div>
        {/* PEAKOPS_MISSION_CONTROL_LAYOUT_V2 (2026-04-30)
            Highlight (Resume Work) is now a gold-outline / dark-fill
            button — visually important but no longer competing with
            Create Incident, which remains the only solid-gold primary
            on the screen. Secondary rows stay neutral gray. */}
        <button
          type="button"
          onClick={onActionClick}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: highlight ? "1px solid rgba(200,168,78,0.50)" : "1px solid #1c1c1c",
            background: highlight ? "rgba(200,168,78,0.08)" : "#101010",
            color: highlight ? "#C8A84E" : "#b3b3b3",
            fontSize: 12,
            fontWeight: highlight ? 700 : 600,
            letterSpacing: "0.02em",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {actionLabel} →
        </button>
      </div>
    );
  }

  // PEAKOPS_INCIDENTS_INDEX_CREATE_V1 (2026-04-28)
  // Inline Create Incident state. The form is hidden by default; the
  // "Create Incident" button toggles it open. Submit calls
  // /api/fn/createIncidentV1 (auth + org membership enforced by the
  // catch-all /api/fn/[name] proxy) and routes to the new record on
  // success.
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string>("");
  const [createTitle, setCreateTitle] = useState("");
  const [createLocation, setCreateLocation] = useState("");
  const [createPriority, setCreatePriority] = useState<"low" | "normal" | "urgent">("normal");
  const [createNotes, setCreateNotes] = useState("");
  // PEAKOPS_START_JOB_TYPE_V1 (2026-04-30) /
  // PEAKOPS_INDUSTRY_AWARE_CHIPS_V1 (2026-05-11) — Slice Onboarding
  // Recap + Industry-Aware Start Job 1.0. The chip is intentionally
  // null on first open so the operator picks deliberately. A chip
  // carries:
  //   - slug: which chip was clicked (industry-specific identifier)
  //   - label: visible chip text (e.g. "Stormwater")
  //   - normalized: one of the four backend-stable jobType values
  //     (repair / damage / inspection / other). createIncidentV1
  //     keeps receiving `jobType` from this field unchanged, so
  //     nothing downstream that filters on the old union breaks.
  // On submit we also send the visible label as `displayType`, an
  // additive field. createIncidentV1 either stores it or strips it;
  // either way nothing breaks.
  type JobTypeChip = {
    slug: string;
    label: string;
    normalized: "repair" | "damage" | "inspection" | "other";
  };
  const [createJobChip, setCreateJobChip] = useState<JobTypeChip | null>(null);

  // PEAKOPS_OPEN_BY_ID_V2 (2026-04-29)
  // Single nav helper used by both the form's onSubmit and the
  // button's onClick. Splitting the click handler from the form
  // submit means a stale-input race or mobile soft-keyboard quirk
  // can't strand the user on a first tap that "did nothing." Reads
  // the latest input value at click time, no closure capture.
  function openIncidentById() {
    const id = String(incidentId || "").trim();
    // PEAKOPS_INCIDENTS_INDEX_ORGID_REQUIRED_V1 (2026-04-27)
    // orgId is required by every downstream incident route. Block here
    // rather than navigating to a URL that the destination will reject
    // with a misleading "Missing orgId" error screen.
    if (!id || !orgId) return;
    // Always shape: /incidents/<id>?orgId=<orgId>. incidentPath() builds
    // exactly that — preserving orgId, encoding both segments.
    router.push(incidentPath(id, orgId));
  }

  // PEAKOPS_INCIDENTS_INDEX_CREATE_V1 (2026-04-28)
  // Build a date-stamped incidentId matching existing examples
  // (e.g. inc_20260211_121658_26f47b). Pure client-side — the backend
  // requires incidentId in the request, no auto-generation.
  function generateIncidentId(): string {
    const d = new Date();
    const y = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const HH = String(d.getHours()).padStart(2, "0");
    const MM = String(d.getMinutes()).padStart(2, "0");
    const SS = String(d.getSeconds()).padStart(2, "0");
    const rand = Math.random().toString(36).slice(2, 8);
    return `inc_${y}${mm}${dd}_${HH}${MM}${SS}_${rand}`;
  }

  async function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    const title = createTitle.trim();
    if (!orgId || !title || !createJobChip || createBusy) return;
    setCreateBusy(true);
    setCreateErr("");
    const newIncidentId = generateIncidentId();
    try {
      const res = await authedFetch("/api/fn/createIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          incidentId: newIncidentId,
          title,
          status: "open",
          location: createLocation.trim() || undefined,
          priority: createPriority,
          // PEAKOPS_INDUSTRY_AWARE_CHIPS_V1 (2026-05-11)
          // `jobType` stays the backend-stable normalized union so
          // createIncidentV1 and every downstream consumer keep
          // working unchanged. `displayType` is the new additive
          // field that carries the industry-flavored label (e.g.
          // "Stormwater") — the function may persist or strip it,
          // either is fine.
          jobType: createJobChip.normalized,
          displayType: createJobChip.label,
          notes: createNotes.trim() || undefined,
        }),
      });
      const txt = await res.text().catch(() => "");
      let out: any = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch {}
      if (!res.ok || !out?.ok) {
        throw new Error(out?.error || `createIncidentV1 failed: ${res.status}`);
      }
      void logAnalyticsEvent("INCIDENT_CREATED", {
        incidentId: newIncidentId,
        orgId,
        jobType: createJobChip.normalized,
        priority: createPriority,
        hasLocation: Boolean(createLocation.trim()),
      });
      router.push(incidentPath(newIncidentId, orgId));
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[create-incident] failure", e);
      }
      setCreateErr("We couldn't start that job. Please check your connection and try again.");
      setCreateBusy(false);
    }
  }

  function resetCreateForm() {
    setCreateOpen(false);
    setCreateErr("");
    setCreateTitle("");
    setCreateLocation("");
    setCreatePriority("normal");
    setCreateNotes("");
    setCreateJobChip(null);
  }

  async function handleSignOut() {
    // PEAKOPS_LOGOUT_STALE_CLEANUP_V1 (2026-04-28)
    // Drop QA/local-run storage keys on logout. Firebase auth keys
    // are managed by the SDK — never touch those manually.
    try {
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.removeItem("peakops_return_to");
        } catch {}
        try {
          window.localStorage.removeItem("peakops_last_incident_id");
          // Drop per-incident "current task" memos and any QA-namespaced
          // keys. Iterate snapshot of keys so we can delete during iter.
          const keys = Object.keys(window.localStorage);
          for (const k of keys) {
            if (
              k.startsWith("peakops_current_job_") ||
              k.startsWith("peakops_qa_")
            ) {
              window.localStorage.removeItem(k);
            }
          }
        } catch {}
      }
    } catch {
      /* swallow */
    }
    try {
      await signOutUser();
      router.push("/login");
    } catch {
      /* swallow — auth state change will surface any persistent issue */
    }
  }

  const orgIdMissing = !orgId;
  const canSubmit = !!incidentId.trim() && !orgIdMissing;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#050505",
        color: "#f5f5f5",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: "32px 20px 64px",
      }}
    >
      {/* PEAKOPS_MISSION_CONTROL_LAYOUT_V2 (2026-04-30)
          Responsive mobile-collapse + optional location-hide rules
          live in app/globals.css under the `peakops-mc-*` namespace.
          Container widened from 640 → 1120 so Resume Active Work and
          Review Queue can render side-by-side at desktop widths. The
          inner grid stays single-column; section bodies use their own
          responsive grids where appropriate. */}
      <div style={{ maxWidth: 1120, margin: "0 auto", display: "grid", gap: 16 }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#f5f5f5" }}>
              Jobs
            </h1>
            <div style={{ marginTop: 4, fontSize: 13, color: "#b3b3b3", lineHeight: 1.5 }}>
              Start work, continue a job, or review jobs waiting for approval.
            </div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#6f6f6f" }}>
                {!orgIdMissing && lastLoadedAt
                  ? `Updated ${updatedRelative || "just now"}`
                  : !orgIdMissing && incidentsLoading
                  ? "Loading…"
                  : !orgIdMissing
                  ? "Not loaded yet"
                  : ""}
              </span>
              {!orgIdMissing ? (
                <button
                  type="button"
                  onClick={() => { void loadIncidents(); }}
                  disabled={incidentsLoading}
                  title="Refresh all sections"
                  style={{
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 600,
                    background: "transparent",
                    color: incidentsLoading ? "#6f6f6f" : "#b3b3b3",
                    border: "1px solid #1c1c1c",
                    borderRadius: 6,
                    cursor: incidentsLoading ? "not-allowed" : "pointer",
                  }}
                >
                  {incidentsLoading ? "Refreshing…" : "↻ Refresh"}
                </button>
              ) : null}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
            }}
          >
            {user?.email ? (
              <span style={{ fontSize: 11, color: "#6f6f6f" }}>
                Signed in as{" "}
                <span style={{ color: "#b3b3b3" }}>{user.email}</span>
              </span>
            ) : null}
            {/* PEAKOPS_NOTIFICATIONS_DEBUG_TRIGGER_V1 (2026-05-05)
                Dev + admin only. Subtle outline button that writes a
                synthetic notification doc to users/{uid}/notifications
                via /api/dev/createTestNotification. Confirms the
                bell's onSnapshot listener is wired before we light up
                the lifecycle producers (submit / report-ready). Two
                gates: (1) ?dev=1 in URL (devMode), (2) role === admin.
                Hidden in normal operator mode. */}
            {devMode && isAdmin ? (
              <>
                <button
                  type="button"
                  onClick={() => { void handleSendTestNotification(); }}
                  disabled={testNotifBusy}
                  title="Write a test notification to your feed (dev only)"
                  style={{
                    padding: "5px 10px",
                    fontSize: 11,
                    fontWeight: 600,
                    background: "transparent",
                    color: testNotifBusy ? "#6f6f6f" : "#C8A84E",
                    border: "1px dashed rgba(200,168,78,0.35)",
                    borderRadius: 6,
                    cursor: testNotifBusy ? "not-allowed" : "pointer",
                  }}
                >
                  {testNotifBusy ? "Sending…" : "Send test notification"}
                </button>
                {testNotifToast ? (
                  <span
                    role="status"
                    aria-live="polite"
                    style={{
                      fontSize: 11,
                      color: "#86efac",
                      padding: "3px 8px",
                      borderRadius: 999,
                      border: "1px solid rgba(34,197,94,0.30)",
                      background: "rgba(34,197,94,0.08)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {testNotifToast}
                  </span>
                ) : null}
              </>
            ) : null}
            {/* PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
                Bell icon + dropdown for in-app notifications. Sits
                between the user-info text and the Settings/Sign out
                controls. orgId hint helps the click-through routes
                preserve the current org context when a notification
                doc lacks one. */}
            <NotificationsBell orgIdHint={orgId} />
            {/* PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
                Settings entry point in the Mission Control header.
                Sits between the email + Sign out controls because
                it's user-scoped, not session-scoped. */}
            <Link
              href="/settings"
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                background: "transparent",
                color: "#b3b3b3",
                border: "1px solid #1c1c1c",
                borderRadius: 6,
                cursor: "pointer",
                textDecoration: "none",
              }}
            >
              Settings
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                background: "transparent",
                color: "#b3b3b3",
                border: "1px solid #1c1c1c",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Missing-orgId notice — blocks navigation until URL carries orgId */}
        {orgIdMissing ? (
          <section
            style={{
              borderRadius: 10,
              padding: "12px 16px",
              border: "1px solid rgba(220,60,60,0.35)",
              background: "rgba(220,60,60,0.08)",
              color: "#fca5a5",
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <div
              aria-hidden
              style={{
                flexShrink: 0,
                width: 28,
                height: 28,
                borderRadius: 999,
                background: "rgba(220,60,60,0.18)",
                color: "#fca5a5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                fontWeight: 800,
                lineHeight: 1,
              }}
            >
              ⚠
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                Org context required
              </div>
              <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, opacity: 0.9 }}>
                Open this app from your organisation&rsquo;s sign-in link, or
                add{" "}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    color: "#fff",
                  }}
                >
                  ?orgId=&lt;your-org&gt;
                </span>{" "}
                to the URL. Jobs cannot be opened without an org.
              </div>
            </div>
          </section>
        ) : null}

        {/* PEAKOPS_INCIDENTS_INDEX_CREATE_V1 (2026-04-28)
            Create Incident card. Collapsed by default; the gold
            primary button expands an inline form. Submit fires
            /api/fn/createIncidentV1 via the org-enforced proxy. */}
        <section
          style={{
            borderRadius: 12,
            border: "1px solid #1c1c1c",
            background: "#0b0b0b",
            padding: "16px 18px",
            opacity: orgIdMissing ? 0.55 : 1,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.10em",
                  color: "#C8A84E",
                  textTransform: "uppercase" as const,
                }}
              >
                {isViewer ? "View only" : "Start a Job"}
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: "#b3b3b3", lineHeight: 1.5 }}>
                {isViewer
                  ? "You can review jobs but cannot start new work."
                  : onboardingView.startJobSubhead}
              </div>
              {/* PEAKOPS_ONBOARDING_DOWNSTREAM_VIEW_V1 (2026-05-08)
                  Filing-aware hint, telecom + municipality only. The
                  copy in orgOnboardingView always carries the
                  "final filings remain your responsibility" qualifier
                  so the affordance never implies auto-submission. */}
              {!isViewer && onboardingView.filingHint ? (
                <div style={{ marginTop: 6, fontSize: 11, color: "#9a9a9a", lineHeight: 1.5 }}>
                  {onboardingView.filingHint}
                </div>
              ) : null}
            </div>
            {/* PEAKOPS_SLICE12_2_VIEWER_GATE_V1 (2026-05-07)
                Viewer role: hide the Start Job CTA. Section copy
                above already reflects the view-only posture. */}
            {!createOpen && !isViewer ? (
              <button
                type="button"
                disabled={orgIdMissing}
                onClick={() => setCreateOpen(true)}
                style={{
                  padding: "11px 18px",
                  borderRadius: 8,
                  border: orgIdMissing ? "1px solid #1c1c1c" : "none",
                  background: orgIdMissing
                    ? "#101010"
                    : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
                  color: orgIdMissing ? "#6f6f6f" : "#050505",
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                  cursor: orgIdMissing ? "not-allowed" : "pointer",
                  boxShadow: orgIdMissing ? "none" : "0 2px 12px rgba(200,168,78,0.20)",
                  flexShrink: 0,
                }}
              >
                Start Job
              </button>
            ) : null}
          </div>

          {createOpen ? (
            <form onSubmit={onCreateSubmit} style={{ marginTop: 16, display: "grid", gap: 12 }}>
              <div>
                <label
                  htmlFor="create-title"
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase" as const,
                    color: "#6f6f6f",
                    marginBottom: 6,
                  }}
                >
                  Job title <span style={{ color: "#C8A84E" }}>*</span>
                </label>
                <input
                  id="create-title"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  placeholder={onboardingView.startJobTitlePlaceholder}
                  autoFocus
                  required
                  spellCheck
                  autoComplete="off"
                  style={{
                    width: "100%",
                    padding: "11px 13px",
                    borderRadius: 8,
                    border: "1px solid #1c1c1c",
                    background: "#050505",
                    color: "#f5f5f5",
                    fontSize: 14,
                    outline: "none",
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="create-location"
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase" as const,
                    color: "#6f6f6f",
                    marginBottom: 6,
                  }}
                >
                  Site / location
                </label>
                <input
                  id="create-location"
                  value={createLocation}
                  onChange={(e) => setCreateLocation(e.target.value)}
                  placeholder="Address, intersection, or GPS"
                  autoComplete="off"
                  style={{
                    width: "100%",
                    padding: "11px 13px",
                    borderRadius: 8,
                    border: "1px solid #1c1c1c",
                    background: "#050505",
                    color: "#f5f5f5",
                    fontSize: 14,
                    outline: "none",
                  }}
                />
              </div>

              {/* PEAKOPS_START_JOB_TYPE_V1 (2026-04-30)
                  Job type segmented control. Required — submit stays
                  disabled until one is picked. Optional payload field
                  on the backend so older callers and existing
                  records without jobType keep working. */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase" as const,
                    color: "#6f6f6f",
                    marginBottom: 6,
                  }}
                >
                  Job type <span style={{ color: "#C8A84E" }}>*</span>
                </label>
                <div role="radiogroup" aria-label="Job type" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {/* PEAKOPS_INDUSTRY_AWARE_CHIPS_V1 (2026-05-11) —
                      chips adapt to the org's industry via the
                      onboardingView. Telecom orgs see splice / OSP /
                      outage / inspection; municipality sees
                      stormwater / road damage / signal / sidewalk-
                      ROW / contractor; utilities sees outage / pole
                      / transformer / vegetation / safety. Unknown
                      industries fall back to the legacy repair /
                      damage / inspection / other set. */}
                  {getJobTypeChips(onboardingView.industry).map((opt) => {
                    const active = createJobChip?.slug === opt.slug;
                    return (
                      <button
                        key={opt.slug}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setCreateJobChip({ ...opt })}
                        style={{
                          padding: "8px 14px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                          border: active ? "1px solid #C8A84E" : "1px solid #1c1c1c",
                          background: active ? "rgba(200,168,78,0.12)" : "#050505",
                          color: active ? "#C8A84E" : "#b3b3b3",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase" as const,
                    color: "#6f6f6f",
                    marginBottom: 6,
                  }}
                >
                  Priority
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {([
                    { value: "low", label: "Low" },
                    { value: "normal", label: "Normal" },
                    { value: "urgent", label: "Urgent" },
                  ] as const).map((opt) => {
                    const active = createPriority === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setCreatePriority(opt.value)}
                        style={{
                          padding: "8px 14px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                          border: active ? "1px solid #C8A84E" : "1px solid #1c1c1c",
                          background: active ? "rgba(200,168,78,0.12)" : "#050505",
                          color: active ? "#C8A84E" : "#b3b3b3",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label
                  htmlFor="create-notes"
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase" as const,
                    color: "#6f6f6f",
                    marginBottom: 6,
                  }}
                >
                  Notes
                </label>
                <textarea
                  id="create-notes"
                  value={createNotes}
                  onChange={(e) => setCreateNotes(e.target.value)}
                  placeholder="Optional — context for the field team"
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "11px 13px",
                    borderRadius: 8,
                    border: "1px solid #1c1c1c",
                    background: "#050505",
                    color: "#f5f5f5",
                    fontSize: 14,
                    outline: "none",
                    resize: "vertical",
                    fontFamily: "inherit",
                  }}
                />
              </div>

              {createErr ? (
                <div
                  style={{
                    borderRadius: 8,
                    padding: "10px 12px",
                    border: "1px solid rgba(220,60,60,0.35)",
                    background: "rgba(220,60,60,0.08)",
                    color: "#fca5a5",
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {createErr}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={resetCreateForm}
                  disabled={createBusy}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: createBusy ? "not-allowed" : "pointer",
                    border: "1px solid #1c1c1c",
                    background: "transparent",
                    color: "#b3b3b3",
                  }}
                >
                  Cancel
                </button>
                {(() => {
                  const submitDisabled = !createTitle.trim() || !createJobChip || createBusy || orgIdMissing;
                  const submitTitle = !createTitle.trim()
                    ? "Add a job title to continue"
                    : !createJobChip
                      ? "Pick a job type to continue"
                      : orgIdMissing
                        ? "Missing orgId in URL"
                        : "Start the job and begin capturing photos";
                  return (
                    <button
                      type="submit"
                      disabled={submitDisabled}
                      title={submitTitle}
                      style={{
                        padding: "10px 18px",
                        borderRadius: 8,
                        fontSize: 13,
                        fontWeight: 800,
                        letterSpacing: "0.02em",
                        cursor: submitDisabled ? "not-allowed" : "pointer",
                        border: "none",
                        background: submitDisabled
                          ? "#101010"
                          : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
                        color: submitDisabled ? "#6f6f6f" : "#050505",
                        boxShadow: submitDisabled
                          ? "none"
                          : "0 2px 12px rgba(200,168,78,0.20)",
                      }}
                    >
                      {createBusy ? "Starting job…" : "Start Capture →"}
                    </button>
                  );
                })()}
              </div>
            </form>
          ) : null}
        </section>

        {/* PEAKOPS_MISSION_CONTROL_LAYOUT_V1 (2026-04-30)
            Sticky chip + search bar. Stays at top of viewport while
            the user scrolls through My Incidents so they can refilter
            without scrolling back up. Backdrop-blur + dark border so
            it sits cleanly over the page background without occluding
            row content. */}
        {orgIdMissing ? null : (
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 30,
              margin: "0 -8px",
              padding: "10px 8px",
              background: "rgba(5,5,5,0.92)",
              backdropFilter: "blur(8px)",
              borderBottom: "1px solid #1c1c1c",
              display: "grid",
              gap: 10,
            }}
          >
            {/* PEAKOPS_MC_SAVED_VIEWS_V1 (2026-05-05) /
                PEAKOPS_MC_ADVANCED_FILTERS_V1 (2026-04-30)
                Saved views are an advanced filter — hidden behind the
                "More filters" disclosure unless a saved view is
                already active. Stays Firestore-gated on uid +
                savedViewsLoaded as before. */}
            {uid && savedViewsLoaded && (showMoreFilters || !!activeSavedView) && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6f6f6f" }}>
                  <span>Saved views</span>
                  <select
                    value={activeSavedView?.id || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) handleApplySavedView(v);
                    }}
                    disabled={savedViews.length === 0}
                    style={{
                      padding: "6px 10px",
                      fontSize: 12,
                      background: "#0b0b0b",
                      color: "#f5f5f5",
                      border: "1px solid #1c1c1c",
                      borderRadius: 6,
                      cursor: savedViews.length === 0 ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                      minWidth: 160,
                    }}
                  >
                    <option value="">
                      {savedViews.length === 0 ? "No saved views yet" : "Choose a saved view"}
                    </option>
                    {savedViews.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={openSaveViewModal}
                  disabled={savedViews.length >= MAX_SAVED_VIEWS}
                  title={
                    savedViews.length >= MAX_SAVED_VIEWS
                      ? `Limit reached — ${MAX_SAVED_VIEWS} saved views max.`
                      : "Save current filters as a view"
                  }
                  style={{
                    padding: "6px 12px",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: savedViews.length >= MAX_SAVED_VIEWS ? "not-allowed" : "pointer",
                    border: "1px solid #1c1c1c",
                    background: "transparent",
                    color: savedViews.length >= MAX_SAVED_VIEWS ? "#6f6f6f" : "#b3b3b3",
                    borderRadius: 6,
                  }}
                >
                  Save view
                </button>
                {activeSavedView && (
                  <button
                    type="button"
                    onClick={openDeleteViewModal}
                    title={`Delete saved view "${activeSavedView.name}"`}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: "1px solid rgba(224,131,131,0.35)",
                      background: "transparent",
                      color: "#e08383",
                      borderRadius: 6,
                    }}
                  >
                    Delete view
                  </button>
                )}
                {savedViewsToast && (
                  <span
                    role="status"
                    style={{
                      fontSize: 11,
                      color: "#b3b3b3",
                      padding: "3px 8px",
                      borderRadius: 999,
                      border: "1px solid #1c1c1c",
                      background: "#0b0b0b",
                    }}
                  >
                    {savedViewsToast}
                  </span>
                )}
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button
                type="button"
                onClick={() => setStatusFilterUrl(null)}
                aria-pressed={statusFilter === null}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: statusFilter === null ? "1px solid #C8A84E" : "1px solid #1c1c1c",
                  background: statusFilter === null ? "rgba(200,168,78,0.10)" : "#0b0b0b",
                  color: statusFilter === null ? "#C8A84E" : "#b3b3b3",
                }}
              >
                All <span style={{ marginLeft: 4, color: statusFilter === null ? "#C8A84E" : "#6f6f6f" }}>{incidentsInVendorDateScope.length}</span>
              </button>
              {STATUS_CHIPS.map((c) => {
                const active = statusFilter === c.key;
                const n = chipCounts[c.key];
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setStatusFilterUrl(active ? null : c.key)}
                    aria-pressed={active}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: active ? "1px solid #C8A84E" : "1px solid #1c1c1c",
                      background: active ? "rgba(200,168,78,0.10)" : "#0b0b0b",
                      color: active ? "#C8A84E" : "#b3b3b3",
                    }}
                  >
                    {c.label} <span style={{ marginLeft: 4, color: active ? "#C8A84E" : "#6f6f6f" }}>{n}</span>
                  </button>
                );
              })}
            </div>

            {/* PEAKOPS_MC_ADVANCED_FILTERS_V1 (2026-04-30)
                "More filters" toggle. Visible when any advanced filter
                is set (vendor, date, saved view) so the user can
                always see why their list is filtered, plus a manual
                toggle for everyone else. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowMoreFilters((v) => !v)}
                aria-expanded={showMoreFilters}
                style={{
                  padding: "5px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: "1px solid #1c1c1c",
                  background: "transparent",
                  color: "#b3b3b3",
                }}
              >
                {showMoreFilters ? "Fewer filters ▴" : "More filters ▾"}
              </button>
              {!showMoreFilters && (vendorFilter || dateFilter) ? (
                <span style={{ fontSize: 11, color: "#6f6f6f" }}>
                  {[vendorFilter ? "vendor" : null, dateFilter ? "date" : null].filter(Boolean).join(" · ")} filter active
                </span>
              ) : null}
            </div>

            {/* PEAKOPS_MC_FILTERS_V1 (2026-05-04) /
                PEAKOPS_MC_ADVANCED_FILTERS_V1 (2026-04-30)
                Vendor + date dropdowns are advanced filters now —
                hidden behind the "More filters" toggle unless one is
                already active (so the user always sees what's
                shaping the list). */}
            {(showMoreFilters || vendorFilter || dateFilter) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6f6f6f" }}>
                <span>Vendor</span>
                <select
                  value={vendorFilter || ""}
                  onChange={(e) => setFiltersUrl({ vendor: e.target.value || null })}
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    background: "#0b0b0b",
                    color: "#f5f5f5",
                    border: "1px solid #1c1c1c",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    minWidth: 140,
                  }}
                >
                  <option value="">All vendors</option>
                  {activeVendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name || "(no name)"}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6f6f6f" }}>
                <span>Updated</span>
                <select
                  value={dateFilter || ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFiltersUrl({ date: v === "today" || v === "7d" || v === "30d" ? v : null });
                  }}
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    background: "#0b0b0b",
                    color: "#f5f5f5",
                    border: "1px solid #1c1c1c",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    minWidth: 140,
                  }}
                >
                  <option value="">Any time</option>
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
              </label>
              {vendorMapLoading && vendorFilter ? (
                <span style={{ fontSize: 11, color: "#6f6f6f" }}>Filtering by vendor…</span>
              ) : null}
              {/* PEAKOPS_MC_FILTERS_V1_2 (2026-05-04) /
                  PEAKOPS_MC_FILTERS_V1_3 (2026-05-04)
                  Subtle inline notice when a URL had ?vendor=<unknown>
                  and we dropped the param. Three dismiss paths:
                    (a) the inline X button below
                    (b) any UI filter change (setFiltersUrl clears it)
                    (c) the 6s auto-dismiss timer in a useEffect above
                  Notice text is fixed copy; the invalid slug itself
                  is intentionally NOT echoed back to the user (could
                  be from a tampered URL). */}
              {unknownVendorNotice ? (
                <span
                  role="status"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "#C8A84E",
                    padding: "3px 4px 3px 8px",
                    borderRadius: 999,
                    border: "1px solid rgba(200,168,78,0.3)",
                    background: "rgba(200,168,78,0.08)",
                  }}
                >
                  <span>{unknownVendorNotice}</span>
                  <button
                    type="button"
                    onClick={() => setUnknownVendorNotice("")}
                    aria-label="Dismiss notice"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      border: "0",
                      background: "transparent",
                      color: "#C8A84E",
                      cursor: "pointer",
                      fontSize: 12,
                      lineHeight: "18px",
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ×
                  </button>
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              {anyFilterActive && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    border: "1px solid #1c1c1c",
                    background: "transparent",
                    color: "#b3b3b3",
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
            )}

            <div style={{ position: "relative" }}>
              <input
                ref={searchRef}
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search jobs by title, location, or status"
                aria-label="Search jobs"
                style={{
                  width: "100%",
                  padding: "10px 38px 10px 13px",
                  borderRadius: 8,
                  border: "1px solid #1c1c1c",
                  background: "#0b0b0b",
                  color: "#f5f5f5",
                  fontSize: 13,
                  outline: "none",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 10,
                  fontFamily: "ui-monospace, monospace",
                  color: "#6f6f6f",
                  border: "1px solid #1c1c1c",
                  borderRadius: 4,
                  padding: "1px 6px",
                  pointerEvents: "none",
                }}
                aria-hidden
              >
                /
              </span>
            </div>
          </div>
        )}

        {/* PEAKOPS_MISSION_CONTROL_LAYOUT_V1 (2026-04-30)
            Resume Active Work + Review Queue render side-by-side at
            desktop widths, stack on narrow screens. `auto-fit` with
            a 360px minimum gives a clean responsive break — single
            column on phones, two columns once viewport >= ~770px. */}
        {orgIdMissing ? null : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
              gap: 16,
              // PEAKOPS_MISSION_CONTROL_LAYOUT_V2 (2026-04-30)
              // Cards take their natural height instead of stretching
              // to match the tallest sibling. Avoids a Review Queue
              // with 1 row leaving a giant blank panel next to a
              // 3-row Resume Active Work.
              alignItems: "start",
            }}
          >
            <section
              style={{
                borderRadius: 12,
                border: "1px solid #1c1c1c",
                background: "#0b0b0b",
                padding: "16px 18px",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.10em",
                    color: "#C8A84E",
                    textTransform: "uppercase" as const,
                  }}
                >
                  Continue Work
                </div>
                {!incidentsLoading && !incidentsErr && activeIncidents.length > 0 ? (
                  <span style={{ fontSize: 11, color: "#6f6f6f" }}>· {activeIncidents.length}</span>
                ) : null}
              </div>
              {incidentsLoading && !incidentsLoaded ? (
                <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>Loading jobs…</div>
              ) : incidentsErr ? (
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, color: "#fca5a5" }}>{incidentsErr}</div>
                  <button
                    type="button"
                    onClick={() => { void loadIncidents(); }}
                    disabled={incidentsLoading}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      background: "transparent",
                      color: incidentsLoading ? "#6f6f6f" : "#b3b3b3",
                      border: "1px solid #1c1c1c",
                      borderRadius: 6,
                      cursor: incidentsLoading ? "not-allowed" : "pointer",
                    }}
                  >
                    {incidentsLoading ? "Retrying…" : "Try again"}
                  </button>
                </div>
              ) : !resumeIncident ? (
                <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>
                  No active jobs right now.
                </div>
              ) : (
                /* PEAKOPS_MISSION_CONTROL_LAYOUT_V1 (2026-04-30)
                   Top 3 active incidents instead of one. First row is
                   the gold-bordered highlight with the yellow Resume
                   Work CTA; rows 2 and 3 are gray secondaries so the
                   user sees the active backlog at a glance without
                   scrolling. Same renderIncidentRow component, just
                   different highlight prop. */
                <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                  {activeIncidents.slice(0, 3).map((it, i) =>
                    renderIncidentRow(
                      it,
                      i === 0 ? "Continue →" : "Open",
                      () => router.push(incidentPath(it.id, orgId)),
                      { highlight: i === 0 },
                    ),
                  )}
                </div>
              )}
            </section>

            {isSupervisor ? (
              <section
                style={{
                  borderRadius: 12,
                  border: "1px solid #1c1c1c",
                  background: "#0b0b0b",
                  padding: "16px 18px",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.10em",
                      color: "#C8A84E",
                      textTransform: "uppercase" as const,
                    }}
                  >
                    Needs Supervisor Review
                  </div>
                  {!incidentsLoading && !incidentsErr && reviewQueue.length > 0 ? (
                    <span style={{ fontSize: 11, color: "#6f6f6f" }}>· {reviewQueue.length}</span>
                  ) : null}
                </div>
                {incidentsLoading && !incidentsLoaded ? (
                  <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>Loading jobs…</div>
                ) : incidentsErr ? (
                  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 13, color: "#fca5a5" }}>{incidentsErr}</div>
                    <button
                      type="button"
                      onClick={() => { void loadIncidents(); }}
                      disabled={incidentsLoading}
                      style={{
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        background: "transparent",
                        color: incidentsLoading ? "#6f6f6f" : "#b3b3b3",
                        border: "1px solid #1c1c1c",
                        borderRadius: 6,
                        cursor: incidentsLoading ? "not-allowed" : "pointer",
                      }}
                    >
                      {incidentsLoading ? "Retrying…" : "Try again"}
                    </button>
                  </div>
                ) : reviewQueue.length === 0 ? (
                  <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>
                    No jobs waiting for review.
                  </div>
                ) : (
                  <>
                    <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                      {reviewQueue.slice(0, 5).map((it) =>
                        renderIncidentRow(it, "Review →", () => router.push(reviewPath(it.id, orgId))),
                      )}
                    </div>
                    {/* PEAKOPS_MISSION_CONTROL_LAYOUT_V3 (2026-04-30)
                        Compact summary line beneath the review rows.
                        When the queue is short (1 row), this fills the
                        otherwise-blank space below without forcing a
                        decorative panel; when the queue is longer, it
                        just confirms the count operationally. */}
                    <div
                      style={{
                        marginTop: 10,
                        paddingTop: 8,
                        borderTop: "1px solid #161616",
                        fontSize: 11,
                        color: "#6f6f6f",
                      }}
                    >
                      {reviewQueue.length === 1
                        ? "1 job waiting for review."
                        : reviewQueue.length <= 5
                          ? `${reviewQueue.length} jobs waiting for review.`
                          : `Showing 5 of ${reviewQueue.length} jobs waiting for review.`}
                    </div>
                  </>
                )}
              </section>
            ) : null}
          </div>
        )}

        {/* PEAKOPS_MISSION_CONTROL_V1 — My Incidents */}
        {!orgIdMissing ? (
          <section
            style={{
              borderRadius: 12,
              border: "1px solid #1c1c1c",
              background: "#0b0b0b",
              padding: "16px 18px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.10em",
                  color: "#C8A84E",
                  textTransform: "uppercase" as const,
                }}
              >
                All Jobs
              </div>
              {/* PEAKOPS_JOBS_DEDUPE_V2 (2026-05-05)
                  Section count reads off `myIncidents` (the deduped
                  canonical array — same source the chip totals run
                  off of). Was previously `filteredIncidents.length`,
                  which counted the raw rows including the historical
                  closed copies that are collapsed out of the table —
                  showing "· 44" while the chips totalled 11. */}
              {!incidentsLoading && !incidentsErr && myIncidents.length > 0 ? (
                <span style={{ fontSize: 11, color: "#6f6f6f" }}>· {myIncidents.length}</span>
              ) : null}
            </div>
            {incidentsLoading && !incidentsLoaded ? (
              <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>Loading jobs…</div>
            ) : incidentsErr ? (
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, color: "#fca5a5" }}>{incidentsErr}</div>
                <button
                  type="button"
                  onClick={() => { void loadIncidents(); }}
                  disabled={incidentsLoading}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    background: "transparent",
                    color: incidentsLoading ? "#6f6f6f" : "#b3b3b3",
                    border: "1px solid #1c1c1c",
                    borderRadius: 6,
                    cursor: incidentsLoading ? "not-allowed" : "pointer",
                  }}
                >
                  {incidentsLoading ? "Retrying…" : "Try again"}
                </button>
              </div>
            ) : myIncidents.length === 0 ? (
              incidents.length === 0 ? (
                <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f", lineHeight: 1.55 }}>
                  {isViewer
                    ? "No jobs to review yet."
                    : (<>{onboardingView.emptyStatePrompt} — tap <span style={{ color: "#C8A84E", fontWeight: 600 }}>Start Job</span> above to get started.</>)}
                </div>
              ) : (
                <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f", lineHeight: 1.55 }}>
                  No jobs match your filters.
                </div>
              )
            ) : (
              /* PEAKOPS_MISSION_CONTROL_LAYOUT_V1 (2026-04-30)
                 Card list → compact table. Column header strip on
                 desktop only (hidden under 720px), then one
                 renderCompactIncidentRow per incident. ~2× the
                 visible row density at the same viewport height. */
              <div style={{ marginTop: 12 }}>
                <div
                  className="peakops-mc-table-header"
                  style={{
                    display: "grid",
                    gridTemplateColumns: myIncidentsHideLocation
                      ? "minmax(0, 2.6fr) minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 0.9fr) auto"
                      : "minmax(0, 2.4fr) minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1.1fr) minmax(0, 0.9fr) auto",
                    alignItems: "center",
                    gap: 12,
                    padding: "0 12px 6px",
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.10em",
                    color: "#6f6f6f",
                    textTransform: "uppercase" as const,
                  }}
                >
                  <span>Title</span>
                  <span>Status</span>
                  {myIncidentsHideLocation ? null : <span>Location</span>}
                  <span>Photos · Tasks</span>
                  <span>Updated</span>
                  <span style={{ minWidth: 48 }} />
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {myIncidents.map((it) =>
                    renderCompactIncidentRow(
                      it,
                      () => router.push(incidentPath(it.id, orgId)),
                      "Open →",
                      { hideLocation: myIncidentsHideLocation },
                    ),
                  )}
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* PEAKOPS_MISSION_CONTROL_LAYOUT_V3 (2026-04-30) — Recently Closed
            Visually demoted to feel historical, not active queue:
            transparent panel background, gray (not gold) eyebrow,
            and rows render with `muted: true` so titles read in mid
            gray instead of white. Reads as "log of finished work"
            rather than "another inbox to clear." */}
        {!orgIdMissing && recentlyClosed.length > 0 ? (
          <section
            style={{
              borderRadius: 12,
              border: "1px solid #161616",
              background: "transparent",
              padding: "12px 14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  color: "#6f6f6f",
                  textTransform: "uppercase" as const,
                }}
              >
                Recently Closed
              </div>
              <span style={{ fontSize: 10, color: "#6f6f6f" }}>· {recentlyClosed.length}</span>
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 3 }}>
              {recentlyClosed.map((it) =>
                renderCompactIncidentRow(
                  it,
                  () => router.push(incidentPath(it.id, orgId)),
                  "View →",
                  { hideLocation: recentlyClosedHideLocation, muted: true },
                ),
              )}
            </div>
          </section>
        ) : null}

        {/* PEAKOPS_OPEN_BY_ID_V2 (2026-04-30)
            Collapsed footer utility. The summary line reads "Open
            existing incident" so it doesn't shout "primary
            workflow"; the input + Open button only render when the
            user expands the disclosure. Most operators arrive via
            the dashboard rows; this is for paste-from-email cases. */}
        {orgIdMissing ? null : (
          <details
            style={{
              borderRadius: 8,
              border: "1px solid #1c1c1c",
              background: "transparent",
              padding: "8px 14px",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: "#6f6f6f",
                listStyle: "none",
                userSelect: "none",
              }}
            >
              Open existing job
            </summary>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                id="incident-id-input"
                value={incidentId}
                onChange={(e) => setIncidentId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    openIncidentById();
                  }
                }}
                placeholder="Paste an incident ID"
                spellCheck={false}
                autoComplete="off"
                aria-label="Incident ID"
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid #1c1c1c",
                  background: "#050505",
                  color: "#f5f5f5",
                  fontSize: 12,
                  outline: "none",
                  fontFamily: "ui-monospace, monospace",
                }}
              />
              <button
                type="button"
                onClick={openIncidentById}
                disabled={!canSubmit}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  border: "1px solid #1c1c1c",
                  background: "#101010",
                  color: canSubmit ? "#b3b3b3" : "#6f6f6f",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  cursor: canSubmit ? "pointer" : "not-allowed",
                }}
              >
                Open →
              </button>
            </div>
          </details>
        )}
      </div>

      {/* PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
          Modals — replace the old window.prompt + window.confirm
          with PeakOps-styled overlays. */}
      {saveModalOpen && (
        <SaveViewModal
          existingViews={savedViews}
          busy={pendingSaveBusy}
          onCancel={() => { if (!pendingSaveBusy) setSaveModalOpen(false); }}
          onSubmit={handleSaveViewSubmit}
        />
      )}
      {deletingView && (
        <DeleteViewModal
          name={deletingView.name}
          busy={pendingDeleteBusy}
          onCancel={() => { if (!pendingDeleteBusy) setDeletingView(null); }}
          onConfirm={handleDeleteViewConfirm}
        />
      )}
    </main>
  );
}

// ---- Saved Views modals ----------------------------------------------------

// PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
// Save view: name input with required + max-40 + duplicate
// validation. The duplicate check is run inline so the user sees
// the inline error before submit; the helper also throws
// SavedViewsDuplicateError as a backstop in case of race.
function SaveViewModal({
  existingViews, busy, onCancel, onSubmit,
}: {
  existingViews: SavedView[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const tooLong = trimmed.length > 40;
  const duplicate = (() => {
    if (!trimmed) return false;
    const t = trimmed.toLowerCase();
    return existingViews.some(
      (v) => String(v.name || "").trim().toLowerCase() === t,
    );
  })();
  const inlineError =
    !trimmed && name ? "View name is required."
      : tooLong ? "View name is too long. Max 40 characters."
      : duplicate ? "A view with this name already exists."
      : null;
  const canSubmit = !busy && !!trimmed && !tooLong && !duplicate;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        background: "#050505",
        border: "1px solid #1c1c1c",
        borderRadius: 8,
        padding: 20,
        width: "100%", maxWidth: 420,
      }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
          Save this view
        </h3>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#6f6f6f", letterSpacing: "0.04em" }}>View name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Active fiber jobs"
            maxLength={40}
            autoFocus
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                void onSubmit(trimmed);
              }
            }}
            style={{
              padding: "10px 12px",
              border: `1px solid ${inlineError ? "#a44" : "#1c1c1c"}`,
              borderRadius: 6,
              background: "#0b0b0b",
              color: "#f5f5f5",
              fontSize: 13,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          {inlineError && (
            <span style={{ fontSize: 11, color: "#e08383" }}>{inlineError}</span>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 12, fontWeight: 600,
              background: "transparent",
              color: "#b3b3b3",
              border: "1px solid #1c1c1c",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => { if (canSubmit) void onSubmit(trimmed); }}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 12, fontWeight: 700,
              color: canSubmit ? "#050505" : "#6f6f6f",
              background: canSubmit ? "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)" : "#1c1c1c",
              border: 0,
              cursor: canSubmit ? "pointer" : "not-allowed",
              boxShadow: canSubmit ? "0 2px 12px rgba(200,168,78,0.20)" : "none",
            }}
          >
            {busy ? "Saving…" : "Save view"}
          </button>
        </div>
      </div>
    </div>
  );
}

// PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
// Delete view: simple confirm modal. Body explains that this only
// removes the saved shortcut, never the underlying incidents.
function DeleteViewModal({
  name, busy, onCancel, onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
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
          Delete saved view?
        </h3>
        <p style={{ margin: "0 0 4px", fontSize: 13, color: "#b3b3b3" }}>
          {name ? <>“{name}” will be removed. </> : null}
          This removes the saved shortcut. It does not delete any incidents.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 12, fontWeight: 600,
              background: "transparent",
              color: "#b3b3b3",
              border: "1px solid #1c1c1c",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (!busy) void onConfirm(); }}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 12, fontWeight: 600,
              color: busy ? "#6f6f6f" : "#e08383",
              background: "transparent",
              border: `1px solid ${busy ? "#1c1c1c" : "rgba(224,131,131,0.35)"}`,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Deleting…" : "Delete view"}
          </button>
        </div>
      </div>
    </div>
  );
}
