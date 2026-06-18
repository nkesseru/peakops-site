"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { outboxFlushSupervisorRequests } from "@/lib/offlineOutbox";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import AddEvidenceButton from "@/components/evidence/AddEvidenceButton";
import FilingCountdown from "@/components/incident/FilingCountdown";
import NextBestAction from "@/components/incident/NextBestAction";
import TimelinePanel from "@/components/incident/TimelinePanel";
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
import { authedFetch } from "@/lib/apiClient";
import { SealedRecordPanel } from "@/components/sealedRecord/SealedRecordPanel";
import AppTopBar from "@/components/AppTopBar";
// PR 130b — surfaces recovery actions assigned to the field user inside
// the active incident overview as "Extra work needed before this can
// be accepted." Hidden when there's nothing to do. The component never
// exposes recovery-case / revenue / resubmission vocabulary.
import { RecoveryWorkSection } from "@/components/recovery/RecoveryWorkSection";
import {
  incidentStatusLabel,
  incidentStatusPill,
} from "@/lib/incidents/incidentStatus";
import { getArchetypeDetails } from "@/lib/incidents/newIncidentDraft";






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
function toInlineMediaUrl(u: string | undefined | null): string {
  const url = String(u || "").trim();
  if (!url) return url;

  // If it's already our proxy, use it.
  if (url.startsWith("/api/media?")) return url;

  // Match Storage emulator download URLs
  // Example:
  // http://127.0.0.1:9199/download/storage/v1/b/<bucket>/o/<encodedPath>?alt=media
  const m = url.match(/\/download\/storage\/v1\/b\/([^\/]+)\/o\/([^?]+)(\?.*)?$/);
  if (m) {
    const bucket = decodeURIComponent(m[1] || "");
    const encPath = m[2] || "";
    let path = encPath;
    try { path = decodeURIComponent(encPath); } catch {}
    // Route through Next so headers are inline + content-type is image/*.
    if (!bucket || !path) return "";
    return `/api/media?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
  }

  // Match v0 style:
  // http://127.0.0.1:9199/v0/b/<bucket>/o/<encodedPath>?alt=media
  const m2 = url.match(/\/v0\/b\/([^\/]+)\/o\/([^?]+)(\?.*)?$/);
  if (m2) {
    const bucket = decodeURIComponent(m2[1] || "");
    const encPath = m2[2] || "";
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
    // PR 85 — proof vocabulary on the open-state timeline event.
    EVIDENCE_ADDED: "Proof secured",
    FIELD_ARRIVED: "Arrived on site",
    FIELD_APPROVED: "Supervisor approved",
    MATERIAL_ADDED: "Material logged",
    INCIDENT_OPENED: "Incident opened",
    SESSION_STARTED: "Field session started",
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
  if (L === "SAFETY") return "bg-amber-400/12 border-amber-300/25 text-amber-200";
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
  if (s === "review") return "bg-amber-500/15 border-amber-300/30 text-amber-100";
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
  if (raw === "in-progress" || raw === "inprogress" || raw === "in_progress" || raw === "submitted") return "in_progress";
  if (raw === "closed") return "closed";
  // PEAKOPS_DRAFT_STATUS_PASSTHROUGH_V1 (PR 73 follow-up)
  // The proof-workflow create flow (PR 70) writes status: "draft" via
  // createIncidentV1 (PR 68). Without this passthrough, the page's
  // local normalizer collapsed every unknown value to "open", which
  // is why the destination right after Create field record rendered
  // an Open pill instead of the Draft pill PR 73 added to
  // incidentStatusLabel/Pill. Lifecycle unchanged — this just
  // surfaces an already-stored status string.
  if (raw === "draft") return "draft";
  // Customer-review corridor statuses (PR 126+). Without these
  // passthroughs the catch-all below collapsed customer_accepted,
  // customer_rejected, and submitted_to_customer to "open" — which
  // is why the Incident page rendered an "Open" pill and the
  // "Proof package incomplete" readiness card on records other
  // screens already showed as Accepted. Dashboard / Records /
  // Summary call incidentStatusLabel on the raw status and never
  // hit this normalizer, which is why the inconsistency only
  // showed on the Incident page.
  if (raw === "submitted_to_customer") return "submitted_to_customer";
  if (raw === "customer_accepted") return "customer_accepted";
  if (raw === "customer_rejected") return "customer_rejected";
  return "open";
}

// Returns true when the incident is in a status where no further
// field-work mutations should be accepted from the operator UI:
//   - closed                 (operator-accepted, sealed)
//   - customer_accepted      (customer signed off — packet is locked)
//   - customer_rejected      (operator's next move is recovery, not raw field work)
//   - submitted_to_customer  (review link out — record is frozen until customer responds)
// Used by the bottom dock visibility gate, the proof/capture/jobs
// surfaces on the Overview/Jobs/Evidence tabs, and as a defense-in-depth
// early-return inside every mutation handler — same set, single source.
function isFieldWorkLocked(status: any) {
  const s = String(status || "").toLowerCase();
  return s === "closed"
      || s === "customer_accepted"
      || s === "customer_rejected"
      || s === "submitted_to_customer";
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
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return JSON.parse(txt) as T;
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
    return s === "<incidentid>" || s === "%3cincidentid%3e" || s.includes("<incidentid>");
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

    const onFocus = () => syncNotesSavedLocal();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [incidentId]);

  const [arrived, setArrived] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closingIncident, setClosingIncident] = useState(false);
  const [incidentStatus, setIncidentStatus] = useState<string>("open");
  const [incidentUpdatedAtSec, setIncidentUpdatedAtSec] = useState<number | null>(null);
  // PEAKOPS_INCIDENT_HERO_CONVERGENCE_V1 (PR 56)
  // Title + location lifted from getIncidentV1's response so the
  // header can render the Summary-style identity hero. Both are
  // optional on the wire; the hero renders fallbacks when missing.
  const [incidentTitle, setIncidentTitle] = useState<string>("");
  const [incidentLocation, setIncidentLocation] = useState<string>("");
  // PEAKOPS_ARCHETYPE_AWARE_BANNER_V1 (PR 84) — plumbed so the
  // capture-proof banner can surface per-archetype required-proof
  // expectations. Empty string when the doc has no archetype or
  // when the value is a legacy enum key the curated UI doesn't
  // know how to render.
  const [incidentArchetype, setIncidentArchetype] = useState<string>("");

  // PEAKOPS_INCIDENT_HERO_HYDRATION_V1 (tiny PR)
  // First-load gate. Without it, the meta line briefly renders
  // "0 jobs · 0 pieces of evidence" against the initial useState
  // defaults before refresh() resolves. We flip this true once at
  // the end of the first refresh (success or failure — doesn't
  // matter, we just want to stop pretending zero is meaningful).
  const [hasInitialLoad, setHasInitialLoad] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "timeline" | "evidence" | "jobs">("overview");
  const [pendingJumpToEvidenceMapping, setPendingJumpToEvidenceMapping] = useState(false);
  const setTab = (tab: "overview" | "timeline" | "evidence" | "jobs") => {
    setActiveTab(tab);
    try {
      const nextHash = `#${tab}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    } catch {}
  };

  useEffect(() => {
    const applyHashTab = () => {
      try {
        const raw = String(window.location.hash || "").replace(/^#/, "").trim().toLowerCase();
        if (raw === "overview" || raw === "timeline" || raw === "evidence" || raw === "jobs") {
          setActiveTab(raw as "overview" | "timeline" | "evidence" | "jobs");
        }
      } catch {}
    };
    applyHashTab();
    window.addEventListener("hashchange", applyHashTab);
    return () => window.removeEventListener("hashchange", applyHashTab);
  }, []);

  function jumpToEvidenceMapping() {
    try {
      setPendingJumpToEvidenceMapping(true);
      setActiveTab("evidence");
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
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
    // PEAKOPS_NO_JOB_PROOF_V1 (PR 112)
    // Removed the !hasActiveFieldJobs toast gate. Jobs are optional —
    // PR 111's AddEvidenceClient now handles no-job records (proof
    // attaches at record level). The previous toast contradicted the
    // calm "Capture your first proof item to start the session." hint
    // rendered when there's no active job (line ~2722) and bounced
    // operators back to a page that wanted them to proceed.
    try {
      // PEAKOPS_ADD_EVIDENCE_NAV_V1: Keep MVP behavior dead-simple + reliable.
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
      toast("Add proof navigation failed.", 2800);
      console.error("[AddEvidence] navigation failed", e);
    }
  };


  // V6_SESSION_HELPERS__WIRE
async function markArrived() {
    // PEAKOPS_ARRIVE_RETRY_SESSION_V1
    // If sessionId is missing or stale, create a new field session and retry once.
    const techUserId = process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web";
    const base = functionsBase;
    const org = String(orgId || "").trim();

    if (!base) return toast("Missing NEXT_PUBLIC_FUNCTIONS_BASE", 3000);
    // Defense-in-depth: refuse before optimistic UI fires. Hides the
    // 1d → 0s timeline flash even when this function is invoked from
    // a code path that bypasses the bottom-dock visibility gate.
    {
      const _s = String(incidentStatus).toLowerCase();
      if (_s === "closed" || _s === "customer_accepted" || _s === "customer_rejected" || _s === "submitted_to_customer") {
        return toast("This record is locked from field work.", 2600);
      }
    }

    let sid = String(activeSessionId || "").trim();
    if (!sid) {
      // try last known session from storage (if any)
      try { sid = String(localStorage.getItem("peakops_active_session_" + String(incidentId || "")) || "").trim(); } catch {}
    }

    async function startSession(): Promise<string> {
      const res = await authedFetch(`/api/fn/startFieldSessionV1`, {
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
      const res = await authedFetch(`/api/fn/markArrivedV1`, {
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

    // Optimistic UI event id (stable across try/catch).
    // Hoisted to function scope so the outer catch (which uses
    // __optId to revert the optimistic timeline insert) can see it.
    const __optId = "opt_arrived_" + Date.now();
    try {
      setArriving(true);

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

      setArrived(true);
      toast("Arrived ✓", 1800);
    } catch (e: any) {
      const msg = e?.message || String(e) || "markArrived failed";
      toast("Arrive failed: " + msg, 3500);
      // OPTIMISTIC_FIELD_ARRIVED revert
      try { setTimeline((prev: any) => (Array.isArray(prev) ? prev.filter((x:any) => x?.id !== __optId) : prev)); } catch {}
      console.error(e);
    } finally {
      setArriving(false);
    }
}

  async function submitSession() {
    // Defense-in-depth: refuse before any server call for sealed or
    // post-review records, regardless of which UI surface fired this.
    {
      const _s = String(incidentStatus).toLowerCase();
      if (_s === "closed" || _s === "customer_accepted" || _s === "customer_rejected" || _s === "submitted_to_customer") {
        return toast("This record is locked from field work.", 2600);
      }
    }
    const sid = String(activeSessionId || "").trim();
    if (!sid) return toast("No active session yet — add evidence first.", 3000);
    const ok = window.confirm("Submit this session? This locks the field visit for supervisor review.");
    if (!ok) return;
    try {
      setSubmitting(true);
      const out: any = await postJson("/api/fn/submitFieldSessionV1", { orgId: orgId,
        incidentId,
        sessionId: sid,
        updatedBy: "ui",
      });
      if (!out?.ok) throw new Error(out?.error || "submit failed");
      toast("Session submitted ✓", 2200);
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "submit failed";
      toast("Submit failed: " + msg, 3500);
    } finally {
      setSubmitting(false);
    }
  }

  const router = useRouter();
  // PEAKOPS_INCIDENT_ORG_FROM_URL_V1 (2026-05-15)
  // orgId comes from the incident URL's `?orgId=...` searchParam,
  // mirroring the PR #16 fix for the Notes route. The previous
  // hardcode (`"riverbend-electric"`) caused every Cloud Function
  // call to be evaluated against the wrong org's membership doc,
  // which now (after the PR #17/#18 auth retrofit) returns 403
  // permission-denied for every legitimate signed-in user not in
  // that demo org. Empty string when missing — the server-side
  // mustStr() check returns 400 and the page surfaces a clear
  // refresh error instead of silently misbehaving.
  const sp = useSearchParams();
  const orgId = String(sp?.get("orgId") || "").trim();
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
      toast("Arrived ✓", 1500);
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "markArrived failed";
      toast(`Arrive failed: ${msg}`, 3500);
    } finally {
      setArriving(false);
    }
  };

  const v6SubmitSession = async () => {
    try {
      setSubmitting(true);
      const sid = getActiveSessionId();
      if (!sid) throw new Error("sessionId missing — add evidence / start a session first.");
      const out: any = await postJson(`/api/fn/submitFieldSessionV1`, { orgId: orgId,
        incidentId,
        sessionId: sid,
        updatedBy: "ui",
      });
      if (!out?.ok) throw new Error(out?.error || "submit failed");
      toast("Session submitted ✓", 2000);
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "submit failed";
      toast(`Submit failed: ${msg}`, 3500);
    } finally {
      setSubmitting(false);
    }
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
  // Display-only gate for the Overview readiness checklist. Broader
  // than isClosed so the checklist also hides once the record has
  // moved into the customer-review corridor (submitted, accepted,
  // rejected) — at those points the page should not be telling the
  // operator "Proof package incomplete." isClosed semantics stay
  // strict ("closed" only) so write-action gates elsewhere on this
  // page are unaffected.
  const isSealedOrPostReview =
    isClosed ||
    ["customer_accepted", "customer_rejected", "submitted_to_customer"]
      .includes(String(incidentStatus || "").toLowerCase());
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

  async function closeIncident() {
    if (isClosed) {
      toast("Incident already closed.", 1800);
      return;
    }
    const ok = window.confirm("Close this incident? This sets read-only mode.");
    if (!ok) return;
    try {
      setClosingIncident(true);
      const res = await authedFetch("/api/fn/closeIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
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
      toast("Incident closed ✓", 2200);
    } catch (e: any) {
      toast("Close failed: " + String(e?.message || e), 3200);
    } finally {
      setClosingIncident(false);
    }
  }

  async function createJob() {
    if (isFieldWorkLocked(incidentStatus)) return toast("This record is locked from field work.", 2600);
    const title = String(jobTitle || "").trim();
    if (!title) return toast("Job title is required.", 2200);
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
      setShowCreateJob(false);
      setJobTitle("");
      setJobAssignedTo("");
      setJobNotes("");
      await refresh();
      toast("Job created ✓", 1800);
    } catch (e: any) {
      if (isIncidentClosedError(e)) {
        toast("Incident is closed (read-only).", 2600);
        return;
      }
      toast("Create job failed: " + String(e?.message || e), 3200);
    } finally {
      setJobsBusy(false);
    }
  }

  async function setJobStatus(jobId: string, status: JobStatus) {
    if (isFieldWorkLocked(incidentStatus)) return toast("This record is locked from field work.", 2600);
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
      toast("Job status updated ✓", 1500);
      return true;
    } catch (e: any) {
      if (isIncidentClosedError(e)) {
        toast("Incident is closed (read-only).", 2600);
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
    if (isFieldWorkLocked(incidentStatus)) return toast("This record is locked from field work.", 2600);
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
      toast("Job assignment updated ✓", 1800);
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
    if (isFieldWorkLocked(incidentStatus)) return toast("This record is locked from field work.", 2600);
    const jid = String(currentJobId || "").trim();
    if (!jid) return toast("Select My job first.", 2200);
    const completeOk = window.confirm("Mark complete?");
    if (!completeOk) return;
    await setJobStatus(jid, "complete");
  }

  async function assignAllUnassignedToCurrentJob() {
    if (isFieldWorkLocked(incidentStatus)) return toast("This record is locked from field work.", 2600);
    const jid = String(currentJobId || "").trim();
    if (!jid) return toast("Select My job first.", 2200);

    const unassignedIds = (evidence || [])
      .filter((ev: any) => !String(ev?.jobId || ev?.evidence?.jobId || "").trim())
      .map((ev: any) => String(ev?.id || "").trim())
      .filter(Boolean);

    if (unassignedIds.length === 0) {
      toast("No unassigned evidence found.", 2000);
      return;
    }

    // Optimistic: show immediate attachment in rows.
    const unassignedSet = new Set(unassignedIds);
    setEvidence((prev: any[]) =>
      (Array.isArray(prev) ? prev : []).map((ev: any) =>
        unassignedSet.has(String(ev?.id || ""))
          ? {
              ...ev,
              evidence: { ...(ev?.evidence || {}), jobId: jid },
              jobId: jid,
            }
          : ev
      )
    );

    let assigned = 0;
    let closedHit = false;
    let idx = 0;
    const limit = Math.min(5, unassignedIds.length);
    setJobsBusy(true);
    try {
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
              jobId: jid,
            });
            if (!out?.ok) throw new Error(out?.error || "assignEvidenceToJobV1 failed");
            assigned += 1;
          } catch (e: any) {
            if (isIncidentClosedError(e)) closedHit = true;
          }
        }
      };
      await Promise.all(Array.from({ length: limit }, () => worker()));
      await refresh();
      if (closedHit) {
        toast("Incident is closed (read-only).", 2600);
      } else {
        toast(`Assigned ${assigned} evidence items.`, 2200);
      }
    } finally {
      setJobsBusy(false);
    }
  }

  async function assignEvidenceJob(evidenceId: string, jobIdRaw: string) {
    if (isFieldWorkLocked(incidentStatus)) return toast("This record is locked from field work.", 2600);
    const nextJobId = String(jobIdRaw || "").trim();
    setEvidence((prev: any[]) =>
      (Array.isArray(prev) ? prev : []).map((ev: any) =>
        String(ev?.id || "") === String(evidenceId || "")
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
      const out: any = await postJson(`/api/fn/assignEvidenceToJobV1`, {
        orgId,
        incidentId,
        evidenceId,
        jobId: nextJobId || null,
      });
      if (!out?.ok) throw new Error(out?.error || "assignEvidenceToJobV1 failed");
      await refresh();
      toast("Evidence job assignment updated ✓", 1600);
    } catch (e: any) {
      if (isIncidentClosedError(e)) {
        toast("Incident is closed (read-only).", 2600);
      } else {
        toast("Assign evidence failed: " + String(e?.message || e), 3200);
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
    // PEAKOPS_INCIDENT_MISSING_ORG_GUARD_V1 (2026-05-15)
    // Short-circuit when no orgId is in the URL. Without this guard
    // refresh() would still fire its 5-call fan-out with empty
    // orgId, each hitting the server's mustStr() check and returning
    // 400. The component conditionally renders a missing-org panel
    // below, so suppressing the network noise here keeps DevTools
    // clean and avoids any toast-error flash from setRefreshError.
    if (!orgId) {
      setLoading(false);
      return;
    }
    if (process.env.NODE_ENV !== "production") {
      console.debug("[inc-refresh] start", { incidentId, orgId, functionsBase: base, fallbackUsed });
    }
    setLoading(true);
    setRefreshError(null);

    try {
      let requestOrgId = String(orgId || "").trim();
      const failHttp = (name: string, url: string, status: number, body: string) => {
        const err: any = new Error(`${name} failed (${status})`);
        err.endpoint = url;
        err.status = status;
        err.body = String(body || "").slice(0, 500);
        throw err;
      };
      const fetchTextOrThrow = async (name: string, url: string) => {
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
        setIncidentUpdatedAtSec(updatedSec || null);
        // PEAKOPS_INCIDENT_HERO_CONVERGENCE_V1 (PR 56)
        // Plumb title + location for the Summary-style hero. Both
        // are read-only here; the wire doc shape is unchanged.
        setIncidentTitle(String(inc?.doc?.title || "").trim());
        setIncidentLocation(String(inc?.doc?.location || "").trim());
        setIncidentArchetype(String(inc?.doc?.archetype || "").trim());
        const nextOrg = String(inc?.doc?.orgId || "").trim();
        if (nextOrg) requestOrgId = nextOrg;
      }

      const jobsUrl =
        `/api/fn/listJobsV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=50` +
        `&actorUid=${encodeURIComponent(actorUid())}&actorRole=${encodeURIComponent(actorRole())}`;
      const jobsBody = await fetchTextOrThrow("listJobsV1", jobsUrl);
      if (process.env.NODE_ENV !== "production") {
        let jobsCount = 0;
        let statuses: string[] = [];
        try {
          const parsed = jobsBody ? JSON.parse(jobsBody) : {};
          const docs = Array.isArray(parsed?.docs) ? parsed.docs : [];
          jobsCount = docs.length;
          statuses = docs.map((j: any) => String(j?.status || ""));
        } catch {}
        console.debug("[inc-refresh] jobs", {
          httpStatus: 200,
          ok: true,
          count: jobsCount,
          statuses,
        });
      }
      const jb = jobsBody ? JSON.parse(jobsBody) : {};
      if (jb?.ok && Array.isArray(jb.docs)) {
        const docs = jb.docs;
        setJobs(docs);
        const selectable = docs.filter((j: any) => isFieldSelectableJob(j?.status));
        const currentId = String(currentJobId || "").trim();
        const existsInSelectable = selectable.some((j: any) => String(j?.id || j?.jobId || "") === currentId);
        const firstSelectableId = String(selectable?.[0]?.id || selectable?.[0]?.jobId || "").trim();
        let effectiveJobId = currentId;
        if (!currentId || !existsInSelectable) {
          if (firstSelectableId) {
            setCurrentJobId(firstSelectableId);
            effectiveJobId = firstSelectableId;
          } else {
            setCurrentJobId("");
            effectiveJobId = "";
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

      // Evidence (GET-only)
      const evUrl =
        `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
      const evBody = await fetchTextOrThrow("listEvidenceLocker", evUrl);
      if (process.env.NODE_ENV !== "production") {
        let evidenceCount = 0;
        let evOk = false;
        try {
          const parsed = evBody ? JSON.parse(evBody) : {};
          const docs = Array.isArray(parsed?.docs) ? parsed.docs : [];
          evidenceCount = docs.length;
          evOk = !!parsed?.ok;
        } catch {}
        console.debug("[inc-refresh] evidence", {
          httpStatus: 200,
          ok: evOk,
          count: evidenceCount,
        });
      }
      const ev = evBody ? JSON.parse(evBody) : {};

      if (ev?.ok && Array.isArray(ev.docs)) {
        setEvidence(ev.docs);
        
      prefetchThumbs(ev.docs);
      // PHASE3_THUMBS_RETRY_SCHEDULED: re-try failed thumbs once
        

      // PEAKOPS_THUMBS_RETRY_EFFECT_V1
      // Retry failed thumbs once after a short delay (keeps the rail feeling “alive”)
      setTimeout(() => {
        try {
          const latest = (ev.docs || []).filter((x:any) => x?.file?.storagePath);
          latest.forEach((x:any) => {
            const id = String(x?.id || "");
            if (!id) return;
            if (thumbErr?.[id]) {
              // clear the error so prefetchThumbs will try again
              setThumbErr((m:any) => ({ ...m, [id]: false }));
            }
          });
          retryThumbs(latest);
        } catch {}
      }, 800);

if (selectedEvidenceId && !ev.docs.some((d:any) => d.id === selectedEvidenceId)) {
          setSelectedEvidenceId("");
        }
      }

      // Timeline (GET-only)
      const tlUrl =
        `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
      const tlBody = await fetchTextOrThrow("getTimelineEventsV1", tlUrl);
      const tl = tlBody ? JSON.parse(tlBody) : {};

      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs: TimelineDoc[] = tl.docs.slice();
        docs.sort((a, b) => (b.occurredAt?._seconds || 0) - (a.occurredAt?._seconds || 0));
        setTimeline(docs.filter((x) => x.type !== "DEBUG_EVENT"));
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
      if (process.env.NODE_ENV !== "production") {
        console.debug("[inc-refresh] error", {
          endpoint: diag.endpoint,
          status: diag.status,
          body: String(diag.body || "").slice(0, 500),
          message: diag.message,
          stack: String((e as any)?.stack || ""),
        });
      }
      console.error("refresh failed", {
        functionsBase: base,
        incidentId,
        endpoint: diag.endpoint,
        status: diag.status,
        body: String(diag.body || "").slice(0, 500),
        error: diag.message,
        fallback: fallbackUsed,
      });
      setDataStatus("error");
    } finally {
      setLoading(false);
      // PEAKOPS_INCIDENT_HERO_HYDRATION_V1 (tiny PR)
      // Flip the first-load gate. Even when refresh() errors out we
      // mark the page as "hydrated" so the meta line stops showing
      // its zero-state placeholder forever — the error banner takes
      // over the visible feedback instead.
      setHasInitialLoad(true);
    }
  }

  // Prefetch signed thumbnail URLs for latest 12 evidence items
  async function prefetchThumbs(latest: EvidenceDoc[]) {
    const want = latest.filter((x) => x.file?.storagePath);

    await Promise.all(
      want.map(async (ev) => {
        const ref = getBestEvidenceImageRef(ev);
        if (!ref?.storagePath || !ref?.bucket) return;
        if (thumbUrl[ev.id] && thumbPathById[ev.id] === ref.storagePath) return;

        try {
          const resp = await mintEvidenceReadUrl({
            orgId,
            incidentId,
            evidenceId: ev.id,
            storagePath: ref.storagePath,
            bucket: ref.bucket,
            expiresSec: getThumbExpiresSec(),
          });
          if (resp?.ok && resp.url) {
            setThumbUrl((m) => ({ ...m, [ev.id]: resp.url! }));
            setThumbPathById((m) => ({ ...m, [ev.id]: ref.storagePath }));
            setThumbBucketById((m) => ({ ...m, [ev.id]: ref.bucket }));
            setThumbRetryById((m) => ({ ...m, [ev.id]: 0 }));
            setThumbDiagById((m) => {
              if (!m[ev.id]) return m;
              const n = { ...m };
              delete n[ev.id];
              return n;
            });
            setThumbStatusById((m) => ({ ...m, [ev.id]: Number(resp?.status || 200) }));
            setThumbMintErrorById((m) => ({ ...m, [ev.id]: "-" }));
            setThumbProbeStatusById((m) => ({ ...m, [ev.id]: 0 }));
            setThumbProbeErrorById((m) => ({ ...m, [ev.id]: "-" }));
            setThumbErr((m) => ({ ...m, [ev.id]: false }));
          }
        } catch (e) {
          console.warn("thumb prefetch failed", ev.id, e);
          setThumbDiagById((m) => ({ ...m, [ev.id]: String((e as any)?.message || e || "thumb_prefetch_failed") }));
          setThumbMintErrorById((m) => ({ ...m, [ev.id]: String((e as any)?.message || e || "thumb_prefetch_failed") }));
          setThumbErr((m) => ({ ...m, [ev.id]: true }));
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

        const hadErr = !!(thumbErr as any)?.[id];
        const hasUrl = !!(thumbUrl as any)?.[id];
        const samePath = String((thumbPathById as any)?.[id] || "") === ref.storagePath;
        if (!hadErr && hasUrl && samePath) {
          continue;
        }

        try {
          const resp = await mintEvidenceReadUrl({
            orgId,
            incidentId,
            evidenceId: id,
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
    const retryN = Number(thumbRetryById[id] || 0);
    if (retryN >= 1) {
      setThumbErr((m) => ({ ...m, [id]: true }));
      setThumbDiagById((m) => ({ ...m, [id]: m[id] || "read_url_failed" }));
      return;
    }
    const ref = getBestEvidenceImageRef(ev);
    if (!ref?.bucket || !ref?.storagePath) {
      setThumbErr((m) => ({ ...m, [id]: true }));
      setThumbDiagById((m) => ({ ...m, [id]: "missing_bucket_or_storagePath" }));
      return;
    }
    setThumbRetryById((m) => ({ ...m, [id]: retryN + 1 }));
    if (process.env.NODE_ENV !== "production") {
      logThumbEvent("img_error", {
        evidenceId: id,
        kind: ref.kind,
        bucket: ref.bucket,
        storagePath: ref.storagePath,
        src: currentSrc,
        retryCount: retryN,
      });
    }
    logThumbEvent("retry_start", { evidenceId: id, kind: ref.kind, storagePath: ref.storagePath, retryCount: retryN });
    const out = await mintEvidenceReadUrl({
      orgId,
      incidentId,
      evidenceId: id,
      bucket: ref.bucket,
      storagePath: ref.storagePath,
      expiresSec: getThumbExpiresSec(),
    });
    if (out?.ok && out.url) {
      // PEAKOPS_NO_POST_SIGN_CACHEBUST_V1 (2026-05-15)
      // Use the minted GCS signed URL as-is; appending a cache-buster
      // here voids the V4 signature (see signedThumb.ts for details).
      const fresh = out.url;
      setThumbUrl((m) => ({ ...m, [id]: fresh }));
      setThumbPathById((m) => ({ ...m, [id]: ref.storagePath }));
      setThumbBucketById((m) => ({ ...m, [id]: ref.bucket }));
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      setThumbErr((m) => ({ ...m, [id]: false }));
      setThumbDiagById((m) => {
        if (!m[id]) return m;
        const n = { ...m };
        delete n[id];
        return n;
      });
      setThumbStatusById((m) => ({ ...m, [id]: Number(out?.status || 200) }));
      setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
      setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
      setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
      if (!functionsBaseIsLocal) {
        void probeMintedThumbUrl(fresh).then((probe) => {
          const pmsg = probe.ok ? "" : (probe.status > 0 ? `probe_http_${probe.status}` : String(probe.error || "probe_failed"));
          setThumbProbeStatusById((m) => ({ ...m, [id]: Number(probe.status || 0) }));
          setThumbProbeErrorById((m) => ({ ...m, [id]: pmsg || "-" }));
          setThumbDiagById((m) => ({
            ...m,
            [id]: `mint_http=${Number(out?.mintHttp || out?.status || 200)} mint_error=- probe_http=${Number(probe.status || 0)} probe_error=${pmsg || "-"}`,
          }));
          if (!probe.ok) {
            logThumbEvent("retry_fail", {
              evidenceId: id,
              kind: ref.kind,
              storagePath: ref.storagePath,
              status: Number(probe.status || 0),
              error: pmsg || "probe_failed",
            });
          }
        });
      }
      logThumbEvent("retry_ok", { evidenceId: id, kind: ref.kind, storagePath: ref.storagePath });
      return;
    }
    const mintErr = String(out?.error || "read_url_failed");
    const mintDetails = out?.details ? String(JSON.stringify(out.details)).slice(0, 180) : "";
    const mintStatus = Number(out?.mintHttp || out?.status || 0) || 0;
    const showFail = retryN >= 1;
    setThumbErr((m) => ({ ...m, [id]: showFail }));
    setThumbStatusById((m) => ({ ...m, [id]: Number(out?.status || 0) || 0 }));
    setThumbMintErrorById((m) => ({ ...m, [id]: `${mintErr}${mintDetails ? `:${mintDetails}` : ""}` }));
    setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
    setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
    setThumbDiagById((m) => ({
      ...m,
      [id]: `${showFail ? "" : "retrying:"}mint_http=${mintStatus} mint_error=${mintErr}${mintDetails ? `:${mintDetails}` : ""} probe_http=- probe_error=-`,
    }));
    logThumbEvent("retry_fail", {
      evidenceId: id,
      kind: ref.kind,
      storagePath: ref.storagePath,
      status: mintStatus,
      error: mintErr,
    });
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
      "px-2 py-1 rounded-full bg-amber-400/12 border border-amber-300/25 text-amber-200 " +
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
    if (process.env.NODE_ENV === "production") return;
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
      // Preserve orgId on the post-notesSaved cleanup redirect. Dropping
      // the query string here lands the user on bare `/incidents/{id}`,
      // which the missing-orgId guard (PR #24) then renders as
      // "Incident unavailable" until the user manually re-adds orgId.
      const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
      router.replace(`/incidents/${incidentId}${qs}`, { scroll: false } as any);
    } catch {}
  }, [sp, incidentId, orgId]);
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
useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidence]);

  function scrollToEvidence(eid: string) {
    try {
      const el = document.getElementById(`ev-${eid}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {}
  }

  function openModal(ev: EvidenceDoc) {
    const u = thumbUrl[ev.id];
    setPreviewName(ev.file?.originalName || ev.id);
    setPreviewUrl(u || "");
    setSelectedEvidenceId(ev.id);
    setPreviewOpen(true);
    toast("Opened preview");
    (async () => {
      try {
        const ref = getBestEvidenceImageRef(ev);
        if (!ref?.storagePath || !ref?.bucket) return;
        const resp = await mintEvidenceReadUrl({
          orgId,
          incidentId,
          evidenceId: ev.id,
          storagePath: ref.storagePath,
          bucket: ref.bucket,
          expiresSec: getThumbExpiresSec(),
        });
        if (resp?.ok && resp.url) setPreviewUrl(resp.url);
      } catch {}
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

  // PEAKOPS_NEXTBESTACTION_V1
  const _hasSession = Array.isArray(timeline) && timeline.some((t: any) => String(t?.type) === "SESSION_STARTED" || String(t?.type) === "FIELD_ARRIVED" || String(t?.type) === "EVIDENCE_ADDED");
  const _evidenceN = Array.isArray(evidence) ? evidence.filter((ev: any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath||"").includes("demo_placeholder")).length : 0;
  const _hasEvidence = _evidenceN >= 4;
  const _hasNotes = !!(notesSavedLocal || (Array.isArray(timeline) && timeline.some((t: any) => String(t?.type) === "NOTES_SAVED")));
  const _hasApproved = Array.isArray(jobs) && jobs.length > 0 && jobs.every((j: any) => {
    const rs = String(j?.reviewStatus || "").trim().toLowerCase();
    const st = String(j?.status || "").trim().toLowerCase();
    return rs === "approved" || st === "approved";
  });

  // PHASE6_1_TIMERS_V1
  const _secForType = (ty: string): number | null => {
    try {
      let best = 0;
      for (const t of (timeline || []) as any[]) {
        if (String(t?.type || "") !== ty) continue;
        const sec = Number(t?.occurredAt?._seconds || 0);
        if (sec > best) best = sec;
      }
      return best ? best : null;
    } catch {
      return null;
    }
  };

  const _arrivalSec = _secForType("FIELD_ARRIVED");
  const _notesSec = _secForType("NOTES_SAVED");

  // Prefer timeline event; fallback to latest evidence timestamp if needed
  const _evidenceSecFromTL = _secForType("EVIDENCE_ADDED");
  const _evidenceSecFromDocs =
    (Array.isArray(evidence) && evidence[0] && (evidence[0] as any).storedAt?._seconds) ||
    (Array.isArray(evidence) && evidence[0] && (evidence[0] as any).createdAt?._seconds) ||
    null;

  const _lastEvidenceSec = _evidenceSecFromTL || (_evidenceSecFromDocs ? Number(_evidenceSecFromDocs) : null);

  const _arrivalAgo = _arrivalSec ? fmtAgo(_arrivalSec) : "—";
  const _evidenceAgo = _lastEvidenceSec ? fmtAgo(_lastEvidenceSec) : "—";
  const _notesAgo = _notesSec ? fmtAgo(_notesSec) : "—";

  return (
    invalidIncidentRoute ? (
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="p-6">
          <div className="max-w-2xl mx-auto rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5">
            <div className="text-sm text-amber-100 font-semibold">Invalid incident URL</div>
            <div className="mt-2 text-sm text-amber-50/90">
              This page was opened with a placeholder incident id (`/incidents/&lt;incidentId&gt;`).
            </div>
            <div className="mt-3 text-xs text-amber-100/80">
              Open `/incidents/inc_demo` or a real incident id instead.
            </div>
          </div>
        </div>
      </main>
    ) : !orgId ? (
      /* PEAKOPS_INCIDENT_MISSING_ORG_GUARD_V1 (2026-05-15)
         Safe missing-org panel. Renders instead of the main UI when
         the URL has no `?orgId=...` query param. The mirror guard in
         refresh() above prevents any /api/fn/* network calls from
         firing while this panel is shown. */
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="p-6">
          <div className="max-w-2xl mx-auto rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5">
            <div className="text-sm text-amber-100 font-semibold">Incident unavailable</div>
            <div className="mt-2 text-sm text-amber-50/90">
              This incident page needs an <code className="px-1 py-0.5 rounded bg-white/10">orgId</code> in the URL to load.
            </div>
            <div className="mt-3 text-xs text-amber-100/80">
              Open this incident from the Dashboard or Incidents list, or include{" "}
              <code className="px-1 py-0.5 rounded bg-white/10">?orgId=&lt;your-org-id&gt;</code> in the URL.
            </div>
          </div>
        </div>
      </main>
    ) : (
    <main
      className="min-h-screen bg-black text-white"
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
      <AppTopBar />

      {/* PEAKOPS_INCIDENT_HERO_CONVERGENCE_V1 (PR 56)
          Identity hero. Replaces the prior "Field Incident /
          {incidentId} • {orgId} / status: closed / updated: Xd"
          debug-coded top bar with the Summary-style dossier shell:
          eyebrow ("INCIDENT RECORD · ORGID"), incident.title as H1
          (raw ID never appears as the page title), location below
          the title when present, and a meta line with the shared
          StateChip + job count + evidence count + last activity.
          Demo Mode chip + Reset demo button are gated behind
          NODE_ENV !== "production" so they no longer leak to the
          customer/demo surface. */}
      <div className="px-4 pt-4 pb-3 border-b border-white/10 sticky top-0 bg-black/80 backdrop-blur z-10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* PEAKOPS_FRAMING_LAYER_V1 (PR 71) — eyebrow word swap.
                "Incident Record" → "Field Record". Routes, RecordNav
                labels, and status pipeline unchanged. */}
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
              Field Record
              {orgId ? ` · ${orgId.toUpperCase()}` : ""}
            </div>
            <h1 className="mt-1 text-xl sm:text-2xl font-semibold leading-tight tracking-tight text-white truncate">
              {incidentTitle || "Untitled incident"}
            </h1>
            {incidentLocation ? (
              <div className="mt-0.5 text-[12px] text-gray-300 truncate">
                {incidentLocation}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-400">
              {/* PEAKOPS_INCIDENT_HERO_HYDRATION_V1 (tiny PR)
                  Pre-hydration the meta line was flashing
                  "[open] · 0 jobs · 0 pieces of evidence" against
                  the initial useState defaults before refresh()
                  resolved. Now we render a single calm
                  "loading record details…" line until hasInitialLoad
                  flips true, then swap in the real counts. The chip
                  is also withheld so we don't briefly assert
                  "open" against an incident that's actually closed. */}
              {!hasInitialLoad ? (
                <span className="text-gray-500 italic">
                  loading record details…
                </span>
              ) : (
                <>
                  <span
                    className={
                      "text-[11px] px-2 py-0.5 rounded-full border " +
                      incidentStatusPill(incidentStatus || "open")
                    }
                  >
                    {incidentStatusLabel(incidentStatus || "open")}
                  </span>
                  <span className="text-white/20">·</span>
                  <span>
                    {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
                  </span>
                  <span className="text-white/20">·</span>
                  {/* PEAKOPS_INCIDENT_HERO_EVIDENCE_COUNT_V1 (tiny PR)
                      Use the same filtered evidence count the Evidence
                      tab tile renderer and the Readiness check already
                      use (_evidenceN at module scope above): drops docs
                      missing file.storagePath and drops demo_placeholder
                      entries. */}
                  <span>
                    {_evidenceN}{" "}
                    {/* PR 88 — proof vocabulary on the header meta. */}
                    {_evidenceN === 1 ? "proof item" : "proof items"}
                  </span>
                  {incidentUpdatedAtSec ? (
                    <>
                      <span className="text-white/20">·</span>
                      <span>last activity {fmtAgo(incidentUpdatedAtSec)}</span>
                    </>
                  ) : null}
                </>
              )}
              {/* PEAKOPS_INCIDENT_HERO_CONVERGENCE_V1 (PR 56)
                  Demo Mode chip + Reset demo button stay accessible
                  on localhost (NODE_ENV !== "production") for
                  internal demo state seeding, but no longer leak
                  to the live customer-facing app. */}
              {isDemoMode && process.env.NODE_ENV !== "production" ? (
                <>
                  <span className="text-white/20">·</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-blue-500/15 border-blue-300/30 text-blue-100">
                    Demo Mode
                  </span>
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded-full border bg-white/6 border-white/12 text-gray-200 hover:bg-white/10 text-[11px]"
                    onClick={() => { void copyDemoResetCommand(); }}
                    title="Copy deterministic demo reset command"
                  >
                    Reset demo (copy command)
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {/* PEAKOPS_INCIDENT_HERO_CONVERGENCE_V1 (PR 56)
              CTA hierarchy:
                Sealed: Summary (primary, white background) + Review
                        (neutral chip). Close Incident removed.
                Open:   Review + Close Incident (muted amber, no
                        longer destructive-red) + Summary.
              All routes preserve orgId so downstream guards don't
              trigger. */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className="px-3 py-1.5 rounded-full text-xs bg-white/8 border border-white/15 text-gray-200 hover:bg-white/12 transition"
              title="Supervisor review + approve/lock"
              onClick={() => {
                const id = String(incidentId || "");
                if (!id || id.includes("${")) return;
                const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
                router.push(`/incidents/${id}/review${qs}`);
              }}
            >
              Review
            </button>
            {!isClosed ? (
              <button
                type="button"
                className="px-3 py-1.5 rounded-full text-xs bg-amber-500/15 border border-amber-300/25 text-amber-100 hover:bg-amber-500/25 transition disabled:opacity-50"
                disabled={closingIncident}
                onClick={() => { try { closeIncident(); } catch {} }}
                title="Set incident status to closed"
              >
                {closingIncident ? "Closing..." : "Close Incident"}
              </button>
            ) : null}
            <button
              type="button"
              className={
                "px-3 py-1.5 rounded-full text-xs border transition " +
                (isClosed
                  ? "bg-white text-black border-white/30 hover:bg-white/90"
                  : "bg-white/8 border-white/15 text-gray-200 hover:bg-white/12")
              }
              onClick={() => {
                const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
                try {
                  router.push(`/incidents/${incidentId}/summary${qs}`);
                } catch {}
              }}
              title="Open incident summary"
            >
              Summary
            </button>
          </div>
        </div>

        {/* PEAKOPS_UX_TOAST_RENDER_V1 */}
        {toastMsg ? (
          <div className="pointer-events-none fixed left-1/2 -translate-x-1/2 top-20 z-50 px-3 py-2 rounded-xl bg-black/70 border border-white/10 text-sm text-gray-100 backdrop-blur shadow-[0_12px_40px_rgba(0,0,0,0.55)]">
            {toastMsg}
          </div>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          {(["overview", "timeline", "evidence", "jobs"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={
                "px-3 py-1.5 rounded-lg text-xs border transition " +
                (activeTab === tab
                  ? "bg-cyan-500/20 border-cyan-300/35 text-cyan-100"
                  : "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10")
              }
              onClick={() => setTab(tab)}
            >
              {/* PR 88 — Evidence tab label flips to Proof. State key
                  stays "evidence" (no logic change). */}
              {tab === "overview" ? "Overview" : tab === "timeline" ? "Timeline" : tab === "evidence" ? "Proof" : "Jobs"}
            </button>
          ))}
        </div>

        {/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
            (Panel moved out of the sticky masthead in PR 67 so the
            RecordNav breadcrumb reads above the sealed card. The
            actual <SealedRecordPanel> render now lives below the
            RecordNav strip; see PEAKOPS_BREADCRUMB_PLACEMENT_V1. */}

{/* PEAKOPS_ACTIVE_JOB_CARD_UI_V1 */}
{/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
    Mutation card carries Capture Evidence / Mark Complete / Send to
    Review affordances. On sealed records the operational record is
    immutable; the card is hidden entirely and the calm sealed-state
    informational panel below takes its place on the overview tab. */}
{!isClosed && (() => {
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
          <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-amber-200/90">Update requested</div>
                <div className="text-sm text-amber-100 mt-1 break-words">
                  {reqMsg ? reqMsg : "Supervisor requested an update."}
                </div>
                {reqJobId ? (
                  <div className="text-xs text-amber-200/80 mt-1">jobId: {reqJobId}</div>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm text-amber-50"
                  onClick={() => { try { setTab("timeline"); } catch { try { location.hash="#timeline"; } catch {} } }}
                >
                  View timeline
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm text-amber-50"
                  onClick={() => { try { setTab("evidence"); } catch { try { document.getElementById("evidence")?.scrollIntoView({behavior:"smooth"}); } catch {} } }}
                >
                  Go to evidence
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="rounded-2xl bg-white/5 border border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              {/* PR 88 — "My active job" → "Work package" + calmer
                  empty state when no job is bound. The status:n/a
                  line is suppressed in the empty branch so the card
                  reads as a friendly prompt instead of a debug dump. */}
              <div className="text-[11px] uppercase tracking-wide text-gray-400">Work package</div>
              {activeJobId || jobTitle ? (
                <>
                  <div className="text-sm text-gray-200 mt-1 truncate">
                    {jobTitle || `Job ${activeJobId}`}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    status: <span className="text-gray-200">{jobStatus || "n/a"}</span>
                    {locked ? <span className="ml-2 text-emerald-200">• locked</span> : null}
                  </div>
                </>
              ) : (
                <div className="text-sm text-gray-300 mt-1 leading-relaxed">
                  No active job yet. Capture your first proof item to start the session.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {activeJobId ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 hover:bg-white/10 text-sm text-gray-100"
                  onClick={() => {
                    try {
                      const url = `/jobs/${encodeURIComponent(String(activeJobId||""))}?incidentId=${encodeURIComponent(String(incidentId||""))}&orgId=${encodeURIComponent(String(orgId||""))}`;
                      router.push(url);
                    } catch (e) { console.error(e); }
                  }}
                >
                  Open job
                </button>
              ) : null}
              {/* Add proof routes into the field-evidence upload flow.
                  Hidden on closed and post-review records — no proof
                  mutation should be reachable from a locked record. */}
              {!isFieldWorkLocked(incidentStatus) ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl border text-sm transition bg-white/6 border-white/10 hover:bg-white/10 text-gray-100"
                  onClick={() => { try { goAddEvidence(); } catch (e) { console.error(e); } }}
                  title="Add proof"
                >
                  Add proof
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
})()}


      </div>

      {/* Secondary route-bridge strip removed (was: Dashboard · Incident ·
          Summary · Review). The main top nav already covers Dashboard;
          the Incident tab row below covers Overview / Timeline / Proof /
          Jobs; Summary and Review still render their own RecordNav for
          inbound traffic from outside. */}

      {/* PEAKOPS_CAPTURE_PROOF_NEXT_STEP_V1 (PR 70)
          Next-step banner that fires when the user has just landed
          here from the /incidents/new create flow (PR 70). The
          create handler appends `?next=capture-proof` to the
          destination URL; this banner reads it and surfaces a single
          calm CTA to the existing /add-evidence flow.

          "Skip for now" strips the param via router.replace so the
          banner dismisses without leaving the record. Open-state
          only — sealed records have their own dossier panel and
          don't need a "first step" affordance. */}
      {!isFieldWorkLocked(incidentStatus) && sp?.get("next") === "capture-proof" ? (
        <div className="px-4 pt-3">
          <div className="rounded-2xl border border-amber-300/25 bg-amber-500/[0.05] px-4 py-4 sm:px-5 sm:py-5 space-y-3">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
              Next step
            </div>
            <div className="text-lg font-semibold text-white leading-snug">
              Capture proof
            </div>
            {/* PEAKOPS_ACCEPTANCE_LIFECYCLE_FRAMING_V1 (PR 84) — banner
                copy reframed from the generic "document the field
                conditions" line to the acceptance-lifecycle sentence,
                so the operator reads the draft → approval → accepted
                arc at the moment of first arrival. */}
            <p className="text-[13px] text-gray-300 leading-relaxed max-w-prose">
              This field record is in draft until required proof is
              captured and submitted for approval.
            </p>
            {/* PEAKOPS_ARCHETYPE_AWARE_BANNER_V1 (PR 84) — per-archetype
                required-proof checklist surfaces when the doc carries
                a known archetype value. Legacy archetype keys
                (splice_work, site_survey, cable_install) return null
                from getArchetypeDetails and the section is omitted —
                the banner still lands cleanly without it. */}
            {(() => {
              const details = getArchetypeDetails(incidentArchetype);
              if (!details) return null;
              return (
                <div className="rounded-lg border border-amber-300/15 bg-black/[0.25] px-3 py-3 space-y-1.5">
                  <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-amber-200/60">
                    Required proof · {details.label}
                  </div>
                  <ul className="space-y-1 text-[12px] text-gray-200">
                    {details.requiredProof.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <span aria-hidden="true" className="text-emerald-300/70 mt-0.5">
                          ✓
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  const id = String(incidentId || "");
                  if (!id) return;
                  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
                  router.push(`/incidents/${encodeURIComponent(id)}/add-evidence${qs}`);
                }}
                className="px-4 py-2 rounded-full text-[12px] font-medium bg-white text-black hover:bg-white/90 transition-colors"
              >
                Capture proof →
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = String(incidentId || "");
                  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
                  router.replace(`/incidents/${encodeURIComponent(id)}${qs}`);
                }}
                className="px-3 py-1.5 rounded-full text-[12px] text-gray-400 hover:text-gray-100 transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* PEAKOPS_BREADCRUMB_PLACEMENT_V1 (PR 67)
          Sealed-record informational panel. Previously rendered inside
          the sticky masthead which placed it *above* the RecordNav
          breadcrumb on the Overview tab — the breadcrumb belongs
          between the identity hero and the sealed card, not below it.
          Moving the panel here keeps Overview's vertical rhythm in
          step with Timeline / Evidence / Jobs (which never had a
          sealed card competing with RecordNav). Renders only on the
          overview tab so it doesn't double up with the
          evidence/timeline informational content on those tabs.
          Routes "Create addendum" → /incidents/{id}/add-addendum and
          "Back to summary" → /incidents/{id}/summary. */}
      {isClosed && activeTab === "overview" ? (
        <div className="px-4 pt-3">
          <SealedRecordPanel
            variant="fullPage"
            title="Operational record sealed"
            body="This incident is closed. Field operations are complete and the record is immutable. Supplemental context attaches through addenda."
            orgId={orgId}
            incidentId={String(incidentId || "")}
          />
        </div>
      ) : null}

      <div className={"p-4 space-y-4 " + (contextLockId ? "opacity-[0.94] transition-opacity" : "")}>
        {refreshError ? (
          <div className="rounded-xl border border-red-400/30 bg-red-500/10 text-red-100 text-xs px-3 py-2">
            <div className="font-semibold">Refresh failed</div>
            <div className="mt-1 break-all">{refreshError.message}</div>
            {refreshError.endpoint ? <div className="mt-1 break-all text-red-200/90">endpoint: {refreshError.endpoint}</div> : null}
            {refreshError.fallback ? <div className="mt-1 text-red-200/90">fallback: applied</div> : null}
            {process.env.NODE_ENV !== "production" && getEnvFunctionsBase() ? (
              <div className="mt-1 text-red-200/90">envBase present, fallback disabled</div>
            ) : null}
            {process.env.NODE_ENV !== "production" && (functionsBaseIsLocal || isDemoMode) ? (
              <button
                type="button"
                className="mt-2 px-2 py-1 rounded border border-red-300/30 bg-black/30 hover:bg-black/50 text-[11px]"
                onClick={() => {
                  clearRememberedFunctionsBase();
                  try {
                    const envBase = getEnvFunctionsBase();
                    if (envBase) sessionStorage.setItem("peakops_last_functions_base_reset", envBase);
                  } catch {}
                  location.reload();
                }}
              >
                Reset connection
              </button>
            ) : null}
            {refreshError.status ? <div className="mt-1">status: {refreshError.status}</div> : null}
            {refreshError.body ? (
              <details className="mt-1">
                <summary className="cursor-pointer">response body</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words">{String(refreshError.body || "").slice(0, 500)}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
        
              
{/* PEAKOPS: removed big Open Notes bar */}
{/* PEAKOPS_NEXTBESTACTION_V1_RENDER */}
{/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
    NextBestAction is the operational cockpit (Arrive / Add Evidence /
    Open Notes / Submit). Suppressed on sealed records and on
    post-review records (submitted_to_customer, customer_accepted,
    customer_rejected) — the "Capture proof" / "Add proof" prompt
    surfaces an active mutation CTA, which is misleading once the
    record is locked from field work. */}
        {activeTab === "overview" && !isFieldWorkLocked(incidentStatus) ? (
		<NextBestAction
	  arrived={arrived}
	  hasSession={_hasSession}
	  hasEvidence={_hasEvidence}
	  hasNotes={_hasNotes}
	  hasApproved={_hasApproved}
	  archetypeLabel={getArchetypeDetails(incidentArchetype)?.label || ""}
	  onOpenNotes={() => {
    const o = String(sp?.get("orgId") || "").trim();
    const qs = o ? `?orgId=${encodeURIComponent(o)}` : "";
    router.push(`/incidents/${incidentId}/notes${qs}`);
  }}
	  onAddEvidence={() => {
      if (isClosed) return toast("Incident is closed (read-only).", 2600);
      // PR 112 — removed duplicate !hasActiveFieldJobs toast gate.
      // goAddEvidence() already handles isClosed; jobs are optional.
      goAddEvidence();
    }}
  onMarkArrived={() => { if (!isClosed) { try { markArrived(); } catch {} } else toast("Incident is closed (read-only).", 2600); }}
  onSubmitSession={() => { if (!isClosed) { try { submitSession(); } catch {} } else toast("Incident is closed (read-only).", 2600); }}
/>
        ) : null}

{/* PHASE6_1_TIMERS_V1_RENDER */}
        {/* PHASE6_1_TIMERS_POLISH_V2 + PHASE6_2_ACTION_NEEDED_V1 */}
{/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
    "Time since arrival / submission / approval" timers belong to the
    open-state operational cockpit. On a sealed record nothing more is
    going to happen — the timers just tick beside a closed banner.
    Hidden when isClosed. */}
{activeTab === "overview" && !isClosed && hasInitialLoad ? (
<div className="rounded-2xl bg-white/5 border border-white/10 p-4">
  <div className="flex items-center justify-between gap-3">
    <div className="text-[11px] uppercase tracking-wide text-gray-400">Timers</div>
    {/* Suppress "Action needed: notes" once the record has moved into
        the customer-review corridor — the operator can't add field
        notes after submission, so the amber prompt is a stale signal.
        Show the canonical lifecycle label so this chip reads the
        same word as the top status pill on the page, instead of a
        parallel "Awaiting customer review"-style framing. */}
    {isSealedOrPostReview ? (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 border border-white/15 text-gray-300">
        {incidentStatusLabel(incidentStatus)}
      </span>
    ) : _notesAgo === "—" ? (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-300/25 text-amber-100">
        Action needed: notes
      </span>
    ) : null}
  </div>

  <div className="mt-3 grid grid-cols-1 sm:grid-cols-5 gap-2">
    <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2 sm:col-span-1">
      {/* PR 85 — timer labels reframed as proof-capture milestones. */}
      <div className="text-[10px] uppercase tracking-wide text-gray-400">Site arrival</div>
      <div className="mt-1 text-base font-semibold text-gray-100">{_arrivalAgo}</div>
    </div>

    <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2 sm:col-span-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">Proof captured</div>
      <div className="mt-1 text-base font-semibold text-gray-100">{_evidenceAgo}</div>
    </div>

    <div
      className={
        "rounded-xl border px-3 py-2 sm:col-span-2 " +
        (_notesAgo === "—" && !isSealedOrPostReview
          ? "bg-amber-500/10 border-amber-300/25"
          : "bg-black/30 border-white/10")
      }>
      <div className={"text-[10px] uppercase tracking-wide " + (_notesAgo === "—" && !isSealedOrPostReview ? "text-amber-200/80" : "text-gray-400")}>
        Field notes
      </div>
      <div className={"mt-1 text-base font-semibold " + (_notesAgo === "—" && !isSealedOrPostReview ? "text-amber-50" : "text-gray-100")}>
        {_notesAgo}
      </div>
    </div>
  </div>
</div>
) : null}


        
        {/* PHASE5A_REQUEST_UPDATE_BANNER_V1 */}
        {activeTab === "overview" && reqUpdateText ? (
          <section className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-amber-200/80">
                  Supervisor requested an update
                </div>
                <div className="mt-1 text-sm text-amber-50/90 whitespace-pre-wrap break-words">
                  {reqUpdateText}
                </div>
                <div className="mt-2 text-[11px] text-amber-100/50">
                  (V2 demo: stored locally on this device. Phase B will persist to Firestore + notify.)
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-amber-50 hover:bg-white/10"
                  onClick={() => { try { loadReqUpdate(); } catch {} try { refresh(); } catch {} }}
                  title="Reload local request note"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-300/25 text-sm text-amber-50 hover:bg-amber-500/20"
                  onClick={() => {
                    clearReqUpdate();
                  }}
                  title="Clear this request note (local only)"
                >
                  Clear
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {/* PR 130b — Recovery field work surfaces inline at the top of
            overview as the FIRST thing the field user sees after the
            supervisor banner. Hidden when backend returns zero items.
            Refresh callback re-pulls incident + evidence so the row
            count for any newly-attached proof stays in sync. */}
        {activeTab === "overview" && orgId && incidentId && (
          <RecoveryWorkSection
            orgId={orgId}
            incidentId={incidentId}
            onWorkChanged={refresh}
          />
        )}

{/* Quick actions */}
        {activeTab === "evidence" ? (
        <section ref={myJobSectionRef} className="rounded-2xl bg-white/5 border border-white/10 p-4">
  <div className="flex items-center justify-between gap-2">
    {/* PR 88 — section header matches the tab label. Anchor id
        stays "#evidence" so any deep links keep working. */}
    <div className="text-xs uppercase tracking-wide text-gray-400" id="evidence">Proof</div>
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">Latest {Math.min(12, evidence.length)}</span>
      {process.env.NODE_ENV !== "production" ? (
        <>
          <button
            type="button"
            className="px-2 py-1 rounded border border-white/15 bg-white/5 text-[11px] text-gray-200 hover:bg-white/10"
            onClick={() => refreshVisibleThumbsDebounced()}
          >
            Refresh thumbnails
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded border border-white/15 bg-white/5 text-[11px] text-gray-200 hover:bg-white/10"
            onClick={() => forceRemintVisibleThumbs()}
          >
            Force remint URLs
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded border border-white/15 bg-white/5 text-[11px] text-gray-200 hover:bg-white/10"
            onClick={() => setThumbDebugOverlay((v) => !v)}
          >
            {thumbDebugOverlay ? "Hide thumb debug" : "Show thumb debug"}
          </button>
        </>
      ) : null}
    </div>
  </div>

  {/* Evidence rail centering depends on runway padding on #evidenceScroller. Keep that padding. */}
  <div className="mt-3 -mx-1 overflow-x-auto px-[calc(50%-74px)] scroll-smooth scroll-pl-4 scroll-pr-4 sm:scroll-pl-[calc(50vw-74px)] sm:scroll-pr-[calc(50vw-74px)]" id="evidenceScroller"
>
    <div className="flex gap-2 snap-x snap-mandatory">
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
                    "snap-start min-w-[132px] w-[132px] sm:min-w-[148px] sm:w-[148px] aspect-[4/3] relative rounded-xl overflow-hidden border " +
                    (selected ? "border-indigo-300/95 border-2 ring-4 ring-indigo-500/40 shadow-[0_0_0_1px_rgba(99,102,241,0.18),0_12px_40px_rgba(0,0,0,0.55)]  scale-[1.02] transition-transform duration-150" : "border-white/10 ") +
                    "bg-black/40 hover:border-white/25 transition"
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

                  <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                    {labels.slice(0, 2).map((l:string) => (
                      <span key={l} className={"text-[10px] px-2 py-0.5 rounded-full border " + labelChipColor(l)}>
                        {l}
                      </span>
                    ))}
                    {converting ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full border bg-amber-400/15 border-amber-300/30 text-amber-100">
                        Converting…
                      </span>
                    ) : null}
                    {uploadMissing ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full border bg-red-500/15 border-red-400/30 text-red-100">
                        Upload not in storage yet
                      </span>
                    ) : null}
                    {conversionFailed ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full border bg-red-500/15 border-red-400/30 text-red-100" title={conversionError || "HEIC conversion failed"}>
                        Convert failed
                      </span>
                    ) : null}
                    {conversionNoPreview ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full border bg-gray-500/15 border-gray-300/30 text-gray-100">
                        No preview
                      </span>
                    ) : null}
                  </div>

                  <div className="absolute bottom-2 left-2 right-2 text-[10px] text-gray-200/90 truncate bg-black/40 px-2 py-1 rounded">
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

  <div className="mt-2 text-[11px] text-gray-500">
    Horizontal scroll. Tap a tile to preview. Timeline events will highlight related evidence.
  </div>
</section>
        ) : null}

        {/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
            "My Job — default for new evidence" is a mutation context
            for choosing which job a future upload will attach to. On
            sealed records no new evidence can attach, so the section
            has no purpose. The Jobs tab keeps the job list itself. */}
        {activeTab === "jobs" && !isFieldWorkLocked(incidentStatus) ? (
        <section className="rounded-2xl bg-white/[0.04] border border-white/[0.08] p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-[0.16em] text-gray-400">My Job</div>
            <span className="text-xs text-gray-500">default for new evidence</span>
          </div>

          {(() => {
            const current = jobs.find((j: any) => String(j?.id || j?.jobId || "") === String(currentJobId || ""));
            const currentTitle = String(current?.title || current?.id || current?.jobId || "").trim();
            const currentStatus = jobStatusText(current?.status);

            return (
              <div className="mt-3 space-y-3">
                <select
                  className="w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
                  disabled={isClosed || jobsBusy || jobsForMapping.length === 0}
                  value={currentJobId || String(jobsForMapping?.[0]?.id || jobsForMapping?.[0]?.jobId || "")}
                  onChange={(e) => setCurrentJobId(String(e.target.value || ""))}
                >
                  {jobsForMapping.length === 0 ? (
                    <option value="">No active field jobs</option>
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

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="px-3 py-2 rounded-lg text-sm border bg-white/6 border-white/12 text-gray-200 hover:bg-white/[0.08] disabled:opacity-50"
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
                    Jump to evidence mapping
                  </button>
                </div>
              </div>
            );
          })()}

          {orgOptionsLoadError ? (
            <div className="mt-2 text-[11px] text-yellow-300">Org list failed to load</div>
          ) : orgOptionsLoaded && orgOptions.length === 0 ? (
            <div className="mt-2 text-[11px] text-gray-400">No orgs available</div>
          ) : null}

          {orgOptions.length === 0 && showOrgDevTools ? (
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              <button
                type="button"
                className="underline text-cyan-200 disabled:text-gray-500"
                onClick={() => { try { debugOrgs(); } catch {} }}
                disabled={orgDebugBusy}
              >
                {orgDebugBusy ? "Debug orgs..." : "Debug orgs"}
              </button>
              <button
                type="button"
                className="underline text-cyan-200 disabled:text-gray-500"
                onClick={() => { try { seedOrgsDev(); } catch {} }}
                disabled={orgSeedBusy}
              >
                {orgSeedBusy ? "Seeding..." : "Seed orgs (dev)"}
              </button>
            </div>
          ) : null}

          {orgDebugJson ? (
            <details className="mt-2 text-[11px] text-gray-300">
              <summary className="cursor-pointer select-none">Org debug JSON</summary>
              <pre className="mt-1 max-h-44 overflow-auto rounded bg-black/40 border border-white/[0.08] p-2 whitespace-pre-wrap break-words">{orgDebugJson}</pre>
            </details>
          ) : null}

          <div className="mt-2 text-[11px] text-gray-500">
            Field view is simplified. Job status management is in Review.
          </div>
        </section>
        ) : null}

        {/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
            Evidence to Job Mapping is a mutation surface — it sets
            evidence.jobId. On sealed records evidence linkage is
            immutable. Hidden when isClosed. The Evidence gallery
            above this section stays visible as a read-only display. */}
        {activeTab === "evidence" && !isFieldWorkLocked(incidentStatus) ? (
        <section ref={evidenceMappingSectionRef} className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <div id="evidence-mapping" className="text-xs uppercase tracking-wide text-gray-400">Evidence to Job Mapping</div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Set `evidence.jobId`</span>
              <button
                type="button"
                className={"px-2 py-1 rounded text-xs border " + (isClosed || jobsBusy || !currentJobId ? "bg-white/5 border-white/10 text-gray-500 cursor-not-allowed" : "bg-cyan-600/20 border-cyan-300/30 text-cyan-100 hover:bg-cyan-600/30")}
                disabled={isClosed || jobsBusy || !currentJobId}
                onClick={() => { try { assignAllUnassignedToCurrentJob(); } catch {} }}
                title={currentJobId ? "Assign all unassigned evidence to My Job" : "Select My Job first"}
              >
                Assign all unassigned to My Job
              </button>
            </div>
          </div>
          <div className="mt-1 text-[11px] text-gray-500">
            Optional. New evidence auto-attaches to My Job.
          </div>
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
                      <div className="text-sm text-gray-100 truncate">{String(ev?.file?.originalName || ev?.id || "evidence")}</div>
                      <div className="text-[11px] text-gray-400 truncate">evidenceId: {eid}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {evSec ? `uploaded ${fmtAgo(evSec)}` : `id: …${eid ? eid.slice(-6) : "—"}`}
                      </div>
                      <div className="text-[11px] text-cyan-200/85 truncate">
                        job: {linkedJob ? String(linkedJob?.title || linkedJob?.id || linkedJob?.jobId || "") : (currentEvidenceJobId || "(no job)")}
                      </div>
                    </div>
                    <select
                      className="text-xs bg-black/50 border border-white/15 rounded px-2 py-1 min-w-[180px]"
                      disabled={isClosed || jobsBusy}
                      value={currentEvidenceJobId}
                      onChange={(e) => { try { assignEvidenceJob(String(ev?.id || ""), String(e.target.value || "")); } catch {} }}
                    >
                      <option value="">(no job)</option>
                      {jobs.map((j: any) => (
                        <option key={String(j?.id || j?.jobId)} value={String(j?.id || j?.jobId)}>
                          {String(j?.id || j?.jobId || "job")}: {String(j?.title || "(untitled)")} ({jobStatusText(j?.status)})
                        </option>
                      ))}
                    </select>
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
        </section>
        ) : null}

        {/* Timeline story */}
        
        {activeTab === "timeline" ? (
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Timeline</div>
            <span className="text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300">Auto-log: On</span>
          </div>

          
<TimelinePanel
  items={timeline as any}
  onJumpToEvidence={jumpToEvidence}
  highlightId={selectedEvidenceId}
  showHeader={false}
/>
        </section>
        ) : null}

        {/* Notes section will remain below if you already inserted it elsewhere */}
        {/* Readiness Checklist */}
        {/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
            Readiness checklist ("Field activity detected", "Selected
            job evidence", "Selected job state") is workshop-coded
            audit of whether the incident is ready to close. On a
            closed incident the answer is permanently "yes" and the
            checklist is dead weight beside the sealed banner. */}
        {activeTab === "overview" && !isSealedOrPostReview && hasInitialLoad ? (
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between">
            {/* PR 85 — readiness reframed as acceptance-readiness so
                the checklist reads as "what's needed before the
                packet can be accepted" rather than generic ops status. */}
            <div className="text-xs uppercase tracking-wide text-gray-400">Acceptance readiness</div>
            <span className="text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300">
              Live
            </span>
          </div>

          {(() => {
            const hasSession = timeline.some((t: any) => String(t.type) === "SESSION_STARTED" || String(t.type) === "FIELD_ARRIVED" || String(t.type) === "EVIDENCE_ADDED");
            const evidenceN = evidence.filter((ev: any) => !!ev.file?.storagePath && !String(ev.file?.storagePath||"").includes("demo_placeholder")).length;
            const hasEvidence = evidenceN >= 4;
            const hasNotes = notesSavedLocal || timeline.some((t: any) => String(t.type) === "NOTES_SAVED"); const hasApproved = _hasApproved;

            const items = [
              ["Field session started", hasSession],
              // PR 85 — proof vocabulary on the readiness checklist.
              ["Proof captured (4+)", hasEvidence],
              ["Notes saved", hasNotes],
              ["Supervisor approval", hasApproved],
            ];

            const ready = hasSession && hasEvidence && hasNotes;

            return (
              <div className="mt-3 space-y-2 text-sm">
                <div className={"rounded-xl p-3 border " + (ready ? "bg-green-700/15 border-green-400/20" : "bg-amber-700/10 border-amber-400/20")}>
                  <div className="font-semibold">{ready ? "Ready for approval" : "Proof package incomplete"}</div>
                  <div className="text-xs text-gray-400 mt-1">Based on required proof and approval status.</div>
                </div>

                <div className="grid gap-2">
                  {items.map(([label, ok]) => (
                    <div key={String(label)} className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
                      <div className="text-gray-200">{label}</div>
                      <div className={ok ? "text-green-300" : "text-gray-500"}>{ok ? "✓" : "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </section>
        ) : null}

        {/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
            Bottom-dock spacer. Reserves vertical room for the fixed
            dock below. Hidden when the dock itself is hidden — i.e.
            for sealed records (closed) and post-review records
            (submitted_to_customer, customer_accepted, customer_rejected). */}
        {!isSealedOrPostReview ? <div className="h-20" /> : null}
      </div>

      {/* Bottom dock */}
      {/* PEAKOPS_INCIDENT_SEALED_BODY_GATE_V1 (PR 55.5)
          Bottom dock is the primary operational cockpit (Arrive /
          Evidence / Notes / Submit). On sealed records (closed) and
          post-review records (submitted_to_customer,
          customer_accepted, customer_rejected) every action here
          either no-ops or 409s server-side, and optimistic UI can
          flash a misleading reset (Site Arrival 1d → 0s) before
          the server rejects. Hidden entirely — no disabled buttons
          left to confuse the supervisor and no surface left to
          mutate a locked record from. */}
      {!isSealedOrPostReview ? (
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-black/80 border-t border-white/10">
        <div className="grid grid-cols-4 gap-2">
          {/* Arrive */}
          <button
            type="button"
            className={
              "py-3 rounded-xl text-sm font-semibold border transition " +
              (arrived
                ? "bg-emerald-500/15 border-emerald-300/25 text-emerald-100"
                : "bg-white/6 border-white/12 text-gray-200 hover:bg-white/10")
            }
            onClick={() => { try { markArrived(); } catch {} }}
            disabled={arrived || isClosed}
            title={isClosed ? "Incident is closed (read-only)" : (arrived ? "Arrived (done)" : "Mark arrival")}>
            Arrive
          </button>

          {/* Evidence */}
          <button
            type="button"
            className={
              "py-3 rounded-xl text-sm font-semibold border transition " +
              (_hasEvidence
                ? "bg-indigo-500/14 border-indigo-300/25 text-indigo-100"
                : "bg-white/6 border-white/12 text-gray-200 hover:bg-white/10")
            }
            onClick={() => { try { goAddEvidence(); } catch {} }}
            disabled={isClosed}
            title={
              isClosed
                ? "Incident is closed (read-only)"
                : (_hasEvidence ? "Proof captured (done)" : "Go to proof capture")
            }>
            {/* PR 85 — dock button reframed to proof vocabulary. */}
            Proof
          </button>

          {/* Notes */}
          <button
            type="button"
            className={
              "py-3 rounded-xl text-sm font-semibold border transition " +
              (_hasNotes
                ? "bg-indigo-500/14 border-indigo-300/25 text-indigo-100"
                : "bg-white/6 border-white/12 text-gray-200 hover:bg-white/10")
            }
            onClick={() => { try {
              const o = String(sp?.get("orgId") || "").trim();
              const qs = o ? `?orgId=${encodeURIComponent(o)}` : "";
              router.push(`/incidents/${incidentId}/notes${qs}`);
            } catch {} }}
            title={_hasNotes ? "Notes saved (done)" : "Write notes"}>
            Notes
          </button>

          {/* Submit */}
          <button
            type="button"
            className={
              // PR 88 — dock Submit button text reframed from "Submit"
              // to "Submit for approval". text-[11px] sm:text-sm keeps
              // the longer phrase on one line at 375px viewport (4-col
              // grid gives ~80px per cell).
              "w-full py-3 rounded-xl text-[11px] sm:text-sm font-semibold border transition " +
              ((arrived && _hasEvidence && _hasNotes && !submitting && !isClosed)
                ? "bg-emerald-600/20 border-emerald-300/25 text-emerald-50 hover:bg-emerald-600/25"
                : "bg-white/5 border-white/10 text-gray-400 cursor-not-allowed")
            }
            disabled={submitting || !arrived || !_hasEvidence || !_hasNotes || isClosed}
            title={
              isClosed
                ? "Incident is closed (read-only)"
                : (arrived && _hasEvidence && _hasNotes)
                ? "Submit for approval"
                : "Complete Arrive + Proof + Notes first"
            }
            onClick={(e) => {
              try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
              try { submitSession(); } catch {}
            }}>
            Submit for approval
          </button>
        </div>
      </div>
      ) : null}

{/* Modal */}
      {showCreateJob ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-lg rounded-2xl bg-black border border-white/10 overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <div className="text-sm text-gray-200">Create Job</div>
              <button className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/15" onClick={() => setShowCreateJob(false)}>
                Close
              </button>
            </div>
            <div className="p-3 space-y-3">
              <input
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-gray-200"
                placeholder="Job title"
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
                {jobsBusy ? "Creating..." : "Create Job"}
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
                  className="text-xs px-2 py-1 rounded bg-amber-500/20 border border-amber-300/30 hover:bg-amber-500/30"
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

              {/* Evidence label viewer/editor. On locked records (closed
                  and post-review), the label is shown read-only — no
                  input, no Clear button — so the modal continues to
                  surface the metadata without offering a mutation
                  surface. */}
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">Evidence label</div>

                {isFieldWorkLocked(incidentStatus) ? (
                  <div className="mt-2 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-gray-200">
                    {getCaption(selectedEvidenceId) || <span className="text-gray-500">—</span>}
                  </div>
                ) : (
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
                )}
              </div>
</div>
          </div>
        </div>
      ) : null}

      {/* ZIP_TOAST */}
      

      
    
      {toastMsg ? (
        <div className="pointer-events-none fixed top-4 right-4 z-50 rounded-xl bg-black/70 border border-white/10 px-4 py-3 text-sm text-gray-200 backdrop-blur">
          {toastMsg}
        </div>
      ) : null}

    </main>
    )
  );
}
