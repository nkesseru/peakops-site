"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { outboxFlushSupervisorRequests } from "@/lib/offlineOutbox";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import AddEvidenceButton from "@/components/evidence/AddEvidenceButton";
import FilingCountdown from "@/components/incident/FilingCountdown";
import TimelinePanel from "@/components/incident/TimelinePanel";
import VendorPicker from "@/components/VendorPicker";
import { assignVendorToJob } from "@/lib/jobVendor";
import {
  clearRememberedFunctionsBase,
  getFunctionsBase,
  getFunctionsBaseDebugInfo,
  getEnvFunctionsBase,
  getFunctionsBaseFallback,
  isLikelyFetchNetworkError,
  probeAndRestoreEnvFunctionsBase,
  rememberFunctionsBase,
  warnFunctionsBaseIfSuspicious,
} from "@/lib/functionsBase";
import { ensureDemoActor, getActorRole, getActorUid, isDemoIncident } from "@/lib/demoActor";
import { getBestEvidenceImageRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";
import { deriveFieldIncidentStatus } from "@/lib/workflow/fieldIncidentStatus";
import { hasUsableOrgId, incidentPath, notesPath, reviewPath, summaryPath } from "@/lib/navigation/incidentRoutes";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import { deriveNextAction, type NextActionKey } from "@/lib/workflow/nextBestAction";
import { incidentStatusLabel, deriveDisplayStatus } from "@/lib/incidents/incidentStatus";
import { buildJobUiState } from "@/lib/incidents/resolveJobDisplayState";
import { displayIncidentTitle } from "@/lib/incidents/displayIncidentTitle";
import QaAuthDebugChip from "@/components/dev/QaAuthDebugChip";



// PEAKOPS_ACTIVE_JOB_CARD_V1
function pickActiveJobId(sp: any, incidentId: string, jobs: any[]): string {
  try {
    const fromQuery = String(sp?.get?.("jobId") || "").trim();
    if (fromQuery) return fromQuery;

    const key = `peakops_current_job_${String(incidentId || "").trim()}`;
    const fromLocal = String(window?.localStorage?.getItem?.(key) || "").trim();
    if (fromLocal) return fromLocal;

    const openish = (jobs || []).filter((j:any) => {
      const st = String(j?.status || "").toLowerCase();
      return st === "open" || st === "in_progress";
    });
    const sorted = (openish.length ? openish : (jobs || [])).slice().sort((a:any,b:any) => {
      const aSec = Number(a?.updatedAt?._seconds || a?.createdAt?._seconds || 0);
      const bSec = Number(b?.updatedAt?._seconds || b?.createdAt?._seconds || 0);
      return bSec - aSec;
    });
    return String(sorted?.[0]?.id || sorted?.[0]?.jobId || "").trim();
  } catch {
    return "";
  }
}
function rememberActiveJobId(incidentId: string, jobId: string) {
  try {
    const key = `peakops_current_job_${String(incidentId || "").trim()}`;
    if (jobId) window.localStorage.setItem(key, String(jobId));
  } catch {}
}
function isLockedJob(job: any): boolean {
  const st = String(job?.status || "").toLowerCase();
  return !!job?.locked || st === "approved";
}
function latestSupervisorRequest(timeline: any[]): any | null {
  const items = (timeline || []).filter((t:any) => String(t?.type || "").toUpperCase() === "SUPERVISOR_REQUEST_UPDATE");
  if (!items.length) return null;
  const sorted = items.slice().sort((a:any,b:any) => {
    const aSec = Number(a?.occurredAt?._seconds || 0);
    const bSec = Number(b?.occurredAt?._seconds || 0);
    return bSec - aSec;
  });
  return sorted[0] || null;
}


// PEAKOPS_LOCK_UI_V1
function isJobLocked(job: any): boolean {
  const st = String(job?.status || "").toLowerCase();
  return !!job?.locked || st === "approved";
}


// PEAKOPS_LABEL_PERSIST_V1
async function persistEvidenceLabel(orgId: string, incidentId: string, evidenceId: string, label: string) {
  try {
    await authedFetch("/api/fn/setEvidenceLabelV1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, incidentId, evidenceId, label, actorUid: "dev-admin" }),
      cache: "no-store",
    });
  } catch {}
}


// PEAKOPS_TILE_MEDIA_V3
function tileUrlFromEvidence(ev: any): string {
  const bucket = String(ev?.bucket || ev?.file?.bucket || "").trim();
  const storagePath = String(ev?.storagePath || ev?.file?.storagePath || "").trim();
  const fallbackUrl = String(ev?.url || "").trim();
  if (bucket && storagePath) return `/api/media?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(storagePath)}`;
  return fallbackUrl;
}


// PEAKOPS_PREVIEW_MEDIA_V1
// PEAKOPS_MEDIA_EMULATOR_GATE_V1 (2026-04-24)
// Authoritative signal for "it's safe to route images through the /api/media
// Storage-emulator proxy". Keyed off the ACTUAL Cloud Functions base the app
// talks to (NEXT_PUBLIC_FUNCTIONS_BASE) — NOT window.location.hostname, and
// NOT the URL shape coming back from the backend. If a stale deployed
// createEvidenceReadUrlV1 hands us an emulator-shaped URL while we're
// pointed at production Functions, we refuse to rewrite to /api/media (which
// itself tries to fetch 127.0.0.1:9199 server-side) and return empty so the
// <img> fails silently instead of firing a doomed localhost request.
function isEmulatorFunctionsBaseClient(): boolean {
  const base = String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim();
  if (!base) return false;
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function toInlineMediaUrl(u: string | undefined | null): string {
  const url = String(u || "").trim();
  if (!url) return url;

  // If it's already our proxy, use it.
  if (url.startsWith("/api/media?")) return url;

  // Detect emulator-shaped URLs (both /download/storage/v1/ and legacy /v0/).
  const m = url.match(/\/download\/storage\/v1\/b\/([^\/]+)\/o\/([^?]+)(\?.*)?$/);
  const m2 = m ? null : url.match(/\/v0\/b\/([^\/]+)\/o\/([^?]+)(\?.*)?$/);
  const emuMatch = m || m2;

  if (emuMatch) {
    if (!isEmulatorFunctionsBaseClient()) {
      // Prod Functions returning an emulator URL means the deployed function
      // is stale (createEvidenceReadUrlV1 not redeployed since the V2 fix).
      // Routing through /api/media would just proxy to 127.0.0.1:9199 from
      // Next's server-side runtime — also doomed. Drop the URL entirely; the
      // tile renders its "Loading…" / "Unavailable" fallback instead.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[toInlineMediaUrl] emulator-shaped URL in non-emulator context (redeploy createEvidenceReadUrlV1?):", url);
      }
      return "";
    }

    const bucket = decodeURIComponent(emuMatch[1] || "");
    const encPath = emuMatch[2] || "";
    let path = encPath;
    try { path = decodeURIComponent(encPath); } catch {}
    if (!bucket || !path) return "";
    return `/api/media?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
  }

  // Otherwise (prod signed URL, etc.), leave as-is.
  return url;
}


type EvidenceDoc = {
  id: string;
  phase?: string;
  labels?: string[];
  storedAt?: { _seconds: number };
  createdAt?: { _seconds: number };
  file?: {
    originalName?: string;
    storagePath?: string;
    contentType?: string;
    previewPath?: string;
    previewContentType?: string;
    thumbPath?: string;
    thumbContentType?: string;
    derivatives?: {
      preview?: { storagePath?: string; contentType?: string };
      thumb?: { storagePath?: string; contentType?: string };
    };
  };
  evidence?: {
    jobId?: string | null;
  };
  jobId?: string | null;
  sessionId?: string;
  notes?: string;
};

type TimelineDoc = {
  id: string;
  type: string;
  actor?: string;
  refId?: string | null;
  sessionId?: string;
  occurredAt?: { _seconds: number };
  meta?: any;
  gps?: any;
};

type JobStatus = "open" | "in_progress" | "complete" | "review" | "approved" | "rejected";
type JobDoc = {
  id: string;
  jobId?: string;
  orgId?: string;
  incidentId?: string;
  assignedOrgId?: string | null;
  title?: string;
  status?: JobStatus | "assigned" | string;
  createdBy?: { uid?: string; email?: string };
  assignedTo?: string | null;
  notes?: string | null;
  createdAt?: { _seconds: number };
  updatedAt?: { _seconds: number };
};

const JOB_STATUSES: JobStatus[] = ["open", "in_progress", "complete", "review", "approved", "rejected"];

type OrgOption = { id: string; orgId?: string; name?: string };

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const now = Date.now() / 1000;
  const d = Math.max(0, Math.floor(now - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function prettyType(t: string) {
  const m: Record<string, string> = {
    NOTES_SAVED: "Notes saved",
    EVIDENCE_ADDED: "Photos saved",
    FIELD_ARRIVED: "Arrived on site",
    FIELD_APPROVED: "Supervisor approved",
    MATERIAL_ADDED: "Material logged",
    INCIDENT_OPENED: "Job opened",
    SESSION_STARTED: "Session started",
    DEBUG_EVENT: "Debug event",
  };
  return m[t] || t.replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, (x) => x.toUpperCase());
}

function iconFor(t: string) {
  const m: Record<string, string> = {
    NOTES_SAVED: "Notes saved",
    EVIDENCE_ADDED: "📸",
    FIELD_ARRIVED: "✅",
    FIELD_APPROVED: "🛡️",
    MATERIAL_ADDED: "🧱",
    INCIDENT_OPENED: "⚡",
    SESSION_STARTED: "🧑‍🔧",
    DEBUG_EVENT: "🧪",
  };
  return m[t] || "•";
}

function normLabel(l: string) {
  return String(l || "").trim().toUpperCase();
}

function tileClassByCount(n: number) {
  // Auto size tiles by count (mobile-first)
  // 1 = hero tile, 2 = large tiles, 3-4 = normal, 5+ = compact
  if (n <= 1) return "w-[300px] sm:w-[360px]";
  if (n == 2) return "w-[220px] sm:w-[260px]";
  if (n <= 4) return "w-[160px] sm:w-[180px]";
  return "w-[130px] sm:w-[150px]";
}

function labelChipColor(label: string) {
  const L = normLabel(label);
  // Cohesive system chips: dark base + subtle tint + quiet borders
  if (L === "DAMAGE") return "bg-red-500/12 border-red-400/20 text-red-200";
  if (L === "SAFETY") return "bg-amber-400/12 border-indigo-400/20 text-indigo-200";
  if (L === "DOCS") return "bg-sky-400/12 border-sky-300/25 text-sky-200";
  return "bg-white/6 border-white/12 text-gray-200";
}

function chipClass(kind: "actor" | "session" | "meta" = "meta") {
  if (kind === "actor") return "px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-200";
  if (kind === "session") return "px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-gray-300";
  return "px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-300";
}

function jobStatusPill(status: string) {
  const s = String(status || "").toLowerCase();
  if (s === "approved") return "bg-emerald-500/15 border-emerald-300/30 text-emerald-100";
  if (s === "rejected") return "bg-red-500/15 border-red-300/30 text-red-100";
  if (s === "in_progress") return "bg-blue-500/15 border-blue-300/30 text-blue-100";
  if (s === "review") return "bg-indigo-500/15 border-indigo-400/20 text-indigo-100";
  if (s === "complete") return "bg-indigo-500/15 border-indigo-300/30 text-indigo-100";
  return "bg-white/8 border-white/15 text-gray-200";
}

function jobStatusText(status: any) {
  const s = String(status || "").trim();
  return s || "unknown";
}

function normalizeJobStatus(status: any) {
  const base = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (base === "inprogress" || base === "in-progress" || base === "in_progress") return "in_progress";
  if (base === "open") return "open";
  return base;
}

function isFieldSelectableJob(status: any) {
  const s = normalizeJobStatus(status);
  return s === "open" || s === "in_progress" || s === "assigned";
}

function normalizeIncidentStatus(status: any) {
  const raw = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (raw === "in-progress" || raw === "inprogress" || raw === "submitted") return "in_progress";
  if (raw === "closed") return "closed";
  return "open";
}

function getLinkedJobId(ev: any) {
  return String(ev?.jobId || ev?.evidence?.jobId || "").trim();
}

function isHeicEvidence(ev: EvidenceDoc) {
  const f: any = ev?.file || {};
  const ct = String(f?.contentType || "").toLowerCase();
  const name = String(f?.originalName || "");
  const sp = String(f?.storagePath || "");
  return (
    ct.includes("heic") ||
    ct.includes("heif") ||
    /\.(heic|heif)$/i.test(name) ||
    /\.(heic|heif)$/i.test(sp)
  );
}

function pickEvidencePaths(ev: EvidenceDoc) {
  const f: any = ev?.file || {};
  const originalPath = String(f?.storagePath || "");
  const previewPath =
    String(f?.previewPath || f?.derivatives?.preview?.storagePath || "").trim();
  const thumbPath =
    String(f?.thumbPath || f?.derivatives?.thumb?.storagePath || "").trim();
  const heic = isHeicEvidence(ev);
  if (heic) {
    return {
      thumbPath: thumbPath || previewPath || "",
      previewPath: previewPath || thumbPath || "",
    };
  }
  return {
    thumbPath: thumbPath || previewPath || originalPath,
    previewPath: previewPath || thumbPath || originalPath,
  };
}

function isConvertingHeic(ev: EvidenceDoc) {
  if (!isHeicEvidence(ev)) return false;
  const f: any = ev?.file || {};
  const status = String(f?.conversionStatus || "").toLowerCase();
  if (status === "done" || status === "ready" || status === "source_missing" || status === "failed") return false;
  const hasPreview = !!String(f?.previewPath || "").trim();
  const hasThumb = !!String(f?.thumbPath || "").trim();
  if (hasThumb || hasPreview) return false;
  return status === "pending" || status === "processing";
}

async function postJson<T>(url: string, body: any): Promise<T> {
  // PEAKOPS_PHASE3_AUTHED_FETCH_V1 (2026-04-27)
  // postJson is only called with /api/fn/* URLs in this file; routing
  // through authedFetch attaches the Firebase ID token so Phase 3
  // enforcement accepts the call.
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return JSON.parse(txt) as T;
}

function FlowStageBar({ stage }: { stage: "arrive" | "evidence" | "notes" | "submit" | "review" | "done" }) {
  // PEAKOPS_FLOWBAR_V2 (2026-04-30)
  // Collapsed to the 5 operator-facing steps: Arrive → Capture → Notes
  // → Send → Closed. The legacy "Review" stage is no longer rendered
  // as its own step (it's a supervisor-side state, not a field
  // action) — when stage === "review" we treat Send as complete and
  // the only remaining step is Closed.
  const steps = [
    { key: "arrive", label: "Arrive" },
    { key: "evidence", label: "Capture" },
    { key: "notes", label: "Notes" },
    { key: "submit", label: "Send to Supervisor" },
    { key: "done", label: "Closed" },
  ] as const;
  const normalizedStage: typeof steps[number]["key"] =
    stage === "review" ? "submit" : (stage as typeof steps[number]["key"]);
  const stageIdx = steps.findIndex((x) => x.key === normalizedStage);
  // Boost the effective index by 1 when the actual stage was "review",
  // so "submit" reads as done rather than active.
  const effectiveIdx = stage === "review" ? stageIdx + 1 : stageIdx;
  // PEAKOPS_FLOWBAR_DONE_FILL_V1 (2026-05-05)
  // When the job is fully Closed, every step (including the
  // terminal "Closed" step itself) reads as done — not as the
  // current active step. Buyers expect a Closed job's stepper to
  // show all-green, not the last node lit gold.
  const isFullyDone = stage === "done";
  // PEAKOPS_FLOWBAR_REVIEW_NO_ACTIVE_V1 (2026-05-05)
  // When the job is Awaiting Supervisor Review or Approved, the
  // field crew has nothing to do — the supervisor is the bottleneck.
  // Render 4 done + Closed pending-gray (no gold-active highlight).
  // Lighting Closed gold while the header pill says "Approved" was
  // the buyer-visible contradiction QA flagged.
  const isAwaitingClose = stage === "review";

  return (
    <div style={{ padding: "7px 16px", background: "#050505", borderBottom: "1px solid #1c1c1c", display: "flex", alignItems: "center", gap: 4, overflowX: "auto" }}>
        {steps.map((s, i) => {
          const active = !isFullyDone && !isAwaitingClose && effectiveIdx === i;
          const done = isFullyDone || effectiveIdx > i;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "5px 12px", borderRadius: 6, whiteSpace: "nowrap",
                fontSize: 11, fontWeight: active ? 700 : 600,
                color: active ? "#C8A84E" : done ? "#22c55e" : "#b3b3b3",
                background: active ? "transparent" : done ? "transparent" : "#101010",
                borderTop: active ? "1px solid #C8A84E" : done ? "1px solid rgba(34,197,94,0.2)" : "1px solid #1c1c1c",
                borderRight: active ? "1px solid #C8A84E" : done ? "1px solid rgba(34,197,94,0.2)" : "1px solid #1c1c1c",
                borderBottom: active ? "1px solid #C8A84E" : done ? "1px solid rgba(34,197,94,0.2)" : "1px solid #1c1c1c",
                borderLeft: active ? "1px solid #C8A84E" : done ? "2px solid #22c55e" : "1px solid #1c1c1c",
              }}>
                {done && <svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                {s.label}
              </div>
              {i < steps.length - 1 && (
                <div style={{ width: 8, height: 1, background: done ? "rgba(34,197,94,0.3)" : "#1c1c1c" }} />
              )}
            </div>
          );
        })}
    </div>
  );
}

export default function IncidentClient({ incidentId }: { incidentId: string }) {
  const DEMO_RESET_CMD = "scripts/dev/reset_demo_incident.sh && scripts/dev/seed_demo_incident.sh";
  const functionsBase = getFunctionsBase();
useEffect(() => {
    warnFunctionsBaseIfSuspicious(functionsBase);
  }, [functionsBase]);
  
const invalidIncidentRoute = useMemo(() => {
    const raw = String(incidentId || "").trim();
    if (!raw) return true;
    const s = raw.toLowerCase();
    return (
      s === "<incidentid>" || s === "%3cincidentid%3e" || s.includes("<incidentid>") ||
      s === "[incidentid]" || s === "{incidentid}" || s === "incidentid" ||
      s === ":incidentid" || s === "undefined" || s === "null"
    );
  }, [incidentId]);

  useEffect(() => {
    try {
      localStorage.setItem("peakops_last_incident_id", String(incidentId || "").trim());
    } catch {}
  }, [incidentId]);

  useEffect(() => {
    ensureDemoActor(incidentId);
  }, [incidentId]);

  // PEAKOPS_NOTES_SAVED_FOCUS: re-check when user returns from Notes page
  useEffect(() => {
    try { outboxFlushSupervisorRequests(); } catch {}

    const onFocus = () => { syncNotesSavedLocal(); syncArrivedLocal(); syncNotesBypassedLocal(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [incidentId]);

  // PEAKOPS_INCIDENT_IDENTITY_BAR_V1 (2026-04-27)
  // Firebase Auth user + custom claims (role / orgIds). Drives the small
  // identity strip at the top of the page so the operator can see who
  // they're signed in as and which org context they're acting in.
  const { user: authUser, claims: authClaims } = useAuth();

  const [arrived, setArrived] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closingIncident, setClosingIncident] = useState(false);
  const [incidentStatus, setIncidentStatus] = useState<string>("open");
  const [incidentTitle, setIncidentTitle] = useState<string>("");
  const [incidentUpdatedAtSec, setIncidentUpdatedAtSec] = useState<number | null>(null);
  // PEAKOPS_NEXT_BEST_ACTION_V1 (2026-04-27)
  // packetReady drives the "Generate Report" vs "Download Report" branch
  // of the Next Best Action card. Populated from getIncidentV1's
  // packetMeta during the existing refresh path.
  const [packetReady, setPacketReady] = useState<boolean>(false);
  const [nowTick, setNowTick] = useState(Date.now());
  // PEAKOPS_INCIDENT_TAB_RENAME_V1 (2026-04-29)
  // Tab id "jobs" renamed to "tasks" so the URL fragment reads
  // /incidents/<id>#tasks (not #jobs). Legacy bookmarks pointing at
  // #jobs still resolve here — applyHashTab() treats "jobs" as an
  // alias for "tasks" without writing the legacy form back.
  const [activeTab, setActiveTab] = useState<"overview" | "timeline" | "evidence" | "tasks">("overview");
  const [pendingJumpToEvidenceMapping, setPendingJumpToEvidenceMapping] = useState(false);
  const setTab = (tab: "overview" | "timeline" | "evidence" | "tasks") => {
    if (previewOpen) setPreviewOpen(false);
    setActiveTab(tab);
    try {
      const nextHash = `#${tab}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
        if (window.location.hash !== nextHash) {
          window.location.hash = tab;
        }
      }
    } catch {}
  };

  useEffect(() => {
    const applyHashTab = () => {
      try {
        const raw = String(window.location.hash || "").replace(/^#/, "").trim().toLowerCase();
        // Backward-compat: "jobs" → "tasks" (legacy bookmarks).
        const normalized = raw === "jobs" ? "tasks" : raw;
        if (
          normalized === "overview" ||
          normalized === "timeline" ||
          normalized === "evidence" ||
          normalized === "tasks"
        ) {
          setActiveTab(normalized as "overview" | "timeline" | "evidence" | "tasks");
        }
      } catch {}
    };
    applyHashTab();
    window.addEventListener("hashchange", applyHashTab);
    return () => window.removeEventListener("hashchange", applyHashTab);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  function jumpToEvidenceMapping() {
    try {
      setPendingJumpToEvidenceMapping(true);
      setTab("evidence");
      try { window.location.hash = "evidence-mapping"; } catch {}
    } catch {}
  }

  useEffect(() => {
    if (!pendingJumpToEvidenceMapping || activeTab !== "evidence") return;

    const t = window.setTimeout(() => {
      try {
        const el =
          evidenceMappingSectionRef.current ||
          document.getElementById("evidence-mapping");

        if (el && typeof (el).scrollIntoView === "function") {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }

        try { window.location.hash = "evidence-mapping"; } catch {}
      } catch {}
      setPendingJumpToEvidenceMapping(false);
    }, 80);

    return () => window.clearTimeout(t);
  }, [pendingJumpToEvidenceMapping, activeTab]);


// PHASE7_2_REQUPDATE_SYNC_V1

  const [arriving, setArriving] = useState(false);
  // PEAKOPS_ARRIVE_REENTRY_GUARD_V1 (2026-05-01)
  // The button's `disabled` prop checks `arriving`, but state updates
  // are async — a fast double-click can fire onClick twice before the
  // second render disables the button. arrivingRef is checked
  // synchronously at the top of markArrived to no-op the duplicate
  // call.
  const arrivingRef = useRef(false);
  // PEAKOPS_SUBMIT_GUARDRAILS_V1 (2026-05-04)
  // Same synchronous double-click pattern as arrivingRef. The button's
  // `submitting` state lags by a render; the ref doesn't.
  const submittingRef = useRef(false);
  // toast (tiny UX feedback)
const [toastMsg, setToastMsg] = useState<string | null>(null);
const [convertingHeic, setConvertingHeic] = useState(false);
const [debuggingHeic, setDebuggingHeic] = useState(false);
  const toast = (msg: string, ms = 2200) => {
    setToastMsg(msg);
    // @ts-ignore
    window.clearTimeout((toast as any)._t);
    // @ts-ignore
    (toast as any)._t = window.setTimeout(() => setToastMsg(null), ms);
  };

  // PHASE7_EVIDENCE_LAUNCH_V1
  const [addingEvidence, setAddingEvidence] = useState(false);

  const goAddEvidence = () => {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    // PEAKOPS_CAPTURE_WITHOUT_JOB_V1
    // Evidence capture no longer requires an active field job.
    // Backend (addEvidenceV1) treats jobId as optional: when omitted, the doc
    // saves at the incident level and can be assigned to a job later.
    // PEAKOPS_NAV_ORGID_GUARD: never navigate to /add-evidence with an empty
    // orgId — that produces "?orgId=" which breaks downstream refresh.
    if (!hasUsableOrgId(orgId)) {
      return toast("Missing orgId in URL — reload /incidents/<id>?orgId=<your-org>", 3500);
    }
    try {
      const url =
        `/incidents/${encodeURIComponent(String(incidentId || ""))}/add-evidence` +
        `?orgId=${encodeURIComponent(String(orgId || ""))}`;
      console.log("[AddEvidence] navigating:", url);
      if (process.env.NODE_ENV !== "production") {
        console.debug("[AddEvidence] nav_state", {
          incidentId: String(incidentId || ""),
          orgId: String(orgId || ""),
          isClosed,
          hasActiveFieldJobs,
          currentJobId: String(currentJobId || ""),
        });
      }
      router.push(url);
    } catch (e) {
      toast("Add evidence navigation failed.", 2800);
      console.error("[AddEvidence] navigation failed", e);
    }
  };


  // V6_SESSION_HELPERS__WIRE
async function markArrived() {
    // PEAKOPS_ARRIVE_REENTRY_GUARD_V1 (2026-05-01)
    // Synchronous re-entry check. If a click already triggered
    // markArrived and the call is still in flight, a fast second click
    // is a no-op — `setArriving(true)` is async, so the button's
    // `disabled` prop wouldn't reflect "in flight" yet on a fast
    // double-click without this ref. The ref is released in the
    // finally block below.
    if (arrivingRef.current) return;
    // PEAKOPS_ARRIVE_RETRY_SESSION_V1
    // If sessionId is missing or stale, create a new field session and retry once.
    const techUserId = process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web";
    const base = functionsBase;
    // PEAKOPS_ARRIVE_ORGID_REFRESH_V1
    // Derive orgId at click time: prefer the closure (useSearchParams), then
    // re-read window.location.search as a live fallback. No hardcoded default —
    // if URL genuinely has no orgId we bail with a clear toast instead of firing
    // a POST that the backend would reject with "orgId required".
    let org = String(orgId || "").trim();
    if (!org && typeof window !== "undefined") {
      try {
        const usp = new URLSearchParams(window.location.search);
        org = String(usp.get("orgId") || "").trim();
      } catch {}
    }

    if (!base) return toast("Missing NEXT_PUBLIC_FUNCTIONS_BASE", 3000);
    if (!org) return toast("Missing orgId in URL — reload /incidents/<id>?orgId=<your-org>", 3500);
    if (String(incidentStatus).toLowerCase() === "closed") return toast("Job is closed (read-only).", 2600);

    let sid = String(activeSessionId || "").trim();
    if (!sid) {
      // try last known session from storage (if any)
      try { sid = String(localStorage.getItem("peakops_active_session_" + String(incidentId || "")) || "").trim(); } catch {}
    }

    async function startSession(): Promise<string> {
      // orgId in both query string (parity with getTimelineEventsV1) and body
      // (markArrivedV1 / startFieldSessionV1 read from body via mustStr).
      const url = `/api/fn/startFieldSessionV1?orgId=${encodeURIComponent(org)}`;
      const res = await authedFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: org, incidentId, createdBy: "ui", techUserId }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok || !out?.sessionId) {
        throw new Error(out?.error || `startFieldSessionV1 failed (${res.status})`);
      }
      return String(out.sessionId);
    }

    async function postArrived(sessionId: string): Promise<any> {
      const url = `/api/fn/markArrivedV1?orgId=${encodeURIComponent(org)}`;
      const res = await authedFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: org, incidentId, sessionId: String(sessionId), updatedBy: "ui", techUserId }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) {
        const msg = out?.error || `markArrivedV1 failed (${res.status})`;
        const err = new Error(msg);
        (err as any).__status = res.status;
        throw err;
      }
      return out;
    }

    let __optId = "";
    try {
      // PEAKOPS_ARRIVE_REENTRY_GUARD_V1 (2026-05-01)
      // Acquire the in-flight lock here (after the early returns) so
      // a no-op early exit doesn't leave the ref stuck. The finally
      // block clears it.
      arrivingRef.current = true;
      setArriving(true);

      // Optimistic UI event id (stable across try/catch)
      __optId = "opt_arrived_" + Date.now();
      try {
        const __sid = sid || "";
        if (__sid) {
          setTimeline((prev: any) => ([
            {
              id: __optId,
              type: "FIELD_ARRIVED",
              actor: "ui",
              sessionId: __sid,
              occurredAt: { _seconds: Math.floor(Date.now() / 1000) },
              refId: null,
              meta: { optimistic: true }
            },
            ...(Array.isArray(prev) ? prev : [])
          ]));
        }
      } catch {}

      // If no session yet, create one
      if (!sid) {
        sid = await startSession();
        try { localStorage.setItem("peakops_active_session_" + String(incidentId || ""), sid); } catch {}
        try { setActiveSessionId(sid); } catch {}
      }

      // First attempt
      try {
        await postArrived(sid);
      } catch (e: any) {
        const msg = String(e?.message || e || "");
        // If stale session, recreate once and retry
        if ((e as any)?.__status == 404 || msg.toLowerCase().includes("session not found")) {
          sid = await startSession();
          try { localStorage.setItem("peakops_active_session_" + String(incidentId || ""), sid); } catch {}
          try { setActiveSessionId(sid); } catch {}
          await postArrived(sid);
        } else {
          throw e;
        }
      }

      // Ensure the UI reflects arrival even on a fresh session where no optimistic
      // FIELD_ARRIVED event was inserted before startSession().
      try {
        const confirmedId = __optId || ("arrived_" + Date.now());
        setTimeline((prev: any) => {
          const list = Array.isArray(prev) ? prev : [];
          const alreadyHasArrival = list.some((x: any) =>
            String(x?.type || "") === "FIELD_ARRIVED" &&
            String(x?.sessionId || "") === String(sid || "")
          );
          if (alreadyHasArrival) {
            return list.map((x: any) =>
              x?.id === __optId
                ? {
                    ...x,
                    id: confirmedId,
                    meta: { ...(x?.meta || {}), optimistic: false }
                  }
                : x
            );
          }
          return [
            {
              id: confirmedId,
              type: "FIELD_ARRIVED",
              actor: "ui",
              sessionId: String(sid || ""),
              occurredAt: { _seconds: Math.floor(Date.now() / 1000) },
              refId: null,
              meta: { optimistic: false }
            },
            ...list.filter((x: any) => x?.id !== __optId)
          ];
        });
      } catch {}

      setArrived(true);
      // PEAKOPS_ARRIVED_STICKY_V1: persist so remounts (notes save, tab nav,
      // reload) don't regress the readiness/CTA state when the backend timeline
      // fetch returns empty.
      try { localStorage.setItem("peakops_arrived_" + String(incidentId || ""), "1"); } catch {}
      setArrivedLocal(true);
      toast("Arrived ✓", 1800);
    } catch (e: any) {
      const msg = e?.message || String(e) || "markArrived failed";
      toast("Arrival failed: " + msg, 3500);
      // OPTIMISTIC_FIELD_ARRIVED revert
      try { setTimeline((prev: any) => (Array.isArray(prev) ? prev.filter((x:any) => x?.id !== __optId) : prev)); } catch {}
      console.error(e);
    } finally {
      setArriving(false);
      // PEAKOPS_ARRIVE_REENTRY_GUARD_V1 (2026-05-01)
      arrivingRef.current = false;
    }
}

  function isSessionMissingError(e: any) {
    const msg = String(e?.message || e || "").toLowerCase();
    return (e as any)?.__status === 404 || msg.includes("session not found");
  }

  function getSubmitSessionCandidates(): string[] {
    const out: string[] = [];
    const push = (v: any) => {
      const s = String(v || "").trim();
      if (s && !out.includes(s)) out.push(s);
    };

    try { push(typeof getActiveSessionId === "function" ? getActiveSessionId() : ""); } catch {}
    try { push(localStorage.getItem("peakops_active_session_" + String(incidentId || ""))); } catch {}

    for (const ev of (Array.isArray(evidence) ? evidence : [])) {
      push((ev as any)?.sessionId);
      push((ev as any)?.evidence?.sessionId);
    }

    for (const ev of (Array.isArray(timeline) ? timeline : [])) {
      push((ev as any)?.sessionId);
    }

    push(activeSessionId);
    return out;
  }

  async function postSubmitFieldSession(sessionId: string) {
    return await postJson("/api/fn/submitFieldSessionV1", {
      orgId: orgId,
      incidentId,
      sessionId: String(sessionId || "").trim(),
      updatedBy: "ui",
    });
  }

  async function submitSession() {
    // PEAKOPS_SUBMIT_GUARDRAILS_V1 (2026-05-04)
    // Synchronous re-entry guard — fast double-click on Submit can't
    // fire two POSTs because submittingRef is checked before any state
    // update. The visible `submitting` state lags by a render; the ref
    // doesn't.
    if (submittingRef.current) return;

    if (String(incidentStatus).toLowerCase() === "closed") return toast("Job is closed (read-only).", 2600);

    // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
    // Backstop the new notes gate at the API edge so a stale UI or
    // an alternate code path cannot submit without an explicit notes
    // decision. The NBA + bottom dock both block the click; this is
    // belt-and-braces for any programmatic caller.
    if (!_hasNotes && !notesBypassedLocal) {
      toast("Add a note or tap 'No note needed' before submitting.", 3000);
      return;
    }

    // PEAKOPS_SUBMIT_GUARDRAILS_V1 (2026-05-04)
    // Hard data-integrity gates. Run BEFORE the session-id lookup so
    // a user with a fresh session can't bypass these by submitting
    // before their tasks/photos exist. Each gate maps 1:1 to a copy
    // string the user sees — never a raw backend error.
    const safeJobs = Array.isArray(jobs) ? jobs : [];
    const safeEvidence = Array.isArray(evidence) ? evidence : [];

    if (safeJobs.length === 0) {
      toast("Create at least one task before submitting.", 3500);
      return;
    }

    const isJobComplete = (j: any) => {
      const s = normalizeJobStatus(j?.status);
      return s === "complete" || s === "review" || s === "approved";
    };
    const incompleteJobs = safeJobs.filter((j: any) => !isJobComplete(j));
    if (incompleteJobs.length > 0) {
      toast("You must complete all tasks before submitting.", 3500);
      return;
    }

    // Per-task evidence count. Photo is "linked" if either top-level
    // jobId or nested evidence.jobId is set — same rule the NBA uses.
    const photoCountByJobId: Record<string, number> = {};
    for (const ev of safeEvidence) {
      const top = String((ev as any)?.jobId || "").trim();
      const nested = String((ev as any)?.evidence?.jobId || "").trim();
      const linked = top || nested;
      if (linked) photoCountByJobId[linked] = (photoCountByJobId[linked] || 0) + 1;
    }
    const tasksWithoutPhotos = safeJobs.filter((j: any) => {
      const id = String(j?.id || j?.jobId || "").trim();
      return !id || (photoCountByJobId[id] || 0) === 0;
    });
    if (tasksWithoutPhotos.length > 0) {
      toast("Each task must have at least one photo attached.", 3500);
      return;
    }

    // Unassigned photos — soft block (warn + confirm bypass). The
    // photos still ship in the export, just not under any task in
    // the audit doc; making the user explicitly opt in stops the
    // accidental "I forgot to attach" case while preserving the
    // legitimate "these are extras" case.
    const unassignedCount = safeEvidence.length - Object.values(photoCountByJobId).reduce((s, n) => s + n, 0);
    if (unassignedCount > 0) {
      const word = unassignedCount === 1 ? "photo" : "photos";
      const ok = (typeof window !== "undefined")
        ? window.confirm(
            `You have ${unassignedCount} unassigned ${word}. Submit anyway — these ${word} won't be tied to a task.`,
          )
        : true;
      if (!ok) return;
    }

    let sid = getSubmitSessionCandidates()[0] || "";
    if (!sid) return toast("No active session yet — add evidence first.", 3000);

    try {
      submittingRef.current = true;
      setSubmitting(true);

      console.warn("[submitSession] initial candidates", {
        activeSessionId,
        chosen: sid,
        candidates: getSubmitSessionCandidates(),
      });

      try {
        const out: any = await postSubmitFieldSession(sid);
        if (!out?.ok) throw new Error(out?.error || "submit failed");
      } catch (e: any) {
        if (!isSessionMissingError(e)) throw e;

        await refresh().catch(() => {});

        const candidatesAfterRefresh = getSubmitSessionCandidates();
        const retrySid = candidatesAfterRefresh.find((x) => String(x || "").trim() && String(x) !== String(sid)) || "";

        console.warn("[submitSession] retry after stale session", {
          staleSessionId: sid,
          candidatesAfterRefresh,
          retrySid,
        });

        if (!retrySid) throw e;

        sid = retrySid;
        try { localStorage.setItem("peakops_active_session_" + String(incidentId || ""), sid); } catch {}
        try { setActiveSessionId(sid); } catch {}

        const out: any = await postSubmitFieldSession(sid);
        if (!out?.ok) throw new Error(out?.error || "submit failed");
      }

      toast("Session submitted ✓", 2200);
      await refresh();
    } catch (e: any) {
      // PEAKOPS_SUBMIT_GUARDRAILS_V1 (2026-05-04)
      // Customer-safe message. Raw e.message can include backend
      // identifiers / stack info; it goes to the dev console only.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[submitSession] failure", String(e?.message || e));
      }
      toast("Submit failed. Please refresh and try again.", 3500);
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  const router = useRouter();
  // orgId is the single source of truth for this page: URL query param only.
  // No hardcoded default, no localStorage cache, no doc-based override.
  const orgSp = useSearchParams();
  const orgId = String(orgSp?.get?.("orgId") || "").trim();
  // Evidence + Timeline
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  
  

  
  // PEAKOPS_ACTIVE_JOB_CARD_EFFECT_V1
  useEffect(() => {
    try {
      const id = pickActiveJobId((typeof sp !== "undefined" ? sp : null), String(incidentId||""), jobs as any[]);
      if (id && id !== activeJobId) setActiveJobId(id);
      if (id) rememberActiveJobId(String(incidentId||""), id);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, incidentId]);


const [activeJobId, setActiveJobId] = useState<string>("");
const [heicRowDebugById, setHeicRowDebugById] = useState<Record<string, string>>({});
  const [heicRowBusyById, setHeicRowBusyById] = useState<Record<string, boolean>>({});
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([]);

  // PEAKOPS_ORG_OPTIONS_FALLBACK_V1
  const orgOptionsWithFallback: any[] = (() => {
    const list = Array.isArray(orgOptions) ? orgOptions : [];
    if (list.length) return list;
    const fallback = String(orgId || "").trim();
    if (!fallback) return [];
    return [{ id: fallback, orgId: fallback, name: fallback }];
  })();


  const [orgOptionsLoadError, setOrgOptionsLoadError] = useState(false);
  const [orgOptionsLoaded, setOrgOptionsLoaded] = useState(false);
  const [orgDebugJson, setOrgDebugJson] = useState<string>("");
  const [orgDebugBusy, setOrgDebugBusy] = useState(false);
  const [orgSeedBusy, setOrgSeedBusy] = useState(false);
  const [orgDebugEmulatorDetected, setOrgDebugEmulatorDetected] = useState(false);
  const [jobsBusy, setJobsBusy] = useState(false);
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const [jobAssignedTo, setJobAssignedTo] = useState("");
  const [jobNotes, setJobNotes] = useState("");
  const [currentJobId, setCurrentJobId] = useState("");

  // PEAKOPS_ACTIVE_JOB_PERSIST_EFFECT_V1
  useEffect(() => {
    try {
      const jid = String((currentJobId as any) || "").trim();
      if (!jid) return;
      try { rememberActiveJobId(String(incidentId||""), jid); } catch {}
      // If an explicit activeJobId state exists, keep it in sync.
      try { (typeof setActiveJobId !== "undefined") && (setActiveJobId as any)(jid); } catch {}
    } catch {}
  }, [currentJobId, incidentId]);


  const currentJobStorageKey = `peakops_current_job_${String(incidentId || "").trim()}`;
  const myJobSectionRef = useRef<HTMLElement | null>(null);
  const evidenceMappingSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      const saved = String(localStorage.getItem(currentJobStorageKey) || "").trim();
      if (saved) setCurrentJobId(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  useEffect(() => {
    try {
      if (currentJobId) localStorage.setItem(currentJobStorageKey, String(currentJobId));
      else localStorage.removeItem(currentJobStorageKey);
    } catch {}
  }, [currentJobId, currentJobStorageKey]);

  function openFieldJob(jobIdRaw?: string, opts?: { mapping?: boolean }) {
    const jid = String(jobIdRaw || "").trim();
    if (!jid) return;
    setCurrentJobId(jid);
    try {
      const target = opts?.mapping ? evidenceMappingSectionRef.current : myJobSectionRef.current;
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {}
  }

  
    
  // PEAKOPS_V2_EVIDENCE_CAPTIONS: local-only evidence naming (v2). Persist later in Firestore.
  // PEAKOPS_V2_CAPTION_WRAPPERS_V1
  // Some parts of the UI call getCaption/setCaption; keep these stable wrappers.
  const getCaption = (eid: string) => {
    try {
      const id = String(eid || "").trim();
      if (!id) return "";
      // Prefer in-memory map if present
      try {
        // @ts-ignore
        if (typeof evCaption === "object" && evCaption && (id in evCaption)) return String(evCaption[id] || "");
      } catch {}
      // Fall back to localStorage loader if present
      try {
        // @ts-ignore
        if (typeof loadCaption === "function") return String(loadCaption(id) || "");
      } catch {}
      return "";
    } catch {
      return "";
    }
  };

  const setCaption = (eid: string, v: string) => {
    try {
      const id = String(eid || "").trim();
      if (!id) return;
      const val = String(v || "");
      // Prefer your existing persistence helper if present
      try {
        // @ts-ignore
        if (typeof saveCaption === "function") { saveCaption(id, val); return; }
      } catch {}
      // Fall back to updating state map if present
      try {
        // @ts-ignore
        if (typeof setEvCaption === "function") {
          setEvCaption((m: any) => ({ ...(m || {}), [id]: val }));
        }
      } catch {}
    } catch {}
  };
  const [evCaption, setEvCaption] = useState<Record<string, string>>({});
  const loadCaption = (eid: string) => {
    try { return localStorage.getItem("peakops_ev_caption_" + String(eid)) || ""; } catch { return ""; }
  };
  const saveCaption = (eid: string, v: string) => {
    try { localStorage.setItem("peakops_ev_caption_" + String(eid), String(v || "")); } catch {}
    setEvCaption((m) => ({ ...m, [String(eid)]: String(v || "") }));
  };
// PEAKOPS_NOTES_SAVED_SYNC: allow Notes page to flip readiness instantly via localStorage
  const [notesSavedLocal, setNotesSavedLocal] = useState<boolean>(false);

  const syncNotesSavedLocal = () => {
    try {
      const k = "peakops_notes_saved_" + String(incidentId);
      const v = localStorage.getItem(k);
      setNotesSavedLocal(!!v);
    } catch {
      // ignore
    }
  };

  // PEAKOPS_ARRIVED_STICKY_V1: fallback-only sticky local flag for arrival.
  // Backend is the primary source of truth — emitTimelineEvent and
  // getTimelineEventsV1 now share functions_clean/_incidentPath.js, so the
  // write/read subcollections always agree and the timeline round-trips
  // FIELD_ARRIVED correctly on refresh. This sticky flag remains as a safety
  // net for eventual-consistency windows and offline-first behavior only. Do
  // not rely on it as the primary signal; read `hasArrival` instead.
  const [arrivedLocal, setArrivedLocal] = useState<boolean>(false);

  // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
  // Sticky local flag for the notes-bypass acknowledgment. The
  // authoritative copy is persisted server-side via saveIncidentNotesV1
  // ({ notesStatus: "bypassed", notesBypassReason: "..." }). The local
  // flag flips immediately on click so the NBA advances without
  // waiting for a refresh round-trip.
  const [notesBypassedLocal, setNotesBypassedLocal] = useState<boolean>(false);
  const [bypassNotesBusy, setBypassNotesBusy] = useState<boolean>(false);

  const syncArrivedLocal = () => {
    try {
      const k = "peakops_arrived_" + String(incidentId);
      const v = localStorage.getItem(k);
      setArrivedLocal(!!v);
    } catch {
      // ignore
    }
  };

  // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
  // Cross-page sync for the bypass flag. localStorage is the
  // optimistic mirror; the authoritative state lives at
  // incidents/<id>/notes/main.notesStatus once saveIncidentNotesV1
  // returns. Lets the NBA advance instantly on click without waiting
  // for a refresh.
  const syncNotesBypassedLocal = () => {
    try {
      const k = "peakops_notes_bypassed_" + String(incidentId);
      const v = localStorage.getItem(k);
      setNotesBypassedLocal(!!v);
    } catch {
      // ignore
    }
  };
// Global hook for cross-page optimistic events (e.g., Notes → NOTEs_SAVED)
  useEffect(() => {
    try {
      (window as any).__PEAKOPS_ADD_TIMELINE__ = (evt: any) => {
        try {
          if (!evt || !evt.type) return;
          setTimeline((prev: any) => {
            const arr = Array.isArray(prev) ? prev : [];
            // de-dupe by id if present
            if (evt.id && arr.some((x:any) => x?.id === evt.id)) return arr;
            return [evt, ...arr];
          });
        } catch {}
      };
      return () => { try { delete (window as any).__PEAKOPS_ADD_TIMELINE__; } catch {} };
    } catch {}
  }, []);
// V6_SESSION_HELPERS__START
  // Derive sessionId from current state (no TDZ). Prefer latest evidence sessionId.
  const getActiveSessionId = () => {
    const evSid = (Array.isArray(evidence) && evidence.length ? (evidence[0] as any)?.sessionId : "") || "";
    const tlSid = (Array.isArray(timeline) && timeline.length ? (timeline[0] as any)?.sessionId : "") || "";
    return String(evSid || tlSid || "").trim();
  };

  // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
  // "No note needed — photos tell the story." Persists the bypass via
  // saveIncidentNotesV1 with notesStatus="bypassed" and a fixed
  // reason, optimistically flips the local sticky flag, and surfaces
  // a toast so the user sees the choice was recorded.
  async function bypassNotes() {
    if (bypassNotesBusy) return;
    if (isClosed) {
      toast("Job is closed (read-only).", 2600);
      return;
    }
    setBypassNotesBusy(true);
    // Optimistic: flip immediately so the NBA advances on this render.
    setNotesBypassedLocal(true);
    try {
      localStorage.setItem("peakops_notes_bypassed_" + String(incidentId || ""), "1");
    } catch {}
    let saveFailed = false;
    try {
      const out: any = await postJson(`/api/fn/saveIncidentNotesV1`, {
        orgId,
        incidentId,
        incidentNotes: "",
        siteNotes: "",
        notesStatus: "bypassed",
        notesBypassReason: "Photos provide sufficient context",
        updatedBy: "ui",
      });
      if (!out?.ok) throw new Error(out?.error || "saveIncidentNotesV1 failed");
    } catch (e: any) {
      // Backend is best-effort. The local sticky still allows the user
      // to advance to Submit; the supervisor view will show the
      // bypass once the next save round-trips.
      saveFailed = true;
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[bypass-notes] save failed", e);
      }
    } finally {
      setBypassNotesBusy(false);
    }
    // PEAKOPS_NOTES_CHECKPOINT_V2 (2026-04-29)
    // Single toast at end-of-flow regardless of save outcome — the
    // local sticky is what unlocks the user's flow, and the backend
    // sync is best-effort (a debug warning surfaces failures in dev).
    void saveFailed;
    toast("Skipped — photos are enough.", 2000);
  }

  const v6MarkArrived = async () => {
    try {
      setArriving(true);
      const sid = getActiveSessionId();
      if (!sid) throw new Error("sessionId missing — add evidence / start a session first.");
      const out: any = await postJson(`/api/fn/markArrivedV1`, { orgId: orgId,
        incidentId,
        sessionId: sid,
        updatedBy: "ui",
      });
      if (!out?.ok) throw new Error(out?.error || "markArrived failed");
      setArrived(true);
      try { localStorage.setItem("peakops_arrived_" + String(incidentId || ""), "1"); } catch {}
      setArrivedLocal(true);
      toast("Arrived ✓", 1500);
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "markArrived failed";
      toast(`Arrival failed: ${msg}`, 3500);
    } finally {
      setArriving(false);
    }
  };

  const v6SubmitSession = async () => {
    await submitSession();
  };
  // V6_SESSION_HELPERS__END

  // V6_SESSION_STATE__ACTIVE
  const [activeSessionId, setActiveSessionId] = useState<string>(" ".trim());

  // V6_SESSION_DETECT__EVID_TL
  useEffect(() => {
    if ((activeSessionId || "").trim()) return;
    const sid =
      (Array.isArray(evidence) && evidence[0] && (evidence[0] as any).sessionId) ||
      (Array.isArray(timeline) && timeline[0] && (timeline[0] as any).sessionId) ||
      "";
    if (sid) setActiveSessionId(String(sid));
  }, [activeSessionId, evidence, timeline]);

  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<"live" | "error">("live");
  const [refreshError, setRefreshError] = useState<{ endpoint?: string; status?: number; body?: string; message: string; base?: string; fallback?: boolean } | null>(null);
  // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
  const [incidentNotFound, setIncidentNotFound] = useState(false);

  // Thumbnails (evidenceId -> signed url)
  const [thumbUrl, setThumbUrl] = useState<Record<string, string>>({});
  const [thumbPathById, setThumbPathById] = useState<Record<string, string>>({});
  const [thumbRetryById, setThumbRetryById] = useState<Record<string, number>>({});
  const [thumbDiagById, setThumbDiagById] = useState<Record<string, string>>({});
  const [thumbStatusById, setThumbStatusById] = useState<Record<string, number>>({});
  const [thumbMintErrorById, setThumbMintErrorById] = useState<Record<string, string>>({});
  const [thumbProbeStatusById, setThumbProbeStatusById] = useState<Record<string, number>>({});
  const [thumbProbeErrorById, setThumbProbeErrorById] = useState<Record<string, string>>({});
  const [thumbBucketById, setThumbBucketById] = useState<Record<string, string>>({});
  const [thumbDebugOverlay, setThumbDebugOverlay] = useState(false);
  const thumbRefreshInflightRef = useRef<Record<string, boolean>>({});
  const thumbRefreshDebounceRef = useRef<any>(null);
  const thumbMintInflightRef = useRef<Record<string, boolean>>({});
  // PEAKOPS_THUMB_TERMINAL_V1 (2026-04-24)
  // Hard terminal-failure flag per evidenceId. Survives state resets and
  // refresh() cycles because it's a ref, not state. Set on the FIRST of:
  //   - a mint call that returned !ok,
  //   - a post-mint probe that failed (e.g. 403 from GCS),
  //   - an <img> onError firing.
  // While this flag is true for an id, prefetchThumbs / retryThumbs /
  // renewThumbOnce all skip minting for it — no more loops. Cleared only
  // when the IncidentClient component unmounts (i.e. hard page reload or
  // navigating to a different incident).
  const thumbTerminalRef = useRef<Record<string, boolean>>({});
  const refreshInflightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  // PEAKOPS_CREATE_JOB_INFLIGHT_V1
  // Dedicated inflight flag for createJob. The existing jobsBusy state is
  // shared with setJobStatus / assignJobOrg / assignAllUnassignedToCurrentJob
  // / assignEvidenceJob — any of those firing (including auto-refresh-driven
  // races) would wrongly disable the Create Job button. This ref gates only
  // the create flow and has no cross-contamination risk.
  const createJobInflightRef = useRef(false);
  const [createJobInflight, setCreateJobInflight] = useState(false);

  // PEAKOPS_THUMBS_C2_V1: per-evidence thumb error flag
  const [thumbErr, setThumbErr] = useState<Record<string, boolean>>({});

  // Modal preview
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>("");
  // PHASE5A_REQUEST_UPDATE_BANNER_V1
  // PHASE7_2_REQUPDATE_SYNC_V1
  // Supervisor "Request update" note:
  // - Server truth via GET/DELETE /api/supervisor-request
  // - Offline fallback via localStorage
  // - Outbox flush on mount (ReviewClient writes outbox; IncidentClient just reads)

  const [reqUpdateText, setReqUpdateText] = useState<string>("");
  const reqUpdateKey = "peakops_review_request_" + String(incidentId || "");

  const loadReqUpdate = async () => {
    // PHASE7_2_REQUPDATE_SYNC_V2 (timeout + cache fallback)
    const id = String(incidentId || "").trim();
    const key = reqUpdateKey;

    // 1) Fast server truth (hard timeout)
    try {
      if (id) {
        const ctrl = new AbortController();
        const t = window.setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch("/api/supervisor-request?incidentId=" + encodeURIComponent(id), {
          method: "GET",
          signal: ctrl.signal,
          cache: "no-store",
        }).finally(() => window.clearTimeout(t));

        if (res.ok) {
          const j: any = await res.json().catch(() => ({}));
          const msg = String(j?.message || j?.requestUpdate?.message || "").trim();
          if (msg) {
            try { localStorage.setItem(key, msg); } catch {}
            setReqUpdateText(msg);
            return;
          }
        }
      }
    } catch {}

    // 2) Cache fallback (offline-safe)
    try {
      const v = localStorage.getItem(key);
      setReqUpdateText(v ? String(v) : "");
    } catch {
      setReqUpdateText("");
    }
  };

  const clearReqUpdate = async () => {
    // Try server clear
    try {
      const id = String(incidentId || "").trim();
      if (id) {
        await fetch("/api/supervisor-request", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ incidentId: id, actor: { role: "field" } }),
        });
      }
    } catch {}
    try { localStorage.removeItem(reqUpdateKey); } catch {}
    setReqUpdateText("");
  };

  // Load on mount + when incident changes
  useEffect(() => {
    try { outboxFlushSupervisorRequests(); } catch {}
    try { loadReqUpdate(); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);


const [contextLockId, setContextLockId] = useState<string | null>(null);
// PEAKOPS_UX_TOAST_V1

  // Jump helper used by TimelinePanel (must be in component scope)
      // PEAKOPS_JUMP_CENTER_LOCKED_V2
  const jumpToEvidence = (eid: string) => {
    try {
      const id = String(eid || "").trim();
      if (!id) return;

      // highlight immediately
      setSelectedEvidenceId(id);
      setTab("evidence");

      // PHASE4_2_CONTEXT_LOCK_V1
      try {
        setContextLockId(id);
        window.setTimeout(() => { try { setContextLockId(null); } catch {} }, 800);
      } catch {}


      // A) Vertical: bring Evidence section into view (not top)
      try {
        const anchor = document.getElementById("evidence");
        if (anchor && "scrollIntoView" in anchor) {
          (anchor as any).scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } catch {}

      // B) Horizontal: after layout settles, CENTER the tile in the scroller
      window.setTimeout(() => {
        try {
          const anchor = document.getElementById("evidence");
          if (anchor && "scrollIntoView" in anchor) {
            (anchor as any).scrollIntoView({ behavior: "smooth", block: "center" });
          }
          const scroller = document.getElementById("evidenceScroller") as HTMLElement | null;
          const tile = document.querySelector('[data-ev-id="' + id + '"]') as HTMLElement | null;
          if (!tile) return;

          if (scroller) {
            const prevSnap = scroller.style.scrollSnapType || "";
            const prevPadL = (scroller.style.scrollPaddingLeft || "");
            const prevPadR = (scroller.style.scrollPaddingRight || "");
            const prevAlign = (tile.style as any).scrollSnapAlign || "";

            // Temporarily disable snap + add scroll-padding so "inline:center" can actually center
            try { scroller.style.scrollSnapType = "none"; } catch {}

            try {
              const pad = Math.max(0, (scroller.clientWidth / 2) - (tile.offsetWidth / 2));
              scroller.style.scrollPaddingLeft = pad + "px";
              scroller.style.scrollPaddingRight = pad + "px";
            } catch {}

            // Force selected tile to prefer center snapping (while we center)
            try { (tile.style as any).scrollSnapAlign = "center"; } catch {}

            // Let browser do the centering (more reliable than manual math w/ snap)
            try {
              tile.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
            } catch {}

            // Restore styles after it lands
            window.setTimeout(() => {
              try { scroller.style.scrollSnapType = prevSnap; } catch {}
              try { scroller.style.scrollPaddingLeft = prevPadL; } catch {}
              try { scroller.style.scrollPaddingRight = prevPadR; } catch {}
              try { (tile.style as any).scrollSnapAlign = prevAlign; } catch {}
            }, 550);
          } else {
            // fallback: still try to center
            try { tile.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }); } catch {}
          }
        } catch {}
      }, 180);
    } catch {}
};
// PHASE4_1_KEYNAV_V1
  useEffect(() => {
    if (!selectedEvidenceId) return;
    if (previewOpen) return;

    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "Escape") return;

      try { e.preventDefault(); } catch {}

      if (k === "Escape") {
        setSelectedEvidenceId("");
        return;
      }

      const idx = (evidence || []).findIndex((ev: any) => String(ev?.id || "") === String(selectedEvidenceId || ""));
      if (idx < 0) return;

      const nextIdx = k === "ArrowRight"
        ? Math.min(idx + 1, (evidence || []).length - 1)
        : Math.max(idx - 1, 0);

      const next = (evidence || [])[nextIdx];
      if (!next || !next.id) return;

      setSelectedEvidenceId(next.id);
      jumpToEvidence(String(next.id));
    };

    window.addEventListener("keydown", onKey);
    return () => {
      try { window.removeEventListener("keydown", onKey); } catch {}
    };
  }, [selectedEvidenceId, previewOpen, evidence]);

  const evidenceCount = evidence.length;
  const latestEvidenceSec = evidence?.[0]?.storedAt?._seconds || evidence?.[0]?.createdAt?._seconds;
  const lastActivity = useMemo(() => fmtAgo(latestEvidenceSec), [latestEvidenceSec]);
  const selectableFieldJobs = useMemo(
    () => (jobs || []).filter((j: any) => isFieldSelectableJob(j?.status)),
    [jobs]
  );
  const jobsForMapping = selectableFieldJobs.length ? selectableFieldJobs : (jobs || []);
  const showJobsDebugPanel = useMemo(() => {
    try {
      const demoMode = String(localStorage.getItem("peakops_demo_mode") || "") === "1";
      const host = String(new URL(String(functionsBase || "")).hostname || "").toLowerCase();
      const localHost = host === "localhost" || host === "127.0.0.1";
      return demoMode || localHost;
    } catch {
      return false;
    }
  }, [functionsBase]);
  const rawJobsDebug = useMemo(
    () =>
      (jobs || []).map((j: any) => ({
        id: String(j?.id || j?.jobId || ""),
        title: String(j?.title || ""),
        status: String(j?.status || ""),
        reviewStatus: String(j?.reviewStatus || ""),
        assignedOrgId: String(j?.assignedOrgId || ""),
      })),
    [jobs]
  );
  const normalizedJobStatuses = useMemo(
    () =>
      (jobs || []).map((j: any) => ({
        id: String(j?.id || j?.jobId || ""),
        title: String(j?.title || ""),
        rawStatus: String(j?.status || ""),
        norm: normalizeJobStatus(j?.status),
      })),
    [jobs]
  );
  const hasActiveFieldJobs = selectableFieldJobs.length > 0 || (jobs || []).length > 0;

  useEffect(() => {
    const currentId = String(currentJobId || "").trim();
    const existsInSelectable = selectableFieldJobs.some(
      (j: any) => String(j?.id || j?.jobId || "") === currentId
    );
    if (currentId && existsInSelectable) return;
    const firstSelectableId = String(selectableFieldJobs?.[0]?.id || selectableFieldJobs?.[0]?.jobId || "").trim();
    if (firstSelectableId) setCurrentJobId(firstSelectableId);
  }, [selectableFieldJobs, currentJobId]);

  const isClosed = String(incidentStatus || "").toLowerCase() === "closed";
  const isDemoMode = isDemoIncident(incidentId);
  const isIncidentClosedError = (e: any) => {
    const msg = String(e?.message || e || "").toLowerCase();
    return msg.includes("incident_closed") || (msg.includes("409") && msg.includes("incident"));
  };
  const actorUid = () => getActorUid();
  const actorRole = () => getActorRole();
  const actorEmail = () => String(localStorage.getItem("peakops_email") || "").trim();
  const functionsBaseIsLocal = useMemo(() => {
    try {
      const u = new URL(String(functionsBase || ""));
      const h = String(u.hostname || "").toLowerCase();
      return h === "localhost" || h === "127.0.0.1";
    } catch {
      return false;
    }
  }, [functionsBase]);
  const demoModeFlag = useMemo(() => {
    try {
      return String(localStorage.getItem("peakops_demo_mode") || "") === "1";
    } catch {
      return false;
    }
  }, []);
  const showOrgDevTools = functionsBaseIsLocal || demoModeFlag || orgDebugEmulatorDetected;

  async function copyDemoResetCommand() {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(DEMO_RESET_CMD);
      } else {
        const ta = document.createElement("textarea");
        ta.value = DEMO_RESET_CMD;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast("Reset command copied.", 1800);
    } catch {
      toast("Copy failed. Use: " + DEMO_RESET_CMD, 3000);
    }
  }

  async function resetDemoNow() {
    try {
      toast("Resetting demo…", 1500);

      try {
        const sidKey = "peakops_active_session_" + String(incidentId || "");
        const jobKey = "peakops_current_job_" + String(incidentId || "").trim();
        localStorage.removeItem(sidKey);
        localStorage.removeItem(jobKey);
        sessionStorage.removeItem(sidKey);
        sessionStorage.removeItem(jobKey);
      } catch {}
      try { setActiveSessionId(""); } catch {}
      try { setCurrentJobId(""); } catch {}
      try { setIncidentStatus("open"); } catch {}
      try { setTimeline([] as any); } catch {}
      try { setEvidence([] as any); } catch {}

      const res = await fetch("/api/dev/reset-demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) {
        throw new Error(out?.error || "reset-demo failed");
      }

      try { await refresh(); } catch {}
      await new Promise((r) => setTimeout(r, 900));

      const resetUrl = `/incidents/${encodeURIComponent(String(incidentId || "inc_demo"))}?reset=${Date.now()}`;
      try {
        window.location.href = resetUrl;
      } catch {
        try {
          window.location.assign(resetUrl);
        } catch {
          location.reload();
        }
      }
    } catch (e: any) {
      toast("Demo reset failed: " + String(e?.message || e), 3500);
    }
  }

  async function closeIncident() {
    if (isClosed) {
      toast("Incident already closed.", 1800);
      return;
    }
    const requestOrgId = String(orgId || "").trim();
    if (!requestOrgId || !incidentId) {
      toast("Close failed: missing org/incident context.", 3200);
      return;
    }
    const ok = true;
    if (!ok) {
      toast("Close canceled.", 1400);
      return;
    }
    try {
      setClosingIncident(true);
      const res = await authedFetch("/api/fn/closeIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: requestOrgId,
          incidentId,
          closedBy: "ui",
          actorRole: actorRole(),
          actorUid: actorUid(),
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) throw new Error(out?.error || `closeIncidentV1 failed (${res.status})`);
      setIncidentStatus("closed");
      await refresh();
      toast("Job closed ✓", 2200);
    } catch (e: any) {
      toast("Close failed: " + String(e?.message || e), 3200);
    } finally {
      setClosingIncident(false);
    }
  }

  async function createJob() {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    const title = String(jobTitle || "").trim();
    if (!title) return toast("Task name is required.", 2200);
    // PEAKOPS_CREATE_JOB_INFLIGHT_V1: dedicated re-entry guard. Short-circuits
    // a double-click even if React hasn't re-rendered to reflect jobsBusy yet.
    if (createJobInflightRef.current) return;
    createJobInflightRef.current = true;
    setCreateJobInflight(true);
    try {
      setJobsBusy(true);
      const out: any = await postJson(`/api/fn/createJobV1`, {
        orgId,
        incidentId,
        title,
        assignedOrgId: String(jobAssignedTo || "").trim(),
        actorUid: actorUid(),
        actorRole: actorRole(),
        actorEmail: actorEmail(),
      });
      if (!out?.ok) throw new Error(out?.error || "createJobV1 failed");

      // PEAKOPS_AUTO_ATTACH_ON_CREATE_V1 (2026-04-29)
      // The user thinks in "incident → photos → tasks", not in
      // "create job, then map evidence". When unassigned photos
      // exist at the moment a task is created, auto-attach them all
      // to the new task and roll the result into a single confirmation
      // toast. Eliminates the manual mapping step entirely for the
      // common-case "I shot photos, now I'm logging the task" flow.
      const newJobId = String(out?.jobId || out?.id || "").trim();
      let attached = 0;
      let attachClosedHit = false;
      if (newJobId) {
        const r = await attachUnassignedEvidenceToJob(newJobId);
        attached = r.assigned;
        attachClosedHit = r.closedHit;
        // Make the new task the active one so subsequent captures
        // auto-attach to it without the user picking from a dropdown.
        setCurrentJobId(newJobId);
        try {
          localStorage.setItem(
            `peakops_current_job_${String(incidentId || "").trim()}`,
            newJobId,
          );
        } catch {}
      }

      setShowCreateJob(false);
      setJobTitle("");
      setJobAssignedTo("");
      setJobNotes("");
      await refresh();

      if (attachClosedHit) {
        toast("Job is closed (read-only).", 2600);
      } else if (attached > 0) {
        toast(`Task created · ${attached} photo${attached === 1 ? "" : "s"} attached`, 2400);
      } else {
        toast("Task created", 1800);
      }
    } catch (e: any) {
      if (isIncidentClosedError(e)) {
        toast("Job is closed (read-only).", 2600);
        return;
      }
      toast("Create task failed: " + String(e?.message || e), 3200);
    } finally {
      setJobsBusy(false);
      createJobInflightRef.current = false;
      setCreateJobInflight(false);
    }
  }

  async function setJobStatus(jobId: string, status: JobStatus) {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    try {
      setJobsBusy(true);
      const out: any = await postJson(`/api/fn/updateJobStatusV1`, {
        orgId,
        incidentId,
        jobId,
        status,
        actorUid: actorUid(),
        actorRole: actorRole(),
        actorEmail: actorEmail(),
      });
      if (!out?.ok) throw new Error(out?.error || "updateJobStatusV1 failed");
      await refresh();
      if (process.env.NODE_ENV !== "production" && status === "complete") {
        console.debug("[job-mark-complete]", {
          jobId,
          status: String(out?.status || status),
        });
      }
      toast("Task status updated ✓", 1500);
      return true;
    } catch (e: any) {
      if (isIncidentClosedError(e)) {
        toast("Job is closed (read-only).", 2600);
        return false;
      }
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes("invalid_transition")) {
        toast("Status transition blocked (invalid_transition).", 3000);
        return false;
      }
      toast("Update status failed: " + String(e?.message || e), 3000);
      return false;
    } finally {
      setJobsBusy(false);
    }
  }

  async function assignJobOrg(jobId: string, assignedOrgIdRaw: string) {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    const assignedOrgId = String(assignedOrgIdRaw || "").trim();
    try {
      setJobsBusy(true);
      const out: any = await postJson(`/api/fn/assignJobOrgV1`, {
        orgId,
        incidentId,
        jobId,
        assignedOrgId: assignedOrgId || null,
        actorUid: actorUid(),
        actorRole: actorRole(),
      });
      if (!out?.ok) throw new Error(out?.error || "assignJobOrgV1 failed");
      await refresh();
      toast("Task assignment updated ✓", 1800);
    } catch (e: any) {
      toast("Assign org failed: " + String(e?.message || e), 3200);
    } finally {
      setJobsBusy(false);
    }
  }

  async function debugOrgs() {
    if (!functionsBase) return;
    try {
      setOrgDebugBusy(true);
      const res = await authedFetch(`/api/fn/debugOrgsV1`, { method: "GET" });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) {
        if (parsed && String(parsed?.functionsEmulator || "").toLowerCase() === "true") {
          setOrgDebugEmulatorDetected(true);
        }
        setOrgDebugJson(JSON.stringify({
          ok: false,
          httpStatus: res.status,
          error: parsed?.error || text || "debugOrgsV1_failed",
          body: parsed || text || "",
        }, null, 2));
        return;
      }
      if (parsed && String(parsed?.functionsEmulator || "").toLowerCase() === "true") {
        setOrgDebugEmulatorDetected(true);
      }
      setOrgDebugJson(JSON.stringify(parsed || { ok: false, error: "empty_response" }, null, 2));
    } catch (e: any) {
      setOrgDebugJson(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    } finally {
      setOrgDebugBusy(false);
    }
  }

  async function seedOrgsDev() {
    if (!functionsBase) return;
    try {
      setOrgSeedBusy(true);
      const out: any = await postJson(`/api/fn/seedOrgsV1`, {});
      if (!out?.ok) throw new Error(out?.error || "seedOrgsV1 failed");
      await refresh();
      await debugOrgs();
      toast("Seeded orgs (dev) ✓", 1800);
    } catch (e: any) {
      toast("Seed orgs failed: " + String(e?.message || e), 3200);
      setOrgDebugJson(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    } finally {
      setOrgSeedBusy(false);
    }
  }

  async function markCurrentJobComplete() {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    const jid = String(currentJobId || "").trim();
    if (!jid) return toast("Select a task first.", 2200);
    const completeOk = window.confirm("Mark complete?");
    if (!completeOk) return;
    await setJobStatus(jid, "complete");
  }

  // PEAKOPS_ATTACH_UNASSIGNED_TO_JOB_V1 (2026-04-29)
  // Inner attach-loop extracted so the create-task auto-attach path
  // and the manual "Assign all to my task" button can share one
  // implementation. Returns the count attached + whether the
  // incident was already closed; lets the caller phrase the toast.
  async function attachUnassignedEvidenceToJob(
    jid: string,
  ): Promise<{ assigned: number; closedHit: boolean; attempted: number }> {
    const targetJid = String(jid || "").trim();
    if (!targetJid) return { assigned: 0, closedHit: false, attempted: 0 };

    const unassignedIds = (evidence || [])
      .filter((ev: any) => !String(ev?.jobId || ev?.evidence?.jobId || "").trim())
      .map((ev: any) => String(ev?.id || "").trim())
      .filter(Boolean);

    if (unassignedIds.length === 0) {
      return { assigned: 0, closedHit: false, attempted: 0 };
    }

    // Optimistic: show immediate attachment in rows so the UI doesn't
    // flash "unassigned" while parallel calls round-trip.
    const unassignedSet = new Set(unassignedIds);
    setEvidence((prev: any[]) =>
      (Array.isArray(prev) ? prev : []).map((ev: any) =>
        unassignedSet.has(String(ev?.id || ""))
          ? {
              ...ev,
              evidence: { ...(ev?.evidence || {}), jobId: targetJid },
              jobId: targetJid,
            }
          : ev,
      ),
    );

    let assigned = 0;
    let closedHit = false;
    let idx = 0;
    const limit = Math.min(5, unassignedIds.length);
    const worker = async () => {
      while (true) {
        const i = idx++;
        if (i >= unassignedIds.length) return;
        const evidenceId = unassignedIds[i];
        try {
          const out: any = await postJson(`/api/fn/assignEvidenceToJobV1`, {
            orgId,
            incidentId,
            evidenceId,
            jobId: targetJid,
          });
          if (!out?.ok) throw new Error(out?.error || "assignEvidenceToJobV1 failed");
          assigned += 1;
        } catch (e: any) {
          if (isIncidentClosedError(e)) closedHit = true;
        }
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return { assigned, closedHit, attempted: unassignedIds.length };
  }

  async function assignAllUnassignedToCurrentJob() {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    const jid = String(currentJobId || "").trim();
    if (!jid) return toast("Select a task first.", 2200);

    setJobsBusy(true);
    try {
      const { assigned, closedHit, attempted } = await attachUnassignedEvidenceToJob(jid);
      if (attempted === 0) {
        toast("No unassigned evidence found.", 2000);
        return;
      }
      await refresh();
      if (closedHit) {
        toast("Job is closed (read-only).", 2600);
      } else {
        toast(`Attached ${assigned} photo${assigned === 1 ? "" : "s"} to this task.`, 2200);
      }
    } finally {
      setJobsBusy(false);
    }
  }

  async function assignEvidenceJob(evidenceId: string, jobIdRaw: string) {
    if (isClosed) return toast("Job is closed (read-only).", 2600);
    const eid = String(evidenceId || "").trim();
    if (!eid) {
      toast("Could not attach: evidence ID missing.", 2600);
      return;
    }
    const trimmedOrgId = String(orgId || "").trim();
    if (!trimmedOrgId) {
      toast("Could not attach: org context missing — reload with ?orgId=… in the URL.", 3200);
      return;
    }
    const nextJobId = String(jobIdRaw || "").trim();
    // Optimistic local update so the row reflects the new attachment
    // immediately. The await refresh() below confirms (or reverts via the
    // catch path) once the server responds.
    setEvidence((prev: any[]) =>
      (Array.isArray(prev) ? prev : []).map((ev: any) =>
        String(ev?.id || "") === eid
          ? {
              ...ev,
              evidence: { ...(ev?.evidence || {}), jobId: nextJobId || null },
              jobId: nextJobId || null,
            }
          : ev
      )
    );
    try {
      setJobsBusy(true);
      const payload = {
        orgId: trimmedOrgId,
        incidentId,
        evidenceId: eid,
        jobId: nextJobId || null,
      };
      // PEAKOPS_DROPDOWN_DEBUG_V1 (2026-04-27, dev-only) — strip noisy
      // logging in prod bundles via the standard NODE_ENV gate.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.debug("[assignEvidenceToJobV1] payload", payload);
      }
      const out: any = await postJson(`/api/fn/assignEvidenceToJobV1`, payload);
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.debug("[assignEvidenceToJobV1] response", out);
      }
      if (!out?.ok) throw new Error(out?.error || "assignEvidenceToJobV1 failed");
      await refresh();
      toast(nextJobId ? "Evidence attached to task ✓" : "Evidence detached from task ✓", 1600);
    } catch (e: any) {
      if (isIncidentClosedError(e)) {
        toast("Job is closed (read-only).", 2600);
      } else {
        toast("Attach evidence failed: " + String(e?.message || e), 3200);
      }
      await refresh();
    } finally {
      setJobsBusy(false);
    }
  }

  async function debugEvidenceRow(evidenceId: string, storagePath?: string) {
    const eid = String(evidenceId || "").trim();
    if (!eid) return;
    const sp = String(storagePath || "").trim();
    setHeicRowBusyById((m) => ({ ...m, [eid]: true }));
    try {
      const out: any = await postJson(`/api/fn/debugEvidenceV1`, {
        orgId,
        incidentId,
        evidenceId: eid,
        storagePath: sp || undefined,
      });
      setHeicRowDebugById((m) => ({ ...m, [eid]: JSON.stringify(out || {}, null, 2) }));
      if (!out?.ok) toast("Debug failed: " + String(out?.error || "unknown"), 2600);
    } catch (e: any) {
      setHeicRowDebugById((m) => ({ ...m, [eid]: JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2) }));
      toast("Debug failed: " + String(e?.message || e), 2600);
    } finally {
      setHeicRowBusyById((m) => ({ ...m, [eid]: false }));
    }
  }

  async function convertEvidenceRowNow(evidenceId: string, storagePath?: string, opts?: { forceMarkDone?: boolean }) {
    const eid = String(evidenceId || "").trim();
    if (!eid) return;
    const sp = String(storagePath || "").trim();
    const forceMarkDone = !!opts?.forceMarkDone;
    setHeicRowBusyById((m) => ({ ...m, [eid]: true }));
    try {
      const convertOut: any = await postJson(`/api/fn/convertEvidenceHeicNowV1`, {
        orgId,
        incidentId,
        evidenceId: eid,
        storagePath: sp || undefined,
        forceMarkDone,
      });
      const debugOut: any = await postJson(`/api/fn/debugEvidenceV1`, {
        orgId,
        incidentId,
        evidenceId: eid,
        storagePath: sp || undefined,
      });
      setHeicRowDebugById((m) => ({
        ...m,
        [eid]: JSON.stringify({ convert: convertOut || {}, debug: debugOut || {} }, null, 2),
      }));
      await refresh();
      if (!convertOut?.ok) {
        toast("Convert failed: " + String(convertOut?.error || convertOut?.reason || "unknown"), 3200);
      } else {
        toast(forceMarkDone ? "Force mark done ✓" : "Convert requested ✓", 1600);
      }
    } catch (e: any) {
      setHeicRowDebugById((m) => ({ ...m, [eid]: JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2) }));
      toast("Convert failed: " + String(e?.message || e), 3200);
    } finally {
      setHeicRowBusyById((m) => ({ ...m, [eid]: false }));
    }
  }

  async function refresh(retryAttempt = 0, baseOverride?: string, fallbackUsed = false) {
    const base = String(baseOverride || functionsBase || "").trim();
    if (!base) return;
    if (refreshInflightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInflightRef.current = true;
    if (process.env.NODE_ENV !== "production") {
      console.debug("[inc-refresh] start", { incidentId, orgId, functionsBase: base, fallbackUsed });
    }
    setLoading(true);
    setRefreshError(null);
    setIncidentNotFound(false);

    try {
      // Single source of truth: URL query param captured at component top.
      // No fallback, no doc-based override — if URL has no orgId, we abort.
      const requestOrgId = String(orgId || "").trim();
      if (!requestOrgId) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[inc-refresh] missing orgId in URL — aborting refresh");
        }
        return;
      }
      const failHttp = (name: string, url: string, status: number, body: string) => {
        const err: any = new Error(`${name} failed (${status})`);
        err.endpoint = url;
        err.status = status;
        err.body = String(body || "").slice(0, 500);
        throw err;
      };
      const fetchTextOrThrow = async (name: string, url: string) => {
        // Refresh path only fetches /api/fn/* URLs; route through authedFetch.
        const res = await authedFetch(url);
        const body = await res.text();
        if (!res.ok) failHttp(name, url, res.status, body);
        return body;
      };

      const incUrl =
        `/api/fn/getIncidentV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const incBody = await fetchTextOrThrow("getIncidentV1", incUrl);
      const inc = incBody ? JSON.parse(incBody) : {};
      if (inc?.ok && inc?.doc) {
        const st = normalizeIncidentStatus(inc?.doc?.status);
        const updatedSec = Number(
          inc?.doc?.updatedAt?._seconds ||
          inc?.doc?.closedAt?._seconds ||
          inc?.doc?.inProgressAt?._seconds ||
          0
        );
        setIncidentStatus(st || "open");
        setIncidentTitle(String(inc?.doc?.title || "").trim());
        setIncidentUpdatedAtSec(updatedSec || null);
        const pm: any = inc?.doc?.packetMeta || {};
        const pmReady =
          String(pm?.status || "").toLowerCase() === "ready" ||
          !!String(pm?.downloadUrl || "").trim() ||
          !!String(pm?.packetHash || pm?.zipSha256 || "").trim() ||
          (!!String(pm?.bucket || "").trim() && !!String(pm?.storagePath || "").trim());
        setPacketReady(pmReady);
      }

      // Jobs (GET-only, non-fatal — empty jobs list should not kill the field page)
      try {
        const jobsUrl =
          `/api/fn/listJobsV1?orgId=${encodeURIComponent(requestOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=50` +
          `&actorUid=${encodeURIComponent(actorUid())}&actorRole=${encodeURIComponent(actorRole())}`;
        const jobsRes = await authedFetch(jobsUrl);
        const jobsBody = await jobsRes.text();
        if (!jobsRes.ok) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[inc-refresh] jobs fetch failed (non-fatal)", {
              httpStatus: jobsRes.status,
              body: String(jobsBody || "").slice(0, 200),
            });
          }
        } else {
          const jb = jobsBody ? JSON.parse(jobsBody) : {};
          if (process.env.NODE_ENV !== "production") {
            const docs = Array.isArray(jb?.docs) ? jb.docs : [];
            console.debug("[inc-refresh] jobs", {
              httpStatus: jobsRes.status,
              ok: !!jb?.ok,
              count: docs.length,
              statuses: docs.map((j: any) => String(j?.status || "")),
            });
          }
          if (jb?.ok && Array.isArray(jb.docs)) {
            const docs = jb.docs;
            setJobs(docs);
            const selectable = docs.filter((j: any) => isFieldSelectableJob(j?.status));
            const currentId = String(currentJobId || "").trim();
            const existsInSelectable = selectable.some((j: any) => String(j?.id || j?.jobId || "") === currentId);
            const firstSelectableId = String(selectable?.[0]?.id || selectable?.[0]?.jobId || "").trim();
            if (!currentId || !existsInSelectable) {
              if (firstSelectableId) {
                setCurrentJobId(firstSelectableId);
              } else {
                setCurrentJobId("");
              }
            }
            if (process.env.NODE_ENV !== "production") {
              console.debug("[jobs-refresh]", {
                jobsCount: docs.length,
                selectableJobsCount: selectable.length,
                firstJobId: firstSelectableId || "",
              });
            }
          }
        }
      } catch (jobsErr) {
        if (process.env.NODE_ENV !== "production") console.warn("[inc-refresh] jobs fetch failed (non-fatal)", jobsErr);
      }

      const orgsUrl =
        `/api/fn/listOrgsV1?orgId=${encodeURIComponent(requestOrgId)}&limit=100` +
        `&actorUid=${encodeURIComponent(actorUid())}&actorRole=${encodeURIComponent(actorRole())}`;
      setOrgOptionsLoadError(false);
      setOrgOptionsLoaded(false);
      try {
        const orgsRes = await authedFetch(orgsUrl);
        const orgsBody = await orgsRes.text();
        if (!orgsRes.ok) {
          setOrgOptions([]);
          setOrgOptionsLoadError(true);
          setOrgOptionsLoaded(true);
        } else {
          const oj = orgsBody ? JSON.parse(orgsBody) : {};
          if (oj?.ok && Array.isArray(oj.docs)) {
            setOrgOptions(oj.docs);
            setOrgOptionsLoadError(false);
          } else {
            setOrgOptions([]);
            setOrgOptionsLoadError(true);
          }
          setOrgOptionsLoaded(true);
        }
      } catch {
        setOrgOptions([]);
        setOrgOptionsLoadError(true);
        setOrgOptionsLoaded(true);
      }

      // Evidence (GET-only, non-fatal)
      try {
        const evUrl =
          `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(requestOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
        const evRes = await authedFetch(evUrl);
        const evBody = await evRes.text();
        if (process.env.NODE_ENV !== "production") {
          let evidenceCount = 0;
          let evOk = false;
          try {
            const parsed = evBody ? JSON.parse(evBody) : {};
            const docs = Array.isArray(parsed?.docs) ? parsed.docs : [];
            evidenceCount = docs.length;
            evOk = !!parsed?.ok;
          } catch {}
          console.debug("[inc-refresh] evidence", { httpStatus: evRes.status, ok: evOk, count: evidenceCount });
        }
        if (evRes.ok) {
          const ev = evBody ? JSON.parse(evBody) : {};
          if (ev?.ok && Array.isArray(ev.docs)) {
            setEvidence(ev.docs);
            prefetchThumbs(ev.docs);
            setTimeout(() => {
              try {
                const latest = (ev.docs || []).filter((x:any) => x?.file?.storagePath);
                const retryCandidates = latest.filter((x: any) => {
                  const id = String(x?.id || "");
                  return !!id && !!thumbErr?.[id];
                });
                if (!retryCandidates.length) return;
                retryCandidates.forEach((x:any) => {
                  const id = String(x?.id || "");
                  if (!id) return;
                  if (thumbErr?.[id]) {
                    setThumbErr((m:any) => ({ ...m, [id]: false }));
                  }
                });
                retryThumbs(retryCandidates as any);
              } catch {}
            }, 800);
            if (selectedEvidenceId && !ev.docs.some((d:any) => d.id === selectedEvidenceId)) {
              setSelectedEvidenceId("");
            }
          }
        }
      } catch (evErr) {
        if (process.env.NODE_ENV !== "production") console.warn("[inc-refresh] evidence fetch failed (non-fatal)", evErr);
      }

      // Timeline (GET-only, non-fatal)
      try {
        const tlUrl =
          `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(requestOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
        const tlRes = await authedFetch(tlUrl);
        const tlBody = await tlRes.text();
        if (tlRes.ok) {
          const tl = tlBody ? JSON.parse(tlBody) : {};
          if (tl?.ok && Array.isArray(tl.docs)) {
            const docs: TimelineDoc[] = tl.docs.slice();
            docs.sort((a, b) => (b.occurredAt?._seconds || 0) - (a.occurredAt?._seconds || 0));
            setTimeline(docs.filter((x) => x.type !== "DEBUG_EVENT"));
          }
        }
      } catch (tlErr) {
        if (process.env.NODE_ENV !== "production") console.warn("[inc-refresh] timeline fetch failed (non-fatal)", tlErr);
      }

      setDataStatus("live");
    } catch (e) {
      const diag = {
        endpoint: String((e as any)?.endpoint || ""),
        status: Number((e as any)?.status || 0) || undefined,
        body: String((e as any)?.body || ""),
        message: String((e as any)?.message || e || "refresh_failed"),
        base,
        fallback: fallbackUsed,
      };
      const isNetworkFailure = isLikelyFetchNetworkError(e, diag.status);
      if (isNetworkFailure && retryAttempt < 1) {
        const fallbackBase = getFunctionsBaseFallback(base);
        if (fallbackBase) void rememberFunctionsBase(fallbackBase);
        if (fallbackBase) {
          probeAndRestoreEnvFunctionsBase(fallbackBase);
        }
        if (process.env.NODE_ENV !== "production") {
          console.debug("[inc-refresh] transient network failure, retrying once", {
            attempt: retryAttempt + 1,
            incidentId,
            endpoint: diag.endpoint,
            message: diag.message,
            base,
            fallbackBase: fallbackBase || "",
          });
        }
        if (fallbackBase) {
          setTimeout(() => { void refresh(retryAttempt + 1, fallbackBase, true); }, 500);
          return;
        }
        setTimeout(() => { void refresh(retryAttempt + 1, base, fallbackUsed); }, 500);
        return;
      }
      setRefreshError(diag);
      // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
      if (
        Number(diag.status) === 404 ||
        /incident_not_found/i.test(String(diag.body || "")) ||
        /incident not found/i.test(String(diag.message || ""))
      ) {
        setIncidentNotFound(true);
      }
      if (process.env.NODE_ENV !== "production") {
        console.debug("[inc-refresh] error", {
          endpoint: diag.endpoint,
          status: diag.status,
          body: String(diag.body || "").slice(0, 500),
          message: diag.message,
          stack: String((e as any)?.stack || ""),
        });
      }
      // PEAKOPS_REFRESH_LOG_DOWNGRADE_V1 (2026-04-28)
      // Refresh path catches every transient/expected failure (offline,
      // 401, 403, slow network). Logging at error level made the
      // Next.js dev overlay surface a permanent red "1 Issue" badge
      // during normal runs. Downgrade to warn — the soft sync banner
      // already surfaces the user-facing message; engineers still see
      // the diagnostic via console.warn during dev.
      // eslint-disable-next-line no-console
      console.warn("[refresh] non-fatal", {
        endpoint: diag.endpoint,
        status: diag.status,
        error: diag.message,
        fallback: fallbackUsed,
      });
      setDataStatus("error");
    } finally {
      setLoading(false);
      refreshInflightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refresh();
      }
    }
  }

  // Prefetch signed thumbnail URLs for latest 12 evidence items
  async function prefetchThumbs(latest: EvidenceDoc[]) {
    const want = latest.filter((x) => x.file?.storagePath).slice(0, 12);

    await Promise.all(
      want.map(async (ev) => {
        const id = String(ev?.id || "");
        const ref = getBestEvidenceImageRef(ev);
        if (!ref?.storagePath || !ref?.bucket) return;
        if (!id) return;
        // PEAKOPS_THUMB_TERMINAL_V1: once failed, never re-mint until reload.
        if (thumbTerminalRef.current[id]) return;
        if (thumbUrl[id] && thumbPathById[id] === ref.storagePath) return;
        if (thumbMintInflightRef.current[id]) return;

        try {
          thumbMintInflightRef.current[id] = true;
          const resp = await mintEvidenceReadUrl({
            orgId,
            incidentId,
            storagePath: ref.storagePath,
            bucket: ref.bucket,
            expiresSec: getThumbExpiresSec(),
          });
          if (resp?.ok && resp.url) {
            setThumbUrl((m) => ({ ...m, [id]: resp.url! }));
            setThumbPathById((m) => ({ ...m, [id]: ref.storagePath }));
            setThumbBucketById((m) => ({ ...m, [id]: ref.bucket }));
            setThumbRetryById((m) => ({ ...m, [id]: 0 }));
            setThumbDiagById((m) => {
              if (!m[id]) return m;
              const n = { ...m };
              delete n[id];
              return n;
            });
            setThumbStatusById((m) => ({ ...m, [id]: Number(resp?.status || 200) }));
            setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
            setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
            setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
            setThumbErr((m) => ({ ...m, [id]: false }));
          } else {
            // Mint returned !ok — terminal. Don't retry until reload.
            thumbTerminalRef.current[id] = true;
            setThumbErr((m) => ({ ...m, [id]: true }));
            setThumbMintErrorById((m) => ({ ...m, [id]: String(resp?.error || "read_url_failed") }));
          }
        } catch (e) {
          console.warn("thumb prefetch failed", id, e);
          thumbTerminalRef.current[id] = true;
          setThumbDiagById((m) => ({ ...m, [id]: String((e as any)?.message || e || "thumb_prefetch_failed") }));
          setThumbMintErrorById((m) => ({ ...m, [id]: String((e as any)?.message || e || "thumb_prefetch_failed") }));
          setThumbErr((m) => ({ ...m, [id]: true }));
        } finally {
          thumbMintInflightRef.current[id] = false;
        }
      })
    );
  }

  // PEAKOPS_THUMBS_RETRY_HELPER_V1
  // One-shot retry (keeps single prefetch call site).
  async function retryThumbs(latest: EvidenceDoc[]) {
    try {
      if (!functionsBase) return;
      const arr = Array.isArray(latest) ? latest : [];
      const want = arr
        .filter((x: any) => !!x?.file?.storagePath)
        ;

      // Only retry ones that previously failed (thumbErr[id] true) OR still missing thumbUrl.
      for (const ev of want) {
        const id = String((ev as any)?.id || "");
        const ref = getBestEvidenceImageRef(ev as any);
        if (!id || !ref?.storagePath || !ref?.bucket) continue;
        // PEAKOPS_THUMB_TERMINAL_V1: never retry a terminally-failed thumb.
        if (thumbTerminalRef.current[id]) continue;

        const hadErr = !!(thumbErr as any)?.[id];
        const hasUrl = !!(thumbUrl as any)?.[id];
        const samePath = String((thumbPathById as any)?.[id] || "") === ref.storagePath;
        if (!hadErr && hasUrl && samePath) {
          continue;
        }
        if (thumbMintInflightRef.current[id]) continue;

        try {
          thumbMintInflightRef.current[id] = true;
          const resp = await mintEvidenceReadUrl({
            orgId,
            incidentId,
            storagePath: ref.storagePath,
            bucket: ref.bucket,
            expiresSec: getThumbExpiresSec(),
          });

          if (resp?.ok && resp.url) {
            setThumbUrl((m: any) => ({ ...m, [id]: resp.url }));
            setThumbPathById((m: any) => ({ ...m, [id]: ref.storagePath }));
            setThumbBucketById((m: any) => ({ ...m, [id]: ref.bucket }));
            setThumbRetryById((m: any) => ({ ...m, [id]: 0 }));
            setThumbDiagById((m: any) => {
              if (!m[id]) return m;
              const n = { ...m };
              delete n[id];
              return n;
            });
            setThumbStatusById((m: any) => ({ ...m, [id]: Number(resp?.status || 200) }));
            setThumbMintErrorById((m: any) => ({ ...m, [id]: "-" }));
            setThumbProbeStatusById((m: any) => ({ ...m, [id]: 0 }));
            setThumbProbeErrorById((m: any) => ({ ...m, [id]: "-" }));
            setThumbErr((m: any) => ({ ...m, [id]: false }));
          } else {
            const reason = String(resp?.error || "read_url_failed");
            const seenRetry = Number((thumbRetryById as any)?.[id] || 0) >= 1;
            setThumbDiagById((m: any) => ({ ...m, [id]: seenRetry ? reason : `retrying:${reason}` }));
            setThumbMintErrorById((m: any) => ({ ...m, [id]: reason }));
            setThumbErr((m: any) => ({ ...m, [id]: true }));
          }
        } catch (e: any) {
          setThumbDiagById((m: any) => ({ ...m, [id]: String(e?.message || e || "thumb_retry_failed") }));
          setThumbMintErrorById((m: any) => ({ ...m, [id]: String(e?.message || e || "thumb_retry_failed") }));
          setThumbErr((m: any) => ({ ...m, [id]: true }));
        } finally {
          thumbMintInflightRef.current[id] = false;
        }
      }
    } catch {
      // ignore
    }
  }

  async function renewThumbOnce(ev: any, currentSrc: string) {
    const id = String(ev?.id || "");
    if (!id) return;
    if (functionsBaseIsLocal) {
      // Emulator mode: do not auto-renew/retry thumbnails to avoid flicker loops.
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      return;
    }
    // PEAKOPS_THUMB_TERMINAL_V1 (2026-04-24)
    // First image-load failure is terminal for this evidenceId. No re-mint
    // attempt. The minted URL is bad (signed-URL permissions, missing object,
    // wrong bucket, stale doc, etc.) — re-minting the same backend call with
    // the same inputs produces an equally bad URL and just spams GCS with 403s.
    // Mark terminal, clear the URL so the fallback "Unavailable" placeholder
    // renders, and stop. Only a hard page reload re-attempts (the ref clears
    // on component unmount).
    if (thumbTerminalRef.current[id]) return;
    thumbTerminalRef.current[id] = true;
    setThumbErr((m) => ({ ...m, [id]: true }));
    setThumbUrl((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    setThumbDiagById((m) => ({ ...m, [id]: m[id] || "img_load_failed" }));
    logThumbEvent("terminal", { evidenceId: id, src: currentSrc });
  }

  function refreshVisibleThumbsDebounced() {
    if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    thumbRefreshDebounceRef.current = setTimeout(() => {
      const shown = (evidence || [])
        .filter((ev: any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath || "").includes("demo_placeholder"))
        .slice(0, 12);
      shown.forEach((ev: any) => {
        const id = String(ev?.id || "");
        if (!id || thumbRefreshInflightRef.current[id]) return;
        thumbRefreshInflightRef.current[id] = true;
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbErr((m) => ({ ...m, [id]: false }));
        setThumbDiagById((m) => ({ ...m, [id]: "" }));
        const current = String(thumbUrl[id] || "");
        void renewThumbOnce(ev, current).finally(() => {
          thumbRefreshInflightRef.current[id] = false;
        });
      });
    }, 150);
  }

  function forceRemintVisibleThumbs() {
    setThumbUrl({});
    setThumbPathById({});
    setThumbRetryById({});
    setThumbDiagById({});
    setThumbStatusById({});
    setThumbMintErrorById({});
    setThumbProbeStatusById({});
    setThumbProbeErrorById({});
    setThumbBucketById({});
    setThumbErr({});
    refreshVisibleThumbsDebounced();
  }
  useEffect(() => {
    return () => {
      if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    refresh();

    syncNotesSavedLocal();
    syncArrivedLocal();
    syncNotesBypassedLocal();
const t = setInterval(refresh, 60000);

  // === ZIP PACK v3: micro-feedback helpers ===

  function pulseEvidenceTile(eid: string) {
    const el = document.querySelector(`[data-ev-id="${eid}"]`);
    if (!el) return;
    el.classList.add("ring-2", "ring-amber-300/40");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-amber-300/40");
    }, 1200);
  }

  function scrollToId(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // === ZIP PACK v3: button system ===
  const CTA = {
    primary:
      "w-full py-4 rounded-xl text-lg font-semibold " +
      "bg-gradient-to-r from-amber-500 to-slate-400 " +
      "shadow-[0_0_0_1px_rgba(251,191,36,0.18),0_14px_45px_rgba(0,0,0,0.55)] " +
      "text-black/90 hover:brightness-105 active:brightness-95 transition",
    secondary:
      "py-3 rounded-xl bg-white/5 border border-white/10 text-gray-200 " +
      "hover:bg-white/8 active:bg-white/10 transition",
    ghost:
      "px-2 py-1 rounded bg-white/6 border border-white/12 text-gray-200 hover:bg-white/10 transition text-xs",
    jump:
      "px-2 py-1 rounded-full bg-amber-400/12 border border-indigo-400/20 text-indigo-200 " +
      "hover:bg-amber-400/18 transition text-xs",
  };

  async function callFn(path: string, payload: any) {
    const url = `/api/fn/${String(path || "").replace(/^\/+/, "")}`;
    const res = await authedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const txt = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
    try {
      return JSON.parse(txt);
    } catch {
      return { ok: true, raw: txt };
    }
  }

return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, functionsBase]);

  useEffect(() => {
    const pending = (evidence || []).some((ev: any) => isConvertingHeic(ev as EvidenceDoc));
    if (!pending) return;
    const t = window.setTimeout(() => {
      try { refresh(); } catch {}
    }, 4000);
    return () => window.clearTimeout(t);
  }, [evidence, incidentId]);

  useEffect(() => {
    const debugHeic = process.env.NODE_ENV !== "production" && String(process.env.NEXT_PUBLIC_PEAKOPS_DEBUG || "") === "1";
    if (!debugHeic) return;
    (evidence || []).forEach((ev: any) => {
      const f: any = ev?.file || {};
      const hasThumb = !!String(f?.thumbPath || "").trim();
      const hasPreview = !!String(f?.previewPath || "").trim();
      const conversionStatus = String(f?.conversionStatus || "").toLowerCase();
      const converting = isConvertingHeic(ev as EvidenceDoc);
      // Dev-only trace for HEIC conversion state drift.
      console.debug("[heic-status]", {
        evidenceId: String(ev?.id || ""),
        conversionStatus,
        hasThumb,
        hasPreview,
        isConverting: converting,
      });
    });
  }, [evidence]);

  
  // ZIP: query hi=... -> toast + pulse + auto-scroll
  const sp = useSearchParams();
  // PEAKOPS_INCIDENT_DEV_MODE_V2 (2026-04-29)
  // Customer-facing dev tools (Refresh thumbs / Force remint / Show
  // debug disclosure) gated STRICTLY on ?dev=1. Previous V1 also fired
  // when NODE_ENV !== "production", which made local QA look dev-leaky
  // even when the tester hadn't asked for it.
  const devMode = useMemo(() => {
    try {
      const v = String(sp?.get?.("dev") || "").trim();
      return v === "1" || v.toLowerCase() === "true";
    } catch {
      return false;
    }
  }, [sp]);
  
  // OPTIMISTIC: Notes saved → flip readiness instantly
  useEffect(() => {
    try {
      const v = sp.get("notesSaved");
      if (v !== "1") return;

      const nowSec = Math.floor(Date.now() / 1000);
      const sid = String(activeSessionId || "").trim();
      const opt = {
        id: "__opt_notes_saved__" + String(nowSec),
        type: "NOTES_SAVED",
        actor: "ui",
        sessionId: sid || null,
        occurredAt: { _seconds: nowSec },
        meta: { optimistic: true },
      };

      setTimeline((prev: any) => (Array.isArray(prev) ? [opt, ...prev] : [opt]));
      // PEAKOPS_NOTES_SAVED_ORGID_V1: preserve orgId when stripping ?notesSaved=1.
      // Losing orgId from the URL makes refresh() abort (per single-source-of-truth
      // rule), which is why arrival state regressed after a notes save.
      const nextUrl = `/incidents/${incidentId}?orgId=${encodeURIComponent(String(orgId || "").trim())}`;
      router.replace(nextUrl, { scroll: false } as any);
    } catch {}
  }, [sp, incidentId]);
useEffect(() => {
    const v = sp.get("hi");
    if (!v) return;
    setHi(v);
    toast("Evidence secured ✓");
    const t = setTimeout(() => toast(""), 2200);
    // Scroll tile into view (if present)
    setTimeout(() => {
      const el = document.querySelector(`[data-ev-id="${v}"]`);
      if (el && "scrollIntoView" in el) (el as any).scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(t);
  }, [sp]);
  function scrollToEvidence(eid: string) {
    try {
      const el = document.getElementById(`ev-${eid}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {}
  }

  function openModal(ev: EvidenceDoc) {
    const id = String(ev?.id || "");
    setPreviewName(ev.file?.originalName || ev.id);
    setPreviewUrl("");
    setSelectedEvidenceId(ev.id);
    setPreviewOpen(true);
    toast("Opened preview");
    (async () => {
      try {
        if (!id) return;
        const ref = getBestEvidenceImageRef(ev);
        if (!ref?.storagePath || !ref?.bucket) return;
        if (thumbMintInflightRef.current[id]) return;
        thumbMintInflightRef.current[id] = true;
        const resp = await mintEvidenceReadUrl({
          orgId,
          incidentId,
          storagePath: ref.storagePath,
          bucket: ref.bucket,
          expiresSec: getThumbExpiresSec(),
        });
        if (resp?.ok && resp.url) setPreviewUrl(resp.url);
      } catch {}
      finally {
        if (id) thumbMintInflightRef.current[id] = false;
      }
    })();
  }

  const selectedEvidence = (evidence || []).find((ev: any) => String(ev?.id || "") === String(selectedEvidenceId || "")) as EvidenceDoc | undefined;
  const selectedIsHeic = !!(selectedEvidence && isHeicEvidence(selectedEvidence));
  const selectedMissingDerivatives = !!(selectedEvidence && selectedIsHeic && isConvertingHeic(selectedEvidence));

  async function convertSelectedHeicNow() {
    try {
      if (!selectedEvidenceId) return;
      setConvertingHeic(true);
      const out: any = await postJson(`/api/fn/convertEvidenceHeicNowV1`, {
        orgId,
        incidentId,
        evidenceId: selectedEvidenceId,
      });
      if (!out?.ok) throw new Error(out?.error || "convertEvidenceHeicNowV1 failed");
      await refresh();
      toast("HEIC converted ✓", 1800);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("object_not_found")) {
        toast("Upload not in storage yet", 3200);
      } else {
        toast("Convert HEIC failed: " + msg, 3000);
      }
    } finally {
      setConvertingHeic(false);
    }
  }

  async function debugRunSelectedHeic() {
    try {
      if (!selectedEvidenceId) return;
      setDebuggingHeic(true);
      const report: any = await postJson(`/api/fn/debugHeicConversionV1`, {
        orgId,
        incidentId,
        evidenceId: selectedEvidenceId,
        dryRun: false,
      });
      console.log("debugHeicConversionV1 report", report);
      const ok = !!(report?.conversionResult?.ok);
      const reason = String(report?.conversionResult?.reason || "");
      if (ok) {
        await refresh();
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        await refresh();
        const hasPreview = !!String(report?.finalEvidence?.previewPath || "").trim();
        const hasThumb = !!String(report?.finalEvidence?.thumbPath || "").trim();
        toast(hasPreview || hasThumb ? "Debug conversion: success ✓" : "Debug conversion: no derivative paths yet", 2500);
      } else if (reason === "object_not_found" || report?.sourceCheck?.httpStatus === 404) {
        toast("Upload not in storage yet", 3200);
      } else {
        toast("Debug conversion: " + (reason || "no change"), 3200);
      }
    } catch (e: any) {
      toast("Debug conversion failed: " + String(e?.message || e), 3200);
      console.error("debugHeicConversionV1 failed", e);
    } finally {
      setDebuggingHeic(false);
    }
  }

  // Narrative timeline: compress types into a readable story
  const story = useMemo(() => {
    // Collapse consecutive evidence events per-session

    const sorted = timeline.slice(0, 14);
    const out: any[] = [];
    let lastSes = "";
    for (const t of sorted) {
      // evidence group: if this event is EVIDENCE_ADDED and previous is same type+session, we collapse

      const ses = String(t.sessionId || "");
      if (ses && ses !== lastSes) {
        out.push({ type: "__SESSION__", sessionId: ses });
        lastSes = ses;
      }
      out.push(t);
    }
    return out;
  }, [timeline]);

  const storyItems = useMemo(() => {
    const out = story.map((t: any) => {
      if (t.type === "__SESSION__") return t;
      const when = fmtAgo(t.occurredAt?._seconds);
      const title = prettyType(t.type);
      const actor = t.actor || "system";
      const session = t.sessionId || "";
      return { ...t, when, title, actor, session };
    });
    return out;
  }, [story]);

  const _unused_story = useMemo(() => {
    const out = timeline.slice(0, 10).map((t) => {
      const when = fmtAgo(t.occurredAt?._seconds);
      const title = prettyType(t.type);
      const actor = t.actor || "system";
      const session = t.sessionId || "";
      return { ...t, when, title, actor, session };
    });
    return out;
  }, [timeline]);

  // PEAKOPS_FIELD_STATUS_CANONICAL_V1
  // All incident-level readiness/stage rules live in one module:
  //   @/lib/workflow/fieldIncidentStatus
  // That module is the single source of truth for: the CTA label, the readiness
  // checklist, the flow-stage bar, the timing card, and the bottom-dock tiles.
  // Supervisor readiness is intentionally separate — see ReviewClient.tsx which
  // derives from job-level facts (reviewableJobs, selectedJobEvidenceCount, …).
  //
  // _hasApproved is computed here (not in the helper) because it is a job-level
  // fact owned by the supervisor pipeline. The helper only consumes its boolean
  // to decide whether the field stage is "review" vs "done".
  const _hasApproved = Array.isArray(jobs) && jobs.length > 0 && jobs.every((j: any) => {
    const rs = String(j?.reviewStatus || "").trim().toLowerCase();
    const st = String(j?.status || "").trim().toLowerCase();
    return rs === "approved" || st === "approved";
  });

  const _fieldStatus = useMemo(
    () => deriveFieldIncidentStatus({
      timeline: timeline as any[],
      evidence: evidence as any[],
      notesSavedLocal,
      arrivedLocal,
      allJobsApproved: !!_hasApproved,
    }),
    [timeline, evidence, notesSavedLocal, arrivedLocal, _hasApproved]
  );

  // Local aliases preserve every downstream binding that used the previous
  // inline variable names. Do NOT re-derive these inline — update the helper
  // module and the new field shows up here automatically.
  const hasArrival = _fieldStatus.hasArrival;
  const hasEvidence = _fieldStatus.hasEvidence;
  const hasNotes = _fieldStatus.hasNotes;
  const isSubmitted = _fieldStatus.hasSubmitted;
  const isApproved = !!_hasApproved;
  const currentStage = _fieldStatus.currentStage;

  const _arrivalSec = _fieldStatus.arrivalSec;
  const _notesSec = _fieldStatus.notesSec;
  const _lastEvidenceSec = _fieldStatus.evidenceLatestSec;

  // Legacy prop names still referenced by NextBestAction / checklist / dock /
  // submit button. Kept as aliases until those consumers are refactored to
  // accept a single status object.
  const _hasEvidence = _fieldStatus.hasEvidence;
  const _hasNotes = _fieldStatus.hasNotes;
  const _hasSubmitted = _fieldStatus.hasSubmitted;
  const _hasSession = _fieldStatus.hasSessionTimeline;
  const _evidenceN = _fieldStatus.evidenceCount;

  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
  // Single canonical UI state for the field page. Everything that
  // varies by lifecycle position — header pill, FlowStageBar stage,
  // NBA inputs, action visibility, banner copy — derives from this
  // object. Adding a new lifecycle-aware UI element later means
  // reading from `fieldJobUiState`, not re-deriving from raw flags.
  const fieldJobUiState = useMemo(
    () => buildJobUiState({
      status: incidentStatus,
      hasArrival,
      hasSubmitted: _hasSubmitted,
      allTasksApproved: !!_hasApproved,
      anyRejected: Array.isArray(jobs) && jobs.some((j: any) => {
        const s = String(j?.status || "").toLowerCase();
        const rs = String(j?.reviewStatus || "").toLowerCase();
        return s === "rejected" || rs === "rejected";
      }),
      evidenceCount: _evidenceN,
      hasNotes: _hasNotes,
    }),
    [incidentStatus, hasArrival, _hasSubmitted, _hasApproved, jobs, _evidenceN, _hasNotes],
  );

  // Prefer the timeline timestamp; if it's missing but we know arrival happened
  // (arrivedLocal sticky flag, or evidence exists), render a neutral "Arrived"
  // instead of "Not started" so the timing card agrees with the CTA/checklist.
  const _arrivalAgo = _arrivalSec
    ? fmtAgo(_arrivalSec)
    : hasArrival
      ? "Arrived"
      : "—";
  const _evidenceAgo = _lastEvidenceSec
    ? fmtAgo(_lastEvidenceSec)
    : hasEvidence ? "Captured" : "—";
  // If notes have been saved (sticky or timeline event) but no timestamp is
  // available (e.g., sticky only, backend event missing), show a soft "Saved"
  // so the timing card never disagrees with the checklist.
  const _notesAgo = _notesSec
    ? fmtAgo(_notesSec)
    : hasNotes ? "Saved" : "—";

  return (
    invalidIncidentRoute ? (
      <main style={{ minHeight: "100vh", background: "#050505", color: "#f5f5f5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#C8A84E", marginBottom: 16 }}>PEAKOPS</div>
        <div style={{ maxWidth: 400, width: "100%", border: "1px solid #1c1c1c", background: "#0b0b0b", borderRadius: 8, padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5" }}>Invalid incident URL</div>
          <div style={{ fontSize: 12, color: "#6f6f6f", marginTop: 8, lineHeight: 1.5 }}>
            This page requires a valid incident ID in the URL.
          </div>
          <div style={{ fontSize: 11, color: "#6f6f6f", marginTop: 12, fontFamily: "ui-monospace, monospace" }}>
            /incidents/inc_demo
          </div>
        </div>
      </main>
    ) : incidentNotFound ? (
      // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
      // Clean customer-facing empty state when getIncidentV1 returns
      // 404 (deleted, never existed, or not accessible). Replaces the
      // raw debug panel with a calm card. Dev-only collapsible
      // preserves diagnostic detail for engineers.
      <main style={{ minHeight: "100vh", background: "#050505", color: "#f5f5f5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#C8A84E", marginBottom: 16 }}>PEAKOPS</div>
        <div style={{ maxWidth: 440, width: "100%", border: "1px solid #1c1c1c", background: "#0b0b0b", borderRadius: 8, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#6f6f6f", textTransform: "uppercase" as const }}>Not found</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginTop: 6 }}>Job not found</div>
          <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 6, lineHeight: 1.5 }}>
            This incident may have been deleted, moved, or you may not have access.
          </div>
          <button
            type="button"
            onClick={() => router.push(`/incidents${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`)}
            style={{
              marginTop: 16,
              padding: "10px 18px",
              borderRadius: 8,
              border: "1px solid #1c1c1c",
              background: "transparent",
              color: "#b3b3b3",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Back to incidents
          </button>
          {/* PEAKOPS_NOT_FOUND_DEV_GATE_V1 (2026-04-30)
              Strictly ?dev=1. Customer-facing 404 stays clean even
              in local dev unless the tester opts in. */}
          {devMode ? (
            <details style={{ marginTop: 18, fontSize: 10, color: "#6f6f6f", textAlign: "left" }}>
              <summary style={{ cursor: "pointer" }}>Technical details (dev only)</summary>
              <div style={{ marginTop: 6, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                <div>incidentId: {incidentId}</div>
                <div>orgId: {orgId || "(none)"}</div>
                {refreshError?.endpoint ? <div>endpoint: {refreshError.endpoint}</div> : null}
                {refreshError?.status ? <div>status: {refreshError.status}</div> : null}
                {refreshError?.message ? <div>message: {refreshError.message}</div> : null}
              </div>
            </details>
          ) : null}
        </div>
      </main>
    ) : !hasUsableOrgId(orgId) ? (
      // PEAKOPS_NAV_ORGID_GUARD: URL is missing ?orgId=. Render a blocking
      // state instead of live CTAs (Mark arrived / + Evidence / Go to Review),
      // which would otherwise fire against an empty orgId and either fail the
      // backend ("orgId required") or produce fake-empty data.
      <main style={{ minHeight: "100vh", background: "#050505", color: "#f5f5f5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#C8A84E", marginBottom: 16 }}>PEAKOPS</div>
        <div style={{ maxWidth: 440, width: "100%", border: "1px solid #1c1c1c", background: "#0b0b0b", borderRadius: 8, padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5" }}>Missing orgId in URL</div>
          <div style={{ fontSize: 12, color: "#6f6f6f", marginTop: 8, lineHeight: 1.5 }}>
            This page needs <span style={{ color: "#C8A84E", fontFamily: "ui-monospace, monospace" }}>?orgId=&lt;your-org&gt;</span> to load incident data. Reload with the org appended to the URL.
          </div>
          <div style={{ fontSize: 11, color: "#6f6f6f", marginTop: 12, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
            /incidents/{String(incidentId || "").trim() || "<id>"}?orgId=&lt;your-org&gt;
          </div>
        </div>
      </main>
    ) : (
    <main
      className="min-h-screen text-white"
      style={{ background: "#050505" }}
      onPointerDownCapture={(ev) => {
        if (process.env.NODE_ENV === "production") return;
        try {
          const tgt = ev.target as HTMLElement | null;
          const nativeAny = (ev as any)?.nativeEvent;
          const path = (nativeAny?.composedPath?.() || [])
            .slice(0, 10)
            .map((n: any) => {
              const tag = String(n?.tagName || n?.nodeName || "").toLowerCase();
              const id = String(n?.id || "");
              const cls = String(n?.className || "").trim().replace(/\s+/g, ".").slice(0, 60);
              return `${tag}${id ? `#${id}` : ""}${cls ? `.${cls}` : ""}`;
            });
          console.warn("[add-evidence-capture]", {
            target: `${String(tgt?.tagName || "").toLowerCase()}${tgt?.id ? `#${tgt.id}` : ""}`,
            path,
            ts: Date.now(),
          });
        } catch {}
      }}
    >
      {/* PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
          Stage derived from canonical UI state. The `currentStage`
          local from the older fieldStatus helper still exists for
          legacy bottom-dock reads, but the visible stepper now
          tracks the same `displayState` the header pill uses. */}
      <FlowStageBar stage={fieldJobUiState.stage} />
      {/* PEAKOPS_INCIDENT_HEADER_V3 (2026-04-30)
          Header now mirrors the cleaned Supervisor Review style:
          - Single "← Jobs" back link on the left.
          - Subtle "FIELD JOB" eyebrow + job title.
          - Status pill (color-coded by lifecycle truth) + updated
            timestamp on the subtitle row.
          - Right side keeps Supervisor Review (gold) + Summary as
            compact ghost utilities. Mission Control link folded into
            "← Jobs" — one-tap return.
          - Dev chrome (ROLE pill, identity strip, QA chip, demo
            buttons) all gated on devMode so customers see a clean
            premium header. */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1c1c1c", position: "sticky", top: 0, background: "rgba(5,5,5,0.95)", backdropFilter: "blur(8px)", zIndex: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
            <button
              type="button"
              style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", flexShrink: 0, marginTop: 2 }}
              title="Back to Jobs"
              onClick={() => router.push(`/incidents?orgId=${encodeURIComponent(String(orgId || ""))}`)}
            >
              ← Jobs
            </button>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#6f6f6f", textTransform: "uppercase" as const }}>Field Job</span>
                {/* PEAKOPS_HIDE_ROLE_BADGE_V1 (2026-04-30)
                    ROLE pill strictly gated on ?dev=1 + NODE_ENV !== production. */}
                {devMode && authClaims?.role ? (
                  <span
                    style={{
                      padding: "1px 6px",
                      borderRadius: 3,
                      fontWeight: 600,
                      fontSize: 9,
                      border: "1px dashed rgba(200,168,78,0.35)",
                      background: "rgba(200,168,78,0.06)",
                      color: "#C8A84E",
                    }}
                    title="Current Firebase Auth role claim (dev only)"
                  >
                    ROLE: {String(authClaims.role).toUpperCase()}
                  </span>
                ) : null}
              </div>
              {/* PEAKOPS_HEADER_TITLE_V2 (2026-04-28)
                  Routed through the shared displayIncidentTitle helper
                  so the field, review, summary, and add-evidence pages
                  all render the same label. */}
              <div
                style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", marginTop: 2 }}
                title={incidentId}
              >
                {displayIncidentTitle(incidentId, { title: incidentTitle }, jobs)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                {(() => {
                  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
                  // Header pill reads off the page-level
                  // fieldJobUiState. FlowStageBar (above) and NBA
                  // (below) read off the same object — they cannot
                  // disagree about which lifecycle position the user
                  // is in.
                  const ds = fieldJobUiState.displayState;
                  // Compact pill copy — header has limited width, so
                  // "Awaiting Supervisor Review" abbreviates to
                  // "Awaiting Review" here only. Other surfaces keep
                  // the full label.
                  const label = ds === "Awaiting Supervisor Review" ? "Awaiting Review" : ds;
                  const tone =
                    ds === "Closed" ? { bg: "#0b0b0b", border: "#1c1c1c", color: "#6f6f6f" } :
                    ds === "Approved" ? { bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.30)", color: "#22c55e" } :
                    ds === "Awaiting Supervisor Review" ? { bg: "rgba(200,168,78,0.08)", border: "rgba(200,168,78,0.30)", color: "#C8A84E" } :
                    ds === "Sent Back" ? { bg: "rgba(220,60,60,0.08)", border: "rgba(220,60,60,0.30)", color: "#fca5a5" } :
                    ds === "In Progress" ? { bg: "rgba(34,197,94,0.06)", border: "rgba(34,197,94,0.20)", color: "#22c55e" } :
                    { bg: "rgba(34,197,94,0.06)", border: "rgba(34,197,94,0.20)", color: "#22c55e" };
                  return (
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        border: `1px solid ${tone.border}`,
                        background: tone.bg,
                        color: tone.color,
                      }}
                    >
                      {label}
                    </span>
                  );
                })()}
                {incidentUpdatedAtSec ? (
                  <span style={{ fontSize: 10, color: "#6f6f6f" }}>Updated {fmtAgo(incidentUpdatedAtSec)} ago</span>
                ) : null}
              </div>
              {/* PEAKOPS_IDENTITY_BAR_V2 (2026-04-30)
                  Identity strip is dev-only. */}
              {devMode && authUser?.email ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10, color: "#6f6f6f", flexWrap: "wrap" }}>
                  <span>Signed in as</span>
                  <span style={{ color: "#b3b3b3", fontFamily: "ui-monospace, monospace" }}>{authUser.email}</span>
                  {authClaims.role ? (
                    <>
                      <span>·</span>
                      <span style={{ color: "#C8A84E", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" as const }}>
                        {authClaims.role}
                      </span>
                    </>
                  ) : null}
                  <span>·</span>
                  <span style={{ color: "#b3b3b3", fontFamily: "ui-monospace, monospace" }}>{orgId || "no org"}</span>
                </div>
              ) : null}
              {/* PEAKOPS_QA_AUTH_DEBUG_V1 mount (incident page) — gated on devMode */}
              {devMode ? (
                <div style={{ marginTop: 6 }}>
                  <QaAuthDebugChip />
                </div>
              ) : null}
              {/* Demo-mode reset / seed buttons stay gated on isDemoMode */}
              {isDemoMode ? (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={{ padding: "1px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }}
                    onClick={() => { void resetDemoNow(); }}
                    title="Fully reset demo data and reload clean"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    style={{ padding: "1px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }}
                    onClick={async () => {
                      try {
                        toast("Seeding demo evidence…", 1500);

                        const res = await fetch("/api/dev/seed-demo-evidence", {
                          method: "POST",
                          cache: "no-store",
                        });

                        const out = await res.json().catch(() => ({}));

                        if (!res.ok || !out?.ok) {
                          throw new Error(out?.error || "seed-demo-evidence failed");
                        }

                        toast(`Seeded ${out.count} demo evidence`, 2200);
                        window.location.reload();
                      } catch (e: any) {
                        toast("Seed failed: " + (e?.message || String(e)), 3500);
                        console.error(e);
                      }
                    }}
                    title="Seed 5 clean demo evidence items for testing"
                  >
                    Seed demo evidence
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)", color: "#C8A84E" }}
              title="Open Supervisor Review"
              onClick={() => {
                const id = String(incidentId || "");
                if (!id || id.includes("${")) return;
                router.push(reviewPath(id, orgId));
              }}
            >
              Supervisor Review
            </button>
            <button
              type="button"
              style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3" }}
              onClick={() => { try { router.push(summaryPath(incidentId, orgId)); } catch {} }}
              title="Open job summary"
            >
              Summary
            </button>
          </div>
        </div>

        {/* PEAKOPS_UX_TOAST_RENDER_V1
            Single source-of-truth toast renderer. The legacy ZIP_TOAST
            duplicate was removed in PEAKOPS_TOAST_DEDUP_V1 — do not
            reintroduce a second renderer that reads `toastMsg`, or
            users will see overlapping toast bars. data-toast-id is
            provided so QA can assert visibility with a single
            selector. */}
        {toastMsg ? (
          <div
            data-toast-id="peakops-toast"
            role="status"
            aria-live="polite"
            style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", top: 72, zIndex: 50, padding: "8px 14px", borderRadius: 6, background: "rgba(11,11,11,0.95)", border: "1px solid #1c1c1c", fontSize: 12, color: "#b3b3b3", backdropFilter: "blur(8px)", pointerEvents: "none" }}
          >
            {toastMsg}
          </div>
        ) : null}

        {/* PEAKOPS_NEXT_BEST_ACTION_V2 (2026-04-27)
            Now sourced from the shared deriveNextAction helper at
            src/lib/workflow/nextBestAction.ts so the logic is shared
            with SummaryClient and the priority order (esp. the
            unassigned-evidence blocker) is enforced in one place. */}
        {(() => {
          const safeJobs = Array.isArray(jobs) ? jobs : [];
          const safeEvidence = Array.isArray(evidence) ? evidence : [];
          const role = String(authClaims?.role || "").toLowerCase();

          const evidenceWithJob = safeEvidence.filter((ev: any) => {
            const top = String(ev?.jobId || "").trim();
            const nested = String(ev?.evidence?.jobId || "").trim();
            return !!(top || nested);
          });
          const unassignedEvidenceCount = safeEvidence.length - evidenceWithJob.length;
          const anyWorkItemComplete = safeJobs.some((j: any) => {
            const s = normalizeJobStatus(j?.status);
            return s === "complete" || s === "review" || s === "approved";
          });
          const hasReviewableWorkItem = safeJobs.some((j: any) => {
            const s = normalizeJobStatus(j?.status);
            return s === "complete" || s === "review";
          });

          // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
          // NBA inputs read the same lifecycle facts that built
          // fieldJobUiState above. The closed/approved/submitted
          // gates are sourced from fieldJobUiState.displayState so
          // they cannot drift away from the header pill or stepper.
          let action = deriveNextAction({
            hasArrival,
            evidenceCount: safeEvidence.length,
            unassignedEvidenceCount,
            workItemCount: safeJobs.length,
            anyWorkItemComplete,
            allWorkItemsApproved: fieldJobUiState.displayState === "Approved" || fieldJobUiState.displayState === "Closed" || !!_hasApproved,
            hasReviewableWorkItem,
            hasSubmitted: fieldJobUiState.displayState === "Awaiting Supervisor Review" || !!_hasSubmitted,
            isClosed: fieldJobUiState.displayState === "Closed",
            packetReady,
            role,
            currentWorkItemId: String(currentJobId || ""),
            // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
            // Drives the new "Add a note or skip" gate between
            // task-complete and submit. Either path satisfies it:
            // a real note saved, or an explicit bypass.
            hasNotes: !!_hasNotes,
            notesBypassed: !!notesBypassedLocal,
          });

          // PEAKOPS_UI_STATE_NBA_OVERRIDE_V1 (2026-05-05)
          // The shared deriveNextAction helper checks
          // `evidenceCount === 0` BEFORE its closed/approved
          // branches, so an Approved/Awaiting/Closed job with no
          // evidence loaded yet still falls into "Add Photos". That
          // contradicts the canonical lifecycle the rest of the page
          // displays (Approved header, Closed stepper). Override the
          // NBA result whenever the canonical state is past
          // In Progress so the field-page primary action always
          // matches the header pill.
          //
          // Approved → "View Summary" (read-only post-approval; the
          //            actual close action lives on /review).
          // Closed   → "Open Report".
          // Awaiting → "View Supervisor Review".
          // Sent Back → falls through to deriveNextAction (work resumes).
          //
          // No mutation of action enum types — we cast a fresh
          // object that matches the NextAction shape the renderer
          // already consumes.
          const _canonical = fieldJobUiState.displayState;
          if (_canonical === "Closed") {
            action = {
              state: "download_report",
              title: "Report ready",
              helper: "This job is closed. Open the report to download or share it.",
              buttonLabel: "Open Report",
              primaryAction: "open_report",
              enabled: true,
              tone: "success",
            };
          } else if (_canonical === "Approved") {
            action = {
              state: "waiting",
              title: "Approved — ready to close",
              helper: "Supervisor approval complete. Close the job from the Supervisor Review page to generate the report.",
              buttonLabel: "Open Supervisor Review",
              primaryAction: "review",
              enabled: true,
              tone: "primary",
            };
          } else if (_canonical === "Awaiting Supervisor Review") {
            action = {
              state: "review",
              title: "Sent to supervisor",
              helper: "Your work is with the supervisor for review.",
              buttonLabel: "Open Supervisor Review",
              primaryAction: "review",
              enabled: true,
              tone: "primary",
            };
          }

          // Bind the shared discriminator to local handlers. Each key
          // corresponds to exactly one user-facing intent; if a new
          // intent is added to the helper, add the matching handler
          // here (TS will catch unhandled keys via `never`).
          const runAction = (key: NextActionKey) => {
            switch (key) {
              case "mark_arrived": try { markArrived(); } catch {} return;
              case "add_evidence": try { goAddEvidence(); } catch {} return;
              case "create_work_item": setTab("tasks"); return;
              case "attach_evidence": {
                // PEAKOPS_NBA_SMART_ATTACH_V1 (2026-04-28)
                // If exactly one task exists, attach all unassigned
                // evidence to it directly — saves the user a tab switch
                // + N clicks. If 0 or 2+ tasks exist, fall back
                // to the Evidence tab so the user picks per-item.
                if (safeJobs.length === 1) {
                  const target = safeJobs[0] as any;
                  const targetId = String(target?.id || target?.jobId || "").trim();
                  const unassigned = safeEvidence.filter((ev: any) => {
                    const top = String(ev?.jobId || "").trim();
                    const nested = String(ev?.evidence?.jobId || "").trim();
                    return !(top || nested);
                  });
                  if (targetId && unassigned.length > 0) {
                    (async () => {
                      for (const ev of unassigned) {
                        const eid = String((ev as any)?.id || "").trim();
                        if (!eid) continue;
                        try { await assignEvidenceJob(eid, targetId); } catch {}
                      }
                    })();
                    return;
                  }
                }
                setTab("evidence");
                return;
              }
              case "finish_work_item": try { markCurrentJobComplete(); } catch {} return;
              case "add_notes":
                try { router.push(notesPath(incidentId, orgId)); } catch {}
                return;
              case "bypass_notes":
                void bypassNotes();
                return;
              case "submit": void submitSession(); return;
              case "review": try { router.push(reviewPath(incidentId, orgId)); } catch {} return;
              case "approve_work":
              case "send_back":
                // /review-only actions; from the field page send the
                // user there.
                try { router.push(reviewPath(incidentId, orgId)); } catch {} return;
              case "close":
                // PEAKOPS_NBA_CONFIRM_CLOSE_V1 (2026-04-28)
                if (typeof window !== "undefined" &&
                    !window.confirm("Close this job? Field edits will be locked and the report can be generated.")) {
                  return;
                }
                void closeIncident();
                return;
              case "open_report":
              case "download_report":
                try { router.push(summaryPath(incidentId, orgId)); } catch {} return;
              case "back_to_incident": return; // no-op on incident page
              case "none": return;
            }
          };

          const primaryBg = !action.enabled
            ? "#101010"
            : action.tone === "success"
              ? "linear-gradient(180deg, #22c55e 0%, #15803d 100%)"
              : action.tone === "muted"
                ? "#101010"
                : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)";
          const primaryColor = !action.enabled
            ? "#6f6f6f"
            : action.tone === "success"
              ? "#050505"
              : action.tone === "muted"
                ? "#6f6f6f"
                : "#050505";
          const primaryBorder = action.enabled && action.tone !== "success" && action.tone !== "muted"
            ? "none"
            : "1px solid #1c1c1c";

          return (
            <section
              style={{
                marginTop: 12,
                borderRadius: 12,
                border: "1px solid #1c1c1c",
                background: "#0b0b0b",
                padding: "16px 18px",
                display: "flex",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.14em",
                    color: "#C8A84E",
                    textTransform: "uppercase" as const,
                  }}
                >
                  Next best action
                </div>
                <div style={{ marginTop: 4, fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
                  {action.title}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>
                  {action.helper}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                {action.secondaryLabel && action.secondaryAction ? (
                  <button
                    type="button"
                    onClick={() => runAction(action.secondaryAction!)}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: "1px solid #1c1c1c",
                      background: "transparent",
                      color: "#b3b3b3",
                    }}
                  >
                    {action.secondaryLabel}
                  </button>
                ) : null}
                {/* PEAKOPS_NBA_PASSIVE_STATE_V1 (2026-04-28)
                    primaryAction === "none" means the user has no
                    action available — render just the title/helper
                    block without a button or pill. tone === "muted"
                    with an action that's still meaningful (e.g.
                    Submitted with a "go to" affordance) keeps the
                    green ✓ pill. */}
                {action.primaryAction === "none" ? null : action.tone === "muted" && !action.enabled ? (
                  <span
                    style={{
                      padding: "10px 16px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase" as const,
                      border: "1px solid rgba(34,197,94,0.30)",
                      background: "rgba(34,197,94,0.08)",
                      color: "#86efac",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ✓ {action.buttonLabel}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={!action.enabled}
                    onClick={() => runAction(action.primaryAction)}
                    style={{
                      padding: "12px 22px",
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 800,
                      letterSpacing: "0.02em",
                      cursor: action.enabled ? "pointer" : "not-allowed",
                      border: primaryBorder,
                      background: primaryBg,
                      color: primaryColor,
                      boxShadow: action.enabled && action.tone !== "muted"
                        ? "0 2px 12px rgba(200,168,78,0.20)"
                        : "none",
                      transition: "background 120ms ease",
                    }}
                  >
                    {action.buttonLabel}
                  </button>
                )}
              </div>
            </section>
          );
        })()}

        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 4 }}>
          {(["overview", "timeline", "evidence", "tasks"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              style={{
                padding: "5px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer",
                border: activeTab === tab ? "1px solid rgba(200,168,78,0.35)" : "1px solid #1a1a1a",
                background: activeTab === tab ? "rgba(200,168,78,0.1)" : "transparent",
                color: activeTab === tab ? "#C8A84E" : "#6f6f6f",
              }}
              onClick={() => setTab(tab)}
            >
              {tab === "overview" ? "Overview" : tab === "timeline" ? "Timeline" : tab === "evidence" ? "Photos" : "Tasks"}
            </button>
          ))}
          {/* PEAKOPS_SYNC_INDICATOR_V1 (2026-04-27)
              Small inline badge that surfaces in-flight refreshes instead
              of blanking the tab. The `loading` state was already wired
              by refresh() but never rendered, so users had no signal
              that data was updating — this fills that gap without
              touching the data-loading logic. */}
          {loading ? (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                color: "#6f6f6f",
                letterSpacing: "0.06em",
                textTransform: "uppercase" as const,
              }}
            >
              Refreshing…
            </span>
          ) : null}
        </div>

{/* PEAKOPS_ACTIVE_JOB_CARD_UI_V1 /
    PEAKOPS_UI_STATE_V2 (2026-05-05)
    Active Task panel is a field-action surface — it shouldn't
    appear once the job is past field hands (Awaiting Supervisor
    Review / Approved / Closed). Hides automatically when the
    canonical UI state has moved on. */}
{(fieldJobUiState.displayState === "Open" || fieldJobUiState.displayState === "In Progress" || fieldJobUiState.displayState === "Sent Back") ? (() => {
  try {
    const req = latestSupervisorRequest(timeline as any[]);
    const reqMsg = String(req?.message || "").trim();
    const reqJobId = String(req?.jobId || "").trim();
    const job = (jobs || []).find((j:any) => String(j?.id || j?.jobId || "") === String(activeJobId || "")) as any;
    const jobTitle = String(job?.title || "").trim();
    const jobStatus = String(job?.status || "").toLowerCase();
    const locked = isLockedJob(job);

    return (
      <div className="space-y-3 mt-3">
        {req && (reqMsg || reqJobId) ? (
          <div style={{ borderRadius: 8, border: "1px solid rgba(200,168,78,0.25)", background: "rgba(200,168,78,0.06)", padding: "10px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#C8A84E" }}>Update requested</div>
                <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 4, wordBreak: "break-word" }}>
                  {reqMsg ? reqMsg : "Supervisor requested an update."}
                </div>
                {reqJobId ? <div style={{ fontSize: 10, color: "#6f6f6f", marginTop: 2 }}>Task: {String(reqJobId).slice(-6)}</div> : null}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button type="button" style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", fontSize: 11, cursor: "pointer" }} onClick={() => { setTab("evidence"); }}>Photos</button>
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "#6f6f6f" }}>Active Task</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#f5f5f5", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {jobTitle ? jobTitle : (activeJobId ? `Task ${String(activeJobId).slice(-6)}` : "No active task yet")}
              </div>
              <div style={{ fontSize: 10, color: "#6f6f6f", marginTop: 2 }}>
                {activeJobId ? (
                  <>
                    {String(jobStatus || "n/a").toUpperCase()}
                    {locked ? <span style={{ color: "#22c55e", marginLeft: 6 }}>Approved</span> : null}
                  </>
                ) : (
                  "Photos you capture will save to this job and can be attached to a task later."
                )}
              </div>
            </div>
            {/* PEAKOPS_OVERVIEW_CTA_DEDUP_V3 (2026-04-30)
                The inline "+ Evidence" shortcut was removed in this
                pass — it duplicated the NBA card's primary CTA which
                is always the canonical place to "Add Photos". The
                "Open" navigation button stays because it routes to
                the task detail page (different action than NBA). */}
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {activeJobId ? (
                <button
                  type="button"
                  style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                  onClick={() => {
                    try {
                      const url = `/jobs/${encodeURIComponent(String(activeJobId||""))}?incidentId=${encodeURIComponent(String(incidentId||""))}&orgId=${encodeURIComponent(String(orgId||""))}`;
                      router.push(url);
                    } catch (e) { console.error(e); }
                  }}
                >
                  Open task
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  } catch (e) {
    return null;
  }
})() : null}


      </div>

      <div className={"p-3 " + (contextLockId ? "opacity-[0.94] transition-opacity" : "")} style={{ display: "grid", gap: 8 }}>

{/* Overview 2-column layout */}
{activeTab === "overview" ? (
  <>
    {/* PEAKOPS_GUIDED_WORKFLOW_REMOVED_V2 (2026-04-30)
        Removed in the IncidentClient cleanup pass. The FlowStageBar
        at the top of the page is now the single progress widget;
        the NBA card is the single primary action. The "How this
        incident gets reviewed" checklist duplicated both signals. */}
  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(200px, 2fr)", gap: 8, alignItems: "start", marginTop: 8 }}>
    {/* LEFT: Primary action */}
    <div style={{ display: "grid", gap: 8 }}>
      {/* PEAKOPS_INCIDENT_CLOSED_AFFORDANCE_V1 (2026-04-24)
          When an incident is closed, the "Submitted for review / waiting for
          supervisor approval" card is stale — review already happened. Show
          a confident "Incident closed" affordance with a Summary CTA instead.
          When the field has submitted but the incident isn't closed, keep
          the existing review-pending card. */}
      {/* PEAKOPS_OVERVIEW_CTA_DEMOTE_V1 (2026-04-27)
          The Next Best Action card above is now the single dominant
          gold primary CTA on the field page. The closed and
          submitted cards below stay (still useful as status context
          + a navigation shortcut), but their buttons demote from
          gold-gradient primary to a dark-bordered secondary so they
          don't visually compete with the NBA. */}
      {isClosed ? (
        <section style={{ borderRadius: 10, border: "1px solid rgba(34,197,94,0.30)", background: "rgba(34,197,94,0.06)", padding: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase" as const, color: "#22c55e" }}>Job closed</div>
          <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 4 }}>This job is finalized. Open the report to download or share it.</div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              style={{
                width: "100%",
                padding: "10px 0",
                borderRadius: 8,
                border: "1px solid #1c1c1c",
                background: "transparent",
                color: "#b3b3b3",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "0.02em",
                cursor: "pointer",
              }}
              onClick={() => { try { router.push(summaryPath(incidentId, orgId)); } catch {} }}
            >
              Open Report
            </button>
          </div>
        </section>
      ) : _hasSubmitted ? (
        <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#22c55e" }}>Sent to supervisor</div>
          <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 4 }}>
            {(String(authClaims?.role || "").toLowerCase() === "supervisor" ||
              String(authClaims?.role || "").toLowerCase() === "admin")
              ? "Session sent. Open Supervisor Review to approve."
              : "Session sent. Waiting for supervisor approval."}
          </div>
          {/* PEAKOPS_FIELD_REVIEW_GATE_V1 (2026-04-28)
              Field role doesn't get a "Go to Review" link from here —
              the NBA card above already shows the calm waiting pill,
              and field users have no actions to take in /review. */}
          {(String(authClaims?.role || "").toLowerCase() === "supervisor" ||
            String(authClaims?.role || "").toLowerCase() === "admin") ? (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                style={{
                  width: "100%",
                  padding: "10px 0",
                  borderRadius: 8,
                  border: "1px solid #1c1c1c",
                  background: "transparent",
                  color: "#b3b3b3",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  cursor: "pointer",
                }}
                onClick={() => { try { router.push(reviewPath(incidentId, orgId)); } catch {} }}
              >
                Open Supervisor Review
              </button>
            </div>
          ) : null}
        </section>
      ) : (
        /* PEAKOPS_OVERVIEW_NBA_DEDUP_V2 (2026-04-30)
            The in-tab <NextBestAction /> component duplicated the
            top-level NBA card at the top of the page. Removed —
            the top-level card is now the single primary action
            surface for active jobs. The closed / sent-to-supervisor
            branches above still render (status affirmation, not
            duplicate action). */
        null
      )}

      {reqUpdateText ? (
        <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#101010", padding: "10px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#C8A84E" }}>Update requested</span>
            <button type="button" style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }} onClick={() => { clearReqUpdate(); }}>Dismiss</button>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#b3b3b3", lineHeight: 1.4 }}>{reqUpdateText}</div>
        </div>
      ) : null}

      {/* PEAKOPS_NOTES_PROMPT_V2 (2026-04-28)
          Subtle, non-blocking nudge surfaced before submit when the
          field tech has captured evidence + a complete task but has
          not added a note. "Skip for now" persists in localStorage
          per-incident so the prompt stops nagging once dismissed.
          Auto-dismisses if notes are saved or the field session is
          submitted. */}
      {(() => {
        if (isClosed || !_hasEvidence || _hasNotes || _hasSubmitted) return null;
        if (typeof window === "undefined") return null;
        const skipKey = `peakops_notes_prompt_skipped_${String(incidentId || "")}`;
        let skipped = false;
        try { skipped = window.localStorage.getItem(skipKey) === "1"; } catch {}
        if (skipped) return null;
        return (
          <div
            style={{
              borderRadius: 8,
              border: "1px dashed #1c1c1c",
              background: "#0b0b0b",
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0, flex: "1 1 220px" }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase" as const,
                  color: "#6f6f6f",
                }}
              >
                Optional
              </div>
              <div style={{ fontSize: 13, color: "#f5f5f5", marginTop: 2, fontWeight: 600 }}>
                Anything to tell your supervisor?
              </div>
              <div style={{ fontSize: 11, color: "#6f6f6f", marginTop: 2, lineHeight: 1.4 }}>
                Add a quick note about what happened, what changed, or what to watch.
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 500,
                  border: "1px solid #1c1c1c",
                  background: "transparent",
                  color: "#6f6f6f",
                  cursor: "pointer",
                }}
                onClick={() => {
                  try { window.localStorage.setItem(skipKey, "1"); } catch {}
                  // Force a re-render via a benign state nudge — toast
                  // suffices and keeps this self-contained without new
                  // state hooks.
                  toast("Reminder dismissed.", 1200);
                }}
              >
                Skip for now
              </button>
              <button
                type="button"
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  border: "1px solid #1c1c1c",
                  background: "transparent",
                  color: "#b3b3b3",
                  cursor: "pointer",
                }}
                onClick={() => { try { router.push(notesPath(incidentId, orgId)); } catch {} }}
              >
                Add Note
              </button>
            </div>
          </div>
        );
      })()}
    </div>

    {/* RIGHT: Status + Timers + Sync */}
    <div style={{ display: "grid", gap: 8 }}>
      {/* Timers */}
      {/* PEAKOPS_FIELD_TIMING_FINAL_STATE_V1 (2026-05-05)
          Field Timing on Approved/Closed jobs collapses into a quiet
          "Field actions are locked" affirmation. The empty-state
          "No photos / No notes" yellow callouts read as warnings,
          which is wrong for a record that's already past field
          hands — they were the exact "Approved + No photos" buyer
          contradiction QA flagged. Active states still show the
          full timing grid. */}
      {fieldJobUiState.displayState === "Closed" || fieldJobUiState.displayState === "Approved" ? (
        <div style={{ borderRadius: 8, border: "1px solid rgba(34,197,94,0.20)", background: "rgba(34,197,94,0.04)", padding: "12px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "#86efac", marginBottom: 6 }}>
            {fieldJobUiState.displayState === "Closed" ? "Job closed" : "Job approved"}
          </div>
          <div style={{ fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>
            {fieldJobUiState.displayState === "Closed"
              ? "Field actions are locked. The audit-ready report is available on the Summary page."
              : "Field actions are locked. Final close happens on the Supervisor Review page."}
          </div>
        </div>
      ) : (
        <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "#6f6f6f", marginBottom: 8 }}>Field Timing</div>
          <div style={{ display: "grid", gap: 0 }}>
            {[
              { label: "Arrival", value: _arrivalAgo, empty: _arrivalAgo === "—", emptyText: "Not started" },
              { label: "Photos", value: _evidenceAgo, empty: _evidenceAgo === "—", emptyText: "No photos" },
              { label: "Notes", value: _notesAgo, empty: _notesAgo === "—", emptyText: "No notes" },
            ].map((t, i) => (
              <div key={t.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: i < 2 ? "1px solid #1c1c1c" : "none" }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "#b3b3b3" }}>{t.label}</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: t.empty ? "#C8A84E" : "#f5f5f5" }}>{t.empty ? t.emptyText : t.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sync state */}
      {refreshError ? (
        <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", overflow: "hidden", display: "flex" }}>
          <div style={{ width: 3, flexShrink: 0, background: "rgba(220,60,60,0.4)" }} />
          <div style={{ flex: 1, padding: "8px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#b3b3b3" }}>
                {/* PEAKOPS_FRIENDLY_SYNC_ERROR_V1 (2026-04-27)
                    Customer-facing soft copy. Raw failure remains in
                    the collapsible Details for support diagnosis. */}
                We had trouble refreshing — your last loaded data is still visible.
              </span>
              {process.env.NODE_ENV !== "production" && (functionsBaseIsLocal || isDemoMode) ? (
                <button type="button" style={{ padding: "2px 6px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }} onClick={() => { clearRememberedFunctionsBase(); location.reload(); }}>Retry</button>
              ) : null}
            </div>
            {/* PEAKOPS_DEV_GATE_TECH_DETAILS_V1 (2026-04-30)
                Technical details (endpoint, status, raw message) are
                engineering chrome. Gated on devMode so the operator
                sees only the friendly copy above. */}
            {devMode ? (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", fontSize: 9, color: "#6f6f6f" }}>Technical details</summary>
                <div style={{ marginTop: 4, fontSize: 9, color: "#6f6f6f", wordBreak: "break-all" }}>
                  {refreshError.message}
                  {refreshError.endpoint ? <div>endpoint: {refreshError.endpoint}</div> : null}
                  {refreshError.status ? <div>status: {refreshError.status}</div> : null}
                </div>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  </div>
  </>
) : null}

{/* Non-overview content continues below */}
{activeTab !== "overview" && refreshError ? (
  <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "8px 12px", fontSize: 10, color: "#b3b3b3" }}>
    We had trouble refreshing. Your last loaded data is still visible.
  </div>
) : null}

{/* Quick actions */}
        {activeTab === "evidence" ? (
        <section ref={myJobSectionRef} style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <h2 id="evidence" style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#f5f5f5" }}>Photos</h2>
      <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)", lineHeight: 1.6 }}>
        {evidence.length} {evidence.length === 1 ? "item" : "items"}
      </span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {/* PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
          Add Photo gated on fieldJobUiState.canAddPhotos so an
          approved or awaiting-review job can't take new photos —
          previously only `isClosed` blocked the action. */}
      <button type="button" style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #1c1c1c", background: "#101010", color: !fieldJobUiState.canAddPhotos ? "#6f6f6f" : "#b3b3b3", fontSize: 11, fontWeight: 600, letterSpacing: "0.02em", cursor: !fieldJobUiState.canAddPhotos ? "not-allowed" : "pointer", opacity: !fieldJobUiState.canAddPhotos ? 0.5 : 1 }} disabled={!fieldJobUiState.canAddPhotos} onClick={() => { try { goAddEvidence(); } catch {} }}>+ Add photo</button>
      {devMode ? (
        <details style={{ display: "inline" }}>
          <summary style={{ cursor: "pointer", fontSize: 9, color: "#6f6f6f", padding: "2px 6px" }}>Dev</summary>
          <div style={{ position: "absolute", zIndex: 20, background: "#0b0b0b", border: "1px solid #1c1c1c", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
            <button type="button" style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "transparent", color: "#6f6f6f", fontSize: 9, cursor: "pointer", textAlign: "left" }} onClick={() => refreshVisibleThumbsDebounced()}>Refresh thumbs</button>
            <button type="button" style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "transparent", color: "#6f6f6f", fontSize: 9, cursor: "pointer", textAlign: "left" }} onClick={() => forceRemintVisibleThumbs()}>Force remint</button>
            <button type="button" style={{ padding: "3px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "transparent", color: "#6f6f6f", fontSize: 9, cursor: "pointer", textAlign: "left" }} onClick={() => setThumbDebugOverlay((v) => !v)}>{thumbDebugOverlay ? "Hide debug" : "Show debug"}</button>
          </div>
        </details>
      ) : null}
    </div>
  </div>

  {evidence.length === 0 ? (
    <div style={{ marginTop: 14, padding: "20px 8px 10px", textAlign: "center" }}>
      <div style={{ width: 44, height: 44, margin: "0 auto 12px", borderRadius: 10, border: "1px solid #1c1c1c", background: "#050505", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="#6f6f6f" strokeWidth="1.5"/><circle cx="8.5" cy="9" r="1.5" fill="#6f6f6f"/><path d="M3 16l5-5 3 3 4-5 6 7" stroke="#6f6f6f" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5" }}>No photos yet</div>
      <div style={{ marginTop: 4, fontSize: 12, color: "#6f6f6f", lineHeight: 1.5, maxWidth: 320, marginLeft: "auto", marginRight: "auto" }}>
        Add photos to show what happened on site.
      </div>
      {/* PEAKOPS_PRIMARY_CTA_DEDUP_V1 (2026-04-29)
          Demoted to secondary (gray) so the Next Best Action card stays
          the only yellow CTA on the screen. The same action is exposed
          there as "Add Evidence" when evidence is empty. */}
      <button
        type="button"
        style={{
          marginTop: 14,
          padding: "12px 22px",
          borderRadius: 8,
          border: "1px solid #1c1c1c",
          background: "#101010",
          color: !fieldJobUiState.canAddPhotos ? "#6f6f6f" : "#b3b3b3",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "0.02em",
          cursor: !fieldJobUiState.canAddPhotos ? "not-allowed" : "pointer",
        }}
        disabled={!fieldJobUiState.canAddPhotos}
        onClick={() => { try { goAddEvidence(); } catch {} }}
      >
        + Add Photo
      </button>
      {/* PEAKOPS_UI_STATE_ORCHESTRATION_V2 (2026-05-05)
          Empty-state caption follows canonical UI state. Approved
          and Awaiting Review now read "this job no longer accepts
          photos" instead of looking like an active capture surface. */}
      {fieldJobUiState.displayState === "Closed" ? (
        <div style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f" }}>
          Job is closed — no new photos can be added.
        </div>
      ) : fieldJobUiState.displayState === "Approved" ? (
        <div style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f" }}>
          Job is approved — no further photos accepted.
        </div>
      ) : fieldJobUiState.displayState === "Awaiting Supervisor Review" ? (
        <div style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f" }}>
          Job is with the supervisor for review.
        </div>
      ) : !hasActiveFieldJobs ? (
        <div style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f", maxWidth: 320, marginLeft: "auto", marginRight: "auto", lineHeight: 1.5 }}>
          Photos save to this job — you can attach them to a task from the Tasks tab any time.
        </div>
      ) : null}
    </div>
  ) : (
  <>
  {(() => {
    const total = evidence.length;
    const labeled = evidence.filter((e: any) => Array.isArray(e?.labels) && e.labels.length > 0).length;
    const assigned = evidence.filter((e: any) => !!getLinkedJobId(e)).length;
    const unlabeled = total - labeled;
    const unassigned = total - assigned;
    const chipStyle = (complete: boolean): React.CSSProperties => ({
      fontSize: 10, fontWeight: 600, letterSpacing: "0.02em",
      color: complete ? "#22c55e" : "#b3b3b3",
      padding: "3px 9px", borderRadius: 999,
      background: "#050505",
      border: complete ? "1px solid rgba(34,197,94,0.3)" : "1px solid #1c1c1c",
    });
    const ready = total > 0 && unlabeled === 0 && unassigned === 0;
    const needsParts: string[] = [];
    if (unlabeled > 0) needsParts.push(`${unlabeled} unlabeled`);
    if (unassigned > 0) needsParts.push(`${unassigned} not yet attached to a task`);
    return (
      <>
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={chipStyle(false)}>{total} captured</span>
          <span style={chipStyle(total > 0 && labeled === total)}>{labeled}/{total} labeled</span>
          <span style={chipStyle(total > 0 && assigned === total)}>{assigned}/{total} attached to task</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 500, color: ready ? "#22c55e" : "#b3b3b3" }}>
          {ready ? "✓ Ready for review" : <>Needs: <span style={{ color: "#f5f5f5" }}>{needsParts.join(", ")}</span></>}
        </div>
        {/* PEAKOPS_EVIDENCE_ATTACH_HINT_V1 (2026-04-27)
            Customer-facing nudge that turns the gold-dot signal into a
            discoverable action. Only renders when at least one item
            still needs attachment AND there's at least one task
            available to attach to. If no task exists, route the
            user to create one first. */}
        {unassigned > 0 ? (
          (Array.isArray(jobs) && jobs.length > 0) ? (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid rgba(200,168,78,0.30)",
                background: "rgba(200,168,78,0.06)",
                color: "#C8A84E",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              ⚠ {unassigned} evidence item{unassigned === 1 ? " is" : "s are"} not attached to a task yet.{" "}
              <span style={{ color: "#b3b3b3" }}>
                Tap an item with the gold dot to attach it.
              </span>
            </div>
          ) : (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid rgba(200,168,78,0.30)",
                background: "rgba(200,168,78,0.06)",
                color: "#C8A84E",
                fontSize: 11,
                lineHeight: 1.5,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                ⚠ Evidence cannot be reviewed until it is attached to a task.
              </span>
              <button
                type="button"
                onClick={() => setTab("tasks")}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 600,
                  border: "1px solid #1c1c1c",
                  background: "#101010",
                  color: "#b3b3b3",
                  cursor: "pointer",
                }}
              >
                Create Task →
              </button>
            </div>
          )
        ) : null}
      </>
    );
  })()}
  <div style={{ marginTop: 8, marginLeft: -4, marginRight: -4, overflowX: "auto" }} id="evidenceScroller">
    <div className="flex gap-2 snap-x snap-mandatory" style={{ padding: "0 4px" }}>
      {(() => {
        const list = (evidence || [])
          .filter((ev:any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath || "").includes("demo_placeholder"));
        const maxShow = 12;
        const shown = list.slice(0, maxShow);
        return (
          <>
            {shown.map((ev:any) => {
              const u = thumbUrl[ev.id];
              const labels = (ev.labels || []).map(normLabel);
              const selected = selectedEvidenceId === ev.id;
              const hasLabels = Array.isArray(ev?.labels) && ev.labels.length > 0;
              const hasJob = !!getLinkedJobId(ev);
              const converting = isConvertingHeic(ev as EvidenceDoc);
              const convStatus = String((ev as any)?.file?.conversionStatus || "").toLowerCase();
              const uploadMissing = convStatus === "source_missing";
              const conversionFailed = convStatus === "failed";
              const conversionNoPreview = isHeicEvidence(ev as EvidenceDoc) && (convStatus === "n/a" || convStatus === "failed") && !String((ev as any)?.file?.thumbPath || "").trim() && !String((ev as any)?.file?.previewPath || "").trim();
              const conversionError = String((ev as any)?.file?.conversionError || "").trim();

              return (
                <button
                  key={ev.id}
                  data-ev-id={ev.id}
                  className={
                    "snap-start min-w-[132px] w-[132px] sm:min-w-[148px] sm:w-[148px] aspect-[4/3] relative rounded-lg overflow-hidden border transition " +
                    (selected ? "border-[#C8A84E] border-2 ring-2 ring-[#C8A84E]/30 shadow-[0_0_0_1px_rgba(200,168,78,0.2),0_8px_24px_rgba(0,0,0,0.5)] scale-[1.02]" : "border-[#1a1a1a] ") +
                    "bg-[#050505] hover:border-[#333]"
                  }
                  onClick={() => openModal(ev)}
                  title={ev.file?.originalName || ev.id}>
                  {u ? (
                    <img
                      src={toInlineMediaUrl(u)}
                      className="w-full h-full object-cover transition-transform duration-200 hover:scale-[1.04]"
                      loading="lazy"
                      onError={() => { void renewThumbOnce(ev, u); }}
                    />
                  ) : (
                    thumbErr[ev.id] ? (
                      <div className="w-full h-full flex items-center justify-center text-[11px] text-gray-500">Unavailable</div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[11px] text-gray-400">Loading…</div>
                    )
                  )}

                  <div
                    style={{ position: "absolute", top: 6, right: 6, display: "flex", gap: 3, padding: "3px 6px", borderRadius: 999, background: "rgba(5,5,5,0.82)", border: "1px solid #1c1c1c" }}
                    title={`${hasLabels ? "Has label" : "Needs label"} · ${hasJob ? "Attached to task" : "Needs task"}`}
                  >
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: hasLabels ? "#22c55e" : "#C8A84E" }} />
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: hasJob ? "#22c55e" : "#C8A84E" }} />
                  </div>

                  <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                    {labels.slice(0, 2).map((l:string) => (
                      <span key={l} className={"text-[10px] px-2 py-0.5 rounded-full border " + labelChipColor(l)}>
                        {l}
                      </span>
                    ))}
                    {converting ? (
                      <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(200,168,78,0.15)", border: "1px solid rgba(200,168,78,0.3)", color: "#C8A84E" }}>Converting…</span>
                    ) : null}
                    {uploadMissing ? (
                      <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "#0b0b0b", border: "1px solid #1c1c1c", color: "#b3b3b3" }}>Missing</span>
                    ) : null}
                    {conversionFailed ? (
                      <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "#0b0b0b", border: "1px solid #1c1c1c", color: "#b3b3b3" }} title={conversionError || "HEIC conversion failed"}>Failed</span>
                    ) : null}
                    {conversionNoPreview ? (
                      <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "#0b0b0b", border: "1px solid #1c1c1c", color: "#6f6f6f" }}>No preview</span>
                    ) : null}
                  </div>

                  <div style={{ position: "absolute", bottom: 6, left: 6, right: 6, fontSize: 9, color: "#b3b3b3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "rgba(5,5,5,0.7)", padding: "2px 6px", borderRadius: 3 }}>
                    {(ev.file?.originalName || "evidence")}
                  </div>
                  {process.env.NODE_ENV !== "production" && thumbDiagById[String(ev?.id || "")] ? (
                    <div className="absolute left-2 right-2 bottom-8 text-[10px] text-red-200 truncate bg-black/55 px-2 py-1 rounded border border-red-400/30">
                      {thumbDiagById[String(ev?.id || "")]}
                    </div>
                  ) : null}
                  {process.env.NODE_ENV !== "production" && thumbDebugOverlay ? (
                    <div className="absolute left-2 right-2 top-8 text-[10px] text-cyan-100 bg-black/60 px-2 py-1 rounded border border-cyan-300/30">
                      <div className="truncate">id={String(ev?.id || "")}</div>
                      <div className="truncate">bucket={String(thumbBucketById[String(ev?.id || "")] || "")}</div>
                      <div className="truncate">path={String(thumbPathById[String(ev?.id || "")] || "")}</div>
                      <div className="truncate">mint_http={String(thumbStatusById[String(ev?.id || "")] || 0)}</div>
                      <div className="truncate">mint_error={String(thumbMintErrorById[String(ev?.id || "")] || "-")}</div>
                      <div className="truncate">probe_http={String(thumbProbeStatusById[String(ev?.id || "")] || "-")}</div>
                      <div className="truncate">probe_error={String(thumbProbeErrorById[String(ev?.id || "")] || "-")}</div>
                    </div>
                  ) : null}
                </button>
              );
            })}

            
          </>
        );
      })()}
    </div>
  </div>

  <div style={{ marginTop: 8, fontSize: 10, color: "#6f6f6f", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
    <span>Tap a tile to preview, label, or assign to a task.</span>
    {evidence.length > 12 ? (
      <span style={{ color: "#b3b3b3" }}>Showing 12 of {evidence.length}</span>
    ) : null}
  </div>

  {selectedEvidence && !previewOpen ? (() => {
    const selId = String(selectedEvidence.id || "");
    const selThumb = thumbUrl[selId];
    const selLabels = (selectedEvidence.labels || []).map(normLabel);
    const selJobId = getLinkedJobId(selectedEvidence);
    const selJob = (jobs || []).find((j: any) => String(j?.id || j?.jobId || "") === selJobId);
    const selJobTitle = String(selJob?.title || selJobId || "");
    const selSec = Number(selectedEvidence.storedAt?._seconds || selectedEvidence.createdAt?._seconds || 0);
    const idx = (evidence || []).findIndex((ev: any) => String(ev?.id || "") === selId);
    const canPrev = idx > 0;
    const canNext = idx >= 0 && idx < (evidence || []).length - 1;
    const go = (delta: number) => {
      const nextIdx = idx + delta;
      const next = (evidence || [])[nextIdx];
      if (!next || !next.id) return;
      setSelectedEvidenceId(next.id);
      try { jumpToEvidence(String(next.id)); } catch {}
    };
    return (
      <div style={{ marginTop: 10, borderRadius: 10, border: "1px solid rgba(200,168,78,0.25)", background: "#050505", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 140px) minmax(0, 1fr)", gap: 12, padding: 12 }}>
          <div style={{ borderRadius: 8, overflow: "hidden", background: "#0b0b0b", aspectRatio: "4 / 3", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {selThumb ? (
              <img src={toInlineMediaUrl(selThumb)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span style={{ fontSize: 10, color: "#6f6f6f" }}>No preview</span>
            )}
          </div>
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#f5f5f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(selectedEvidence.file?.originalName || selId)}>
              {selectedEvidence.file?.originalName || selId}
            </div>
            <div style={{ fontSize: 10, color: "#6f6f6f" }}>
              {selSec ? `Uploaded ${fmtAgo(selSec)}` : `id: …${selId.slice(-6)}`}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
              {selLabels.length > 0 ? (
                selLabels.map((l: string) => (
                  <span key={l} className={"text-[10px] px-2 py-0.5 rounded-full border " + labelChipColor(l)}>{l}</span>
                ))
              ) : (
                <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)" }}>Needs a label</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#b3b3b3", marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {selJobId ? (
                <span>Task: <span style={{ color: "#f5f5f5", fontWeight: 600 }}>{selJobTitle}</span></span>
              ) : (
                <>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)" }}>Needs a task</span>
                  {currentJobId ? (
                    <button
                      type="button"
                      style={{ padding: "3px 9px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: "1px solid rgba(200,168,78,0.35)", background: "rgba(200,168,78,0.1)", color: "#C8A84E", cursor: fieldJobUiState.isReadOnly ? "not-allowed" : "pointer" }}
                      disabled={fieldJobUiState.isReadOnly}
                      onClick={() => { try { assignEvidenceJob(selId, String(currentJobId)); } catch {} }}
                      title="Attach this photo to your active task"
                    >
                      Assign to my task
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderTop: "1px solid #1c1c1c", background: "#0b0b0b", gap: 8 }}>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              disabled={!canPrev}
              onClick={() => go(-1)}
              style={{ padding: "5px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: "1px solid #1c1c1c", background: "transparent", color: canPrev ? "#b3b3b3" : "#3a3a3a", cursor: canPrev ? "pointer" : "not-allowed" }}
            >
              ← Prev
            </button>
            <button
              type="button"
              disabled={!canNext}
              onClick={() => go(1)}
              style={{ padding: "5px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: "1px solid #1c1c1c", background: "transparent", color: canNext ? "#b3b3b3" : "#3a3a3a", cursor: canNext ? "pointer" : "not-allowed" }}
            >
              Next →
            </button>
            <span style={{ alignSelf: "center", fontSize: 10, color: "#6f6f6f", marginLeft: 4 }}>
              {idx >= 0 ? `${idx + 1} / ${evidence.length}` : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={() => { try { openModal(selectedEvidence); } catch {} }}
              style={{ padding: "5px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, border: "1px solid rgba(200,168,78,0.35)", background: "rgba(200,168,78,0.1)", color: "#C8A84E", cursor: "pointer" }}
            >
              Open full
            </button>
            <button
              type="button"
              onClick={() => setSelectedEvidenceId("")}
              style={{ padding: "5px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: "1px solid #1c1c1c", background: "transparent", color: "#6f6f6f", cursor: "pointer" }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    );
  })() : null}
  </>
  )}
</section>
        ) : null}

        {activeTab === "tasks" ? (
        <section style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#C8A84E" }}>Active Task</span>
            <span style={{ fontSize: 10, color: "#6f6f6f" }}>default for new evidence</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: "#6f6f6f", lineHeight: 1.4 }}>Active tasks appear here. Completed items move to Review.</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "#b3b3b3" }}>
            {(() => {
              const reviewReadyCount = (jobs || []).filter((j: any) => {
                const s = normalizeJobStatus(j?.status);
                return s !== "open" && s !== "in_progress" && s !== "assigned";
              }).length;
              return reviewReadyCount > 0 ? `${reviewReadyCount} task${reviewReadyCount === 1 ? "" : "s"} ready in Review` : "";
            })()}
          </div>

          {(() => {
            const current = jobs.find((j: any) => String(j?.id || j?.jobId || "") === String(currentJobId || ""));
            const currentTitle = String(current?.title || current?.id || current?.jobId || "").trim();
            const currentStatus = jobStatusText(current?.status);

            // PEAKOPS_MARK_COMPLETE_WIRE_V1
            // The existing markCurrentJobComplete() helper was defined but had
            // no call site, which dead-ended the field→supervisor chain
            // (supervisor gate = job status ∈ {complete,review} ∧ linked
            // evidence ≥ 1). Gating mirrors the helper's own preconditions.
            const currentJid = String(currentJobId || "").trim();
            const currentNormalizedStatus = normalizeJobStatus(current?.status);
            const currentIsFieldSelectable = isFieldSelectableJob(current?.status);
            const markCompleteDisabled =
              isClosed ||
              jobsBusy ||
              !currentJid ||
              !current ||
              !currentIsFieldSelectable;
            const markCompleteDisabledReason = isClosed
              ? "Job is closed (read-only)"
              : jobsBusy
                ? "Task update in progress…"
                : !currentJid || !current
                  ? "Select a task first"
                  : !currentIsFieldSelectable
                    ? `Task is already ${currentNormalizedStatus || "past complete"}`
                    : "Mark this task complete so it becomes reviewable";

            // PEAKOPS_CREATE_JOB_INLINE_V1
            // When the incident has zero jobs the select / Mark complete /
            // Jump to mapping actions have nothing to operate on, and the
            // supervisor dead-ends at "No reviewable jobs yet". Render the
            // existing createJob() helper through a small inline form so a
            // field user can create the first job without leaving the tab.
            //
            // Disable gating uses `createJobInflight` (a dedicated state flag
            // flipped only inside createJob's try/finally) instead of the
            // shared `jobsBusy`. That prevents unrelated job actions — including
            // concurrent auto-refresh races — from wrongly greying out the button.
            const createJobTitle = String(jobTitle || "").trim();
            const createJobDisabled = isClosed || createJobInflight || !createJobTitle;
            const showCreateJobInline = Array.isArray(jobs) && jobs.length === 0;

            return (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                {showCreateJobInline ? (
                  <div style={{ padding: 12, borderRadius: 8, border: "1px dashed #1c1c1c", background: "#050505" }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#C8A84E" }}>
                      Create first task
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, color: "#6f6f6f", lineHeight: 1.5 }}>
                      A task groups evidence under a specific task. Create one so evidence can be attached and reviewed.
                    </div>
                    <input
                      type="text"
                      value={jobTitle}
                      onChange={(e) => setJobTitle(e.target.value)}
                      placeholder="Task name (e.g. Pole inspection)"
                      disabled={fieldJobUiState.isReadOnly || createJobInflight}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !createJobDisabled) {
                          e.preventDefault();
                          try { createJob(); } catch {}
                        }
                      }}
                      style={{
                        width: "100%",
                        marginTop: 10,
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "1px solid #1c1c1c",
                        background: "#101010",
                        color: "#f5f5f5",
                        fontSize: 13,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => { try { createJob(); } catch {} }}
                      disabled={createJobDisabled}
                      title={
                        isClosed
                          ? "Job is closed (read-only)"
                          : createJobInflight
                            ? "Task create in progress…"
                            : !createJobTitle
                              ? "Enter a task name"
                              : "Create this task"
                      }
                      style={{
                        width: "100%",
                        marginTop: 8,
                        padding: "9px 14px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: "0.02em",
                        cursor: createJobDisabled ? "not-allowed" : "pointer",
                        border: "1px solid #1c1c1c",
                        background: "#101010",
                        color: createJobDisabled ? "#6f6f6f" : "#b3b3b3",
                      }}
                    >
                      {createJobInflight ? "Creating…" : "+ Create Task"}
                    </button>
                  </div>
                ) : null}

                <select
                  style={{ width: "100%", fontSize: 13, background: "#101010", border: "1px solid #1c1c1c", borderRadius: 6, padding: "8px 10px", color: "#f5f5f5" }}
                  disabled={fieldJobUiState.isReadOnly || jobsBusy || jobsForMapping.length === 0}
                  value={currentJobId || String(jobsForMapping?.[0]?.id || jobsForMapping?.[0]?.jobId || "")}
                  onChange={(e) => setCurrentJobId(String(e.target.value || ""))}
                >
                  {jobsForMapping.length === 0 ? (
                    <option value="">No active tasks</option>
                  ) : null}
                  {jobsForMapping.map((j: any) => {
                    const jid = String(j?.id || j?.jobId || "").trim();
                    if (!jid) return null;
                    const title = String(j?.title || jid).trim();
                    const status = jobStatusText(j?.status);
                    return (
                      <option key={jid} value={jid}>
                        {title} ({status})
                      </option>
                    );
                  })}
                </select>

                {/* PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
                    Vendor row for the selected task. Resolves the
                    selected job once (falls back to the first job if
                    the user hasn't picked yet, mirroring the select's
                    own value resolution above). canEdit gates on
                    admin/supervisor role; the picker handles the
                    archived-vendor display when relevant. */}
                {(() => {
                  const _selectedJobId = String(
                    currentJobId ||
                    jobsForMapping?.[0]?.id ||
                    jobsForMapping?.[0]?.jobId ||
                    ""
                  ).trim();
                  const _selectedJob: any = jobsForMapping.find(
                    (j: any) => String(j?.id || j?.jobId || "") === _selectedJobId
                  ) || null;
                  if (!_selectedJob) return null;
                  const _role = String(authClaims?.role || "").toLowerCase();
                  const _canEditVendor =
                    !isClosed &&
                    (_role === "admin" || _role === "supervisor");
                  return (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 10px",
                      border: "1px solid #1c1c1c", borderRadius: 6,
                      background: "#0a0a0a",
                    }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
                        color: "#6f6f6f", textTransform: "uppercase" as const,
                        minWidth: 60,
                      }}>Vendor</span>
                      <div style={{ flex: 1 }}>
                        <VendorPicker
                          orgId={String(orgId || "")}
                          currentVendorId={String(_selectedJob?.vendorId || "")}
                          currentVendorName={String(_selectedJob?.vendorName || "")}
                          canEdit={_canEditVendor}
                          onChange={async (next) => {
                            try {
                              await assignVendorToJob(incidentId, _selectedJobId, next);
                              toast(next ? `Vendor assigned: ${next.vendorName}` : "Vendor cleared.", 2200);
                              await refresh();
                            } catch (e: any) {
                              if (process.env.NODE_ENV !== "production") {
                                // eslint-disable-next-line no-console
                                console.warn("[vendor-assign]", {
                                  path: `incidents/${incidentId}/jobs/${_selectedJobId}`,
                                  code: e?.code || null,
                                  message: String(e?.message || e),
                                });
                              }
                              toast("We couldn't update the vendor. Please try again.", 3500);
                            }
                          }}
                        />
                      </div>
                    </div>
                  );
                })()}

                <button
                  type="button"
                  style={{
                    padding: "9px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                    cursor: markCompleteDisabled ? "not-allowed" : "pointer",
                    border: "1px solid #1c1c1c",
                    background: "#101010",
                    color: markCompleteDisabled ? "#6f6f6f" : "#b3b3b3",
                  }}
                  disabled={markCompleteDisabled}
                  onClick={() => { try { markCurrentJobComplete(); } catch {} }}
                  title={markCompleteDisabledReason}
                >
                  ✓ Mark task complete
                </button>
                <div style={{ fontSize: 10, color: "#6f6f6f", lineHeight: 1.5, marginTop: -2 }}>
                  A complete task with at least one attached photo becomes reviewable by the supervisor.
                </div>

                <button
                  type="button"
                  style={{ padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, border: "1px solid #1c1c1c", background: "#101010", color: "#b3b3b3", cursor: "pointer" }}
                  disabled={!(currentJobId || String(jobsForMapping?.[0]?.id || jobsForMapping?.[0]?.jobId || "").trim())}
                  onClick={() => {
                    try {
                      const fallbackJobId = String(
                        currentJobId ||
                        jobsForMapping?.[0]?.id ||
                        jobsForMapping?.[0]?.jobId ||
                        ""
                      ).trim();
                      if (fallbackJobId) {
                        setCurrentJobId(fallbackJobId);
                      }
                      jumpToEvidenceMapping();
                    } catch {}
                  }}
                >
                  Attach photos →
                </button>
              </div>
            );
          })()}

          {orgOptionsLoadError ? (
            <div style={{ marginTop: 8, fontSize: 11, color: "#C8A84E" }}>Org list failed to load</div>
          ) : orgOptionsLoaded && orgOptions.length === 0 ? (
            <div style={{ marginTop: 8, fontSize: 11, color: "#6f6f6f" }}>No orgs available</div>
          ) : null}

          {orgOptions.length === 0 && showOrgDevTools ? (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 10, color: "#6f6f6f" }}>Dev tools</summary>
              <div style={{ marginTop: 4, display: "flex", gap: 8 }}>
                <button type="button" style={{ fontSize: 10, color: "#6f6f6f", background: "none", border: "none", textDecoration: "underline", cursor: "pointer" }} onClick={() => { try { debugOrgs(); } catch {} }} disabled={orgDebugBusy}>{orgDebugBusy ? "Loading..." : "Debug orgs"}</button>
                <button type="button" style={{ fontSize: 10, color: "#6f6f6f", background: "none", border: "none", textDecoration: "underline", cursor: "pointer" }} onClick={() => { try { seedOrgsDev(); } catch {} }} disabled={orgSeedBusy}>{orgSeedBusy ? "Seeding..." : "Seed orgs"}</button>
              </div>
            </details>
          ) : null}

          {orgDebugJson ? (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 10, color: "#6f6f6f" }}>Debug JSON</summary>
              <pre style={{ marginTop: 4, maxHeight: 160, overflow: "auto", borderRadius: 6, background: "#101010", border: "1px solid #1c1c1c", padding: 8, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 10, color: "#b3b3b3" }}>{orgDebugJson}</pre>
            </details>
          ) : null}

          <div style={{ marginTop: 8, fontSize: 11, color: "#6f6f6f" }}>
            New photos auto-attach to your active task. Otherwise, you can attach them above.
          </div>
        </section>
        ) : null}

        {activeTab === "evidence" ? (
        <section ref={evidenceMappingSectionRef} style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <h2 id="evidence-mapping" style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#f5f5f5" }}>Attach Photos</h2>
              <span style={{ fontSize: 10, color: "#6f6f6f" }}>
                {(jobs || []).length === 0
                  ? "No tasks yet — photos save to the job"
                  : `${(jobs || []).length} task${(jobs || []).length === 1 ? "" : "s"} available`}
              </span>
            </div>
            <button
              type="button"
              style={{
                padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
                cursor: (isClosed || jobsBusy || !currentJobId) ? "not-allowed" : "pointer",
                border: "1px solid #1c1c1c",
                background: "#101010",
                color: (fieldJobUiState.isReadOnly || jobsBusy || !currentJobId) ? "#6f6f6f" : "#b3b3b3",
              }}
              disabled={fieldJobUiState.isReadOnly || jobsBusy || !currentJobId}
              onClick={() => { try { assignAllUnassignedToCurrentJob(); } catch {} }}
              title={currentJobId ? "Attach all unattached photos to your task" : "Select a task first"}
            >
              Assign all to my task
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "#6f6f6f", lineHeight: 1.5 }}>
            When a task is active, new photos auto-attach to it. Otherwise they stay on the job and you can attach them from the dropdown below — any task, regardless of status, can receive photos.
          </div>
          {(evidence || []).length === 0 ? (
            <div style={{ marginTop: 12, padding: "14px 10px", borderRadius: 8, border: "1px dashed #1c1c1c", background: "#050505", textAlign: "center", fontSize: 11, color: "#6f6f6f", lineHeight: 1.5 }}>
              Nothing to map yet. Photos you add will show up here with a task selector.
            </div>
          ) : null}
          {(evidence || []).length > 0 ? (
          <div className="mt-3 space-y-2">
            {(evidence || []).slice(0, 25).map((ev: any) => {
              const currentEvidenceJobId = getLinkedJobId(ev);
              const linkedJob = (jobs || []).find((j: any) => String(j?.id || j?.jobId || "") === currentEvidenceJobId);
              const eid = String(ev?.id || "").trim();
              const evSec = Number(ev?.storedAt?._seconds || ev?.createdAt?._seconds || 0);
              const rowBusy = !!heicRowBusyById[eid];
              const rowDebug = String(heicRowDebugById[eid] || "");
              const evStoragePath = String(ev?.file?.storagePath || ev?.storagePath || "").trim();
              return (
                <div key={eid} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-100 truncate">{String(ev?.file?.originalName || "Photo")}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {evSec ? `uploaded ${fmtAgo(evSec)}` : "uploading…"}
                      </div>
                      {linkedJob ? (
                        <div className="text-[11px] text-cyan-200/85 truncate">
                          task: {String(linkedJob?.title || linkedJob?.id || linkedJob?.jobId || "")}
                        </div>
                      ) : (
                        <div style={{ marginTop: 2 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)" }}>
                            Unassigned — stays on the job
                          </span>
                        </div>
                      )}
                    </div>
                    {/* PEAKOPS_EVIDENCE_ATTACH_DROPDOWN_V1 (2026-04-27)
                        The per-evidence attach dropdown. Source is the full
                        `jobs` array (no client-side filter) so every status
                        — open, in_progress, complete, review, approved,
                        locked — is a valid attachment target. Backend
                        `assignEvidenceToJobV1` accepts assignment to
                        approved/locked jobs (lock gate was removed in
                        PEAKOPS_ASSIGN_EVIDENCE_TO_JOB_V2). */}
                    {(() => {
                      const availableWorkItems = Array.isArray(jobs) ? jobs : [];
                      // PEAKOPS_EVIDENCE_ATTACH_CLOSED_STATE_V1 (2026-04-27)
                      // The biggest cause of "the dropdown won't attach" was
                      // the closed-incident silent-disable. Surface it as
                      // explicit copy so the operator knows why the control
                      // isn't responding.
                      if (isClosed) {
                        return (
                          <div
                            style={{
                              padding: "6px 10px",
                              borderRadius: 6,
                              border: "1px solid #1c1c1c",
                              background: "#0b0b0b",
                              color: "#6f6f6f",
                              fontSize: 11,
                              fontWeight: 500,
                              lineHeight: 1.4,
                              minWidth: 180,
                            }}
                            title="Closed jobs are read-only. Open a new job to capture and attach more photos."
                          >
                            Job closed — read-only.
                          </div>
                        );
                      }
                      if (availableWorkItems.length === 0) {
                        return (
                          <div
                            style={{
                              padding: "6px 10px",
                              borderRadius: 6,
                              border: "1px solid rgba(200,168,78,0.30)",
                              background: "rgba(200,168,78,0.06)",
                              color: "#C8A84E",
                              fontSize: 11,
                              fontWeight: 500,
                              lineHeight: 1.4,
                              minWidth: 180,
                            }}
                          >
                            Create a task before attaching evidence.
                          </div>
                        );
                      }
                      // PEAKOPS_DROPDOWN_DEBUG_V1 (2026-04-27, dev-only)
                      // Dev-gated visibility so the operator/engineer can
                      // confirm what state the dropdown sees (was: silent
                      // failures with no console signal). Stripped from prod
                      // bundles by Next.js dead-code elimination.
                      if (process.env.NODE_ENV !== "production") {
                        // eslint-disable-next-line no-console
                        console.debug("[evidence-mapping]", {
                          evidenceId: String(ev?.id || ""),
                          currentEvidenceJobId,
                          availableWorkItemsCount: availableWorkItems.length,
                          firstWorkItemId: String(availableWorkItems[0]?.id || availableWorkItems[0]?.jobId || ""),
                          isClosed,
                          jobsBusy,
                        });
                      }
                      return (
                        <select
                          className="text-xs bg-black/50 border border-white/15 rounded px-2 py-1 min-w-[180px]"
                          disabled={jobsBusy}
                          value={currentEvidenceJobId}
                          onChange={(e) => { void assignEvidenceJob(String(ev?.id || ""), String(e.target.value || "")); }}
                          title={`${availableWorkItems.length} task${availableWorkItems.length === 1 ? "" : "s"} available — any status can receive evidence`}
                        >
                          <option value="">— Attach to task —</option>
                          {availableWorkItems.map((j: any) => {
                            const wid = String(j?.id || j?.jobId || "").trim();
                            if (!wid) return null;
                            const wtitle = String(j?.title || "(untitled)").trim();
                            const wstatus = jobStatusText(j?.status);
                            return (
                              <option key={wid} value={wid}>
                                {wtitle} ({wstatus})
                              </option>
                            );
                          })}
                        </select>
                      );
                    })()}
                  </div>
                  {showOrgDevTools ? (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        className="text-[11px] underline text-cyan-200 disabled:text-gray-500"
                        disabled={rowBusy}
                        onClick={() => { try { debugEvidenceRow(eid, evStoragePath); } catch {} }}
                      >
                        {rowBusy ? "Working..." : "Debug"}
                      </button>
                      <button
                        type="button"
                        className="text-[11px] underline text-cyan-200 disabled:text-gray-500"
                        disabled={rowBusy}
                        onClick={() => { try { convertEvidenceRowNow(eid, evStoragePath); } catch {} }}
                      >
                        {rowBusy ? "Working..." : "Convert now"}
                      </button>
                      <button
                        type="button"
                        className="text-[11px] underline text-cyan-200 disabled:text-gray-500"
                        disabled={rowBusy}
                        onClick={() => { try { convertEvidenceRowNow(eid, evStoragePath, { forceMarkDone: true }); } catch {} }}
                      >
                        {rowBusy ? "Working..." : "Force mark done"}
                      </button>
                    </div>
                  ) : null}
                  {showOrgDevTools && rowDebug ? (
                    <details className="mt-2 text-[11px] text-gray-300">
                      <summary className="cursor-pointer select-none">HEIC debug JSON</summary>
                      <pre className="mt-1 max-h-56 overflow-auto rounded bg-black/40 border border-white/10 p-2 whitespace-pre-wrap break-words">
                        {rowDebug}
                      </pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
          ) : null}
        </section>
        ) : null}

        {/* Timeline story */}
        
        {activeTab === "timeline" ? (
        <section style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#C8A84E" }}>Timeline</span>
            {/* PEAKOPS_DEV_GATE_AUTOLOG_V1 (2026-04-30)
                "Auto-log" was system jargon — gated to devMode so a
                normal operator only sees the Timeline label. */}
            {devMode ? (
              <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 7px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#101010", color: "#6f6f6f" }}>Auto-log</span>
            ) : null}
          </div>
          {/* PEAKOPS_TIMELINE_VS_GALLERY_DISCLOSURE_V1
              Timeline = count of logged events (FIELD_ARRIVED / EVIDENCE_ADDED / NOTES_SAVED / …).
              Gallery = count of actual evidence docs. These two counts can differ when
              legacy evidence was uploaded before the backend emit/read-path unification
              (functions_clean/_incidentPath.js), or when an emit silently failed. The
              gallery is authoritative for "how many photos do we have"; the timeline is
              authoritative for "what events were logged". Showing both with a one-line
              caption so neither number contradicts the other. */}
          {/* PEAKOPS_DEV_GATE_DRIFT_NOTICE_V1 (2026-04-30)
              Gallery-vs-timeline drift notice is engineering chrome —
              it explains an internal reconciliation that operators
              shouldn't have to think about. Gated on devMode. */}
          {devMode ? (() => {
            const eventCount = (Array.isArray(timeline) ? timeline : []).filter((t: any) => String(t?.type) === "EVIDENCE_ADDED").length;
            const galleryCount = _evidenceN;
            if (eventCount === galleryCount) return null;
            return (
              <div style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px dashed #1c1c1c", background: "#050505", fontSize: 10, color: "#b3b3b3", lineHeight: 1.5 }}>
                Timeline logs <span style={{ color: "#f5f5f5", fontWeight: 600 }}>{eventCount}</span> evidence-added event{eventCount === 1 ? "" : "s"}; gallery holds <span style={{ color: "#f5f5f5", fontWeight: 600 }}>{galleryCount}</span> item{galleryCount === 1 ? "" : "s"}. Gallery is authoritative.
              </div>
            );
          })() : null}


<TimelinePanel
  items={timeline as any}
  onJumpToEvidence={jumpToEvidence}
  highlightId={selectedEvidenceId}
/>
        </section>
        ) : null}

        {/* Readiness — consolidated into the NextBestAction card above */}
      </div>

      {/* PEAKOPS_BOTTOM_DOCK_REMOVED_V2 (2026-04-30)
          The fixed bottom action bar duplicated the FlowStageBar
          (progress) and the NBA card (primary action). Removed in
          the IncidentClient cleanup pass — operators now have one
          progress visualization (FlowStageBar at the top) and one
          primary action (NBA card). */}

{/* Modal */}
      {showCreateJob ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-lg rounded-2xl bg-black border border-white/10 overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <div className="text-sm text-gray-200">Create Task</div>
              <button className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/15" onClick={() => setShowCreateJob(false)}>
                Close
              </button>
            </div>
            <div className="p-3 space-y-3">
              <input
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-gray-200"
                placeholder="Task name"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
              />
              <input
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-gray-200"
                placeholder="Assigned to (optional)"
                value={jobAssignedTo}
                onChange={(e) => setJobAssignedTo(e.target.value)}
              />
              <textarea
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-gray-200 min-h-24"
                placeholder="Notes (optional)"
                value={jobNotes}
                onChange={(e) => setJobNotes(e.target.value)}
              />
              <button
                type="button"
                className="w-full py-2 rounded-xl bg-cyan-600/20 border border-cyan-300/30 text-cyan-100 hover:bg-cyan-600/30 disabled:opacity-60"
                disabled={jobsBusy || isClosed}
                onClick={() => { try { createJob(); } catch {} }}
              >
                {jobsBusy ? "Creating..." : "Create Task"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

{/* Modal */}
      {previewOpen ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-3xl rounded-2xl bg-black border border-white/10 overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <div className="text-sm text-gray-200 truncate">{previewName}</div>
              <button
                className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/15"
                onClick={() => setPreviewOpen(false)}>
                Close
              </button>
              {process.env.NODE_ENV !== "production" && selectedIsHeic && selectedMissingDerivatives ? (
                <button
                  className="text-xs px-2 py-1 rounded bg-amber-500/20 border border-indigo-400/20 hover:bg-amber-500/30"
                  disabled={convertingHeic}
                  onClick={() => { try { convertSelectedHeicNow(); } catch {} }}
                  title="Dev fallback: run HEIC conversion now"
                >
                  {convertingHeic ? "Converting…" : "Convert HEIC"}
                </button>
              ) : null}
              {process.env.NODE_ENV !== "production" && selectedIsHeic ? (
                <button
                  className="text-xs px-2 py-1 rounded bg-sky-500/20 border border-sky-300/30 hover:bg-sky-500/30"
                  disabled={debuggingHeic}
                  onClick={() => { try { debugRunSelectedHeic(); } catch {} }}
                  title="Dev: run structured conversion debug + one conversion attempt"
                >
                  {debuggingHeic ? "Debugging…" : "Debug/Run Conversion"}
                </button>
              ) : null}
            </div>
            <div className="p-3">
              {previewUrl ? (
                <img src={toInlineMediaUrl(previewUrl)} className="w-full h-full object-cover" />
              ) : (
                <div className="text-gray-400 text-sm">Loading…</div>
              )}

              {/* PEAKOPS_V2_CAPTION_UI */}
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">Evidence label</div>

                <div className="mt-2 flex items-center gap-2">
                  <input
                    className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-gray-200 outline-none placeholder:text-gray-500"
                    placeholder="e.g., Pole base (wide), conductor break (close), panel label…"
                    value={getCaption(selectedEvidenceId)}
                    onChange={(e) => setCaption(selectedEvidenceId, e.target.value)}
                    onBlur={() => {
                      try {
                        persistEvidenceLabel(
                          String(orgId || ""),
                          String(incidentId || ""),
                          String(selectedEvidenceId || ""),
                          String(getCaption(selectedEvidenceId) || "")
                        );
                      } catch {}
                    }}
                  />
                  <button
                    type="button"
                    className="px-3 py-2 rounded-xl bg-white/6 border border-white/12 text-gray-200 hover:bg-white/10 transition text-sm"
                    onClick={() => setCaption(selectedEvidenceId, "")}
                    title="Clear label"
                  >
                    Clear
                  </button>
                </div>

                <div className="mt-2 text-[11px] text-gray-500">
                  v2: stored locally for now. Later we’ll persist to Firestore + enforce naming rules.
                </div>
              </div>
</div>
          </div>
        </div>
      ) : null}

      {/* PEAKOPS_TOAST_DEDUP_V1 (2026-04-29)
          The legacy ZIP_TOAST renderer used to live here and read the
          same `toastMsg` state as PEAKOPS_UX_TOAST_RENDER_V1 above —
          which meant any toast() call rendered TWO overlapping bars
          (top-center + top-right). Removed; the V1 renderer above is
          now the only path. */}

    </main>
    )
  );
}
