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
import { deriveFieldIncidentStatus } from "@/lib/workflow/fieldIncidentStatus";
import { hasUsableOrgId, incidentPath, notesPath, reviewPath, summaryPath } from "@/lib/navigation/incidentRoutes";



function StageBar({ stage }: { stage: string }) {
  const steps = [
    { key: "arrive", label: "Arrive" },
    { key: "evidence", label: "Evidence" },
    { key: "notes", label: "Notes" },
    { key: "submit", label: "Submit" },
    { key: "review", label: "Review" },
    { key: "done", label: "Done" },
  ];

  return (
    <div className="flex items-center gap-2 text-xs mb-4">
      {steps.map((s, i) => {
        const active = stage === s.key;
        const done = steps.findIndex(x => x.key === stage) > i;

        return (
          <div key={s.key} className="flex items-center gap-2">
            <div
              className={
                "px-3 py-1 rounded-full border " +
                (done
                  ? "bg-green-500/20 border-green-400 text-green-200"
                  : active
                  ? "bg-indigo-500/20 border-indigo-400 text-indigo-200"
                  : "bg-white/5 border-white/10 text-gray-400")
              }
            >
              {done ? "✓ " : ""}
              {s.label}
            </div>
            {i < steps.length - 1 && (
              <div className="w-4 h-[1px] bg-white/20" />
            )}
          </div>
        );
      })}
    </div>
  );
}


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
    await fetch("/api/fn/setEvidenceLabelV1", {
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
    EVIDENCE_ADDED: "Evidence secured",
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return JSON.parse(txt) as T;
}

function FlowStageBar({ stage }: { stage: "arrive" | "evidence" | "notes" | "submit" | "review" | "done" }) {
  const steps = [
    { key: "arrive", label: "Arrive" },
    { key: "evidence", label: "Evidence" },
    { key: "notes", label: "Notes" },
    { key: "submit", label: "Submit" },
    { key: "review", label: "Review" },
    { key: "done", label: "Done" },
  ] as const;

  return (
    <div style={{ padding: "7px 16px", background: "#050505", borderBottom: "1px solid #1c1c1c", display: "flex", alignItems: "center", gap: 4, overflowX: "auto" }}>
        {steps.map((s, i) => {
          const active = stage === s.key;
          const done = steps.findIndex(x => x.key === stage) > i;
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

    const onFocus = () => { syncNotesSavedLocal(); syncArrivedLocal(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [incidentId]);

  const [arrived, setArrived] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closingIncident, setClosingIncident] = useState(false);
  const [incidentStatus, setIncidentStatus] = useState<string>("open");
  const [incidentTitle, setIncidentTitle] = useState<string>("");
  const [incidentUpdatedAtSec, setIncidentUpdatedAtSec] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [activeTab, setActiveTab] = useState<"overview" | "timeline" | "evidence" | "jobs">("overview");
  const [pendingJumpToEvidenceMapping, setPendingJumpToEvidenceMapping] = useState(false);
  const setTab = (tab: "overview" | "timeline" | "evidence" | "jobs") => {
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
        if (raw === "overview" || raw === "timeline" || raw === "evidence" || raw === "jobs") {
          setActiveTab(raw as "overview" | "timeline" | "evidence" | "jobs");
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
    if (String(incidentStatus).toLowerCase() === "closed") return toast("Incident is closed (read-only).", 2600);

    let sid = String(activeSessionId || "").trim();
    if (!sid) {
      // try last known session from storage (if any)
      try { sid = String(localStorage.getItem("peakops_active_session_" + String(incidentId || "")) || "").trim(); } catch {}
    }

    async function startSession(): Promise<string> {
      // orgId in both query string (parity with getTimelineEventsV1) and body
      // (markArrivedV1 / startFieldSessionV1 read from body via mustStr).
      const url = `/api/fn/startFieldSessionV1?orgId=${encodeURIComponent(org)}`;
      const res = await fetch(url, {
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
      const res = await fetch(url, {
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
    toast("DEBUG: submitSession entered", 1200);
    if (String(incidentStatus).toLowerCase() === "closed") return toast("Incident is closed (read-only).", 2600);

    let sid = getSubmitSessionCandidates()[0] || "";
    if (!sid) return toast("No active session yet — add evidence first.", 3000);

    const ok = true;
    if (!ok) return;

    try {
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
      const msg = (e && (e.message || String(e))) || "submit failed";
      toast("Submit failed: " + msg, 3500);
    } finally {
      setSubmitting(false);
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

  const syncArrivedLocal = () => {
    try {
      const k = "peakops_arrived_" + String(incidentId);
      const v = localStorage.getItem(k);
      setArrivedLocal(!!v);
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
    toast("DEBUG: closeIncident entered", 1200);
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
      const res = await fetch("/api/fn/closeIncidentV1", {
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
      toast("Incident closed ✓", 2200);
    } catch (e: any) {
      toast("Close failed: " + String(e?.message || e), 3200);
    } finally {
      setClosingIncident(false);
    }
  }

  async function createJob() {
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
    const title = String(jobTitle || "").trim();
    if (!title) return toast("Job title is required.", 2200);
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
      createJobInflightRef.current = false;
      setCreateJobInflight(false);
    }
  }

  async function setJobStatus(jobId: string, status: JobStatus) {
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
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
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
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
      const res = await fetch(`/api/fn/debugOrgsV1`, { method: "GET" });
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
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
    const jid = String(currentJobId || "").trim();
    if (!jid) return toast("Select My job first.", 2200);
    const completeOk = window.confirm("Mark complete?");
    if (!completeOk) return;
    await setJobStatus(jid, "complete");
  }

  async function assignAllUnassignedToCurrentJob() {
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
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
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
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
        const res = await fetch(url);
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
      }

      // Jobs (GET-only, non-fatal — empty jobs list should not kill the field page)
      try {
        const jobsUrl =
          `/api/fn/listJobsV1?orgId=${encodeURIComponent(requestOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=50` +
          `&actorUid=${encodeURIComponent(actorUid())}&actorRole=${encodeURIComponent(actorRole())}`;
        const jobsRes = await fetch(jobsUrl);
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
        const orgsRes = await fetch(orgsUrl);
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
        const evRes = await fetch(evUrl);
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
        const tlRes = await fetch(tlUrl);
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
    const res = await fetch(url, {
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
      <FlowStageBar stage={currentStage} />
      {/* Top bar */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1c1c1c", position: "sticky", top: 0, background: "rgba(5,5,5,0.95)", backdropFilter: "blur(8px)", zIndex: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#C8A84E" }}>PEAKOPS</span>
              <span style={{
                padding: "1px 6px", borderRadius: 3, fontWeight: 600, fontSize: 9,
                border: isClosed ? "1px solid #1c1c1c" : "1px solid rgba(34,197,94,0.2)",
                background: isClosed ? "#0b0b0b" : "rgba(34,197,94,0.06)",
                color: isClosed ? "#6f6f6f" : "#22c55e",
              }}>
                {String(incidentStatus || "open").toUpperCase()}
              </span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", marginTop: 2 }}>{incidentTitle || incidentId}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, fontSize: 10, color: "#6f6f6f", flexWrap: "wrap" }}>
              {incidentTitle ? <span style={{ fontFamily: "ui-monospace, monospace" }}>{incidentId}</span> : null}
              {incidentTitle ? <span>·</span> : null}
              <span>{orgId}</span>
              {incidentUpdatedAtSec ? <span>· {fmtAgo(incidentUpdatedAtSec)}</span> : null}
                           {isDemoMode ? (
                <>
                  <button
                    type="button"
                    style={{ marginLeft: 8, padding: "1px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }}
                    onClick={() => { void resetDemoNow(); }}
                    title="Fully reset demo data and reload clean"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    style={{ marginLeft: 4, padding: "1px 8px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }}
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
                </>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">

            <button
              type="button"
              style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)", color: "#C8A84E" }}
              title="Supervisor review + approve/lock"
              onClick={() => {
                const id = String(incidentId || "");
                if (!id || id.includes("${")) return;
                router.push(reviewPath(id, orgId));
              }}
            >
              Review
            </button>
            {isClosed ? (
              <span style={{ fontSize: 10, color: "#6f6f6f" }}>Incident closed</span>
            ) : _hasApproved ? (
              <span style={{ fontSize: 10, color: "#22c55e" }}>Approved</span>
            ) : _hasSubmitted ? (
              <span style={{ fontSize: 10, color: "#C8A84E" }}>Submitted</span>
            ) : null}
            <button
              type="button"
              style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3" }}
              onClick={() => { try { router.push(summaryPath(incidentId, orgId)); } catch {} }}
              title="Open incident summary"
            >
              Summary
            </button>
          </div>
        </div>

        {/* PEAKOPS_UX_TOAST_RENDER_V1 */}
        {toastMsg ? (
          <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", top: 72, zIndex: 50, padding: "8px 14px", borderRadius: 6, background: "rgba(11,11,11,0.95)", border: "1px solid #1c1c1c", fontSize: 12, color: "#b3b3b3", backdropFilter: "blur(8px)", pointerEvents: "none" }}>
            {toastMsg}
          </div>
        ) : null}
        <div style={{ marginTop: 10, display: "flex", gap: 4 }}>
          {(["overview", "timeline", "evidence", "jobs"] as const).map((tab) => (
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
              {tab === "overview" ? "Overview" : tab === "timeline" ? "Timeline" : tab === "evidence" ? "Evidence" : "Jobs"}
            </button>
          ))}
        </div>

{/* PEAKOPS_ACTIVE_JOB_CARD_UI_V1 */}
{(() => {
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
                {reqJobId ? <div style={{ fontSize: 10, color: "#6f6f6f", marginTop: 2 }}>Job: {reqJobId}</div> : null}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button type="button" style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", fontSize: 11, cursor: "pointer" }} onClick={() => { setTab("evidence"); }}>Evidence</button>
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "#6f6f6f" }}>Active Job</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#f5f5f5", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {jobTitle ? jobTitle : (activeJobId ? `Job ${activeJobId}` : "No active job assigned yet")}
              </div>
              <div style={{ fontSize: 10, color: "#6f6f6f", marginTop: 2 }}>
                {activeJobId ? (
                  <>
                    {String(jobStatus || "n/a").toUpperCase()}
                    {locked ? <span style={{ color: "#22c55e", marginLeft: 6 }}>Locked</span> : null}
                  </>
                ) : (
                  "You can capture evidence now — it will save to this incident and can be assigned to a job later."
                )}
              </div>
            </div>
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
                  Open
                </button>
              ) : null}
              {/* PEAKOPS_OVERVIEW_CTA_HIERARCHY_V1
                  Pre-arrival: Mark Arrived is the single dominant primary (inside NextBestAction).
                  This "+ Evidence" is a muted secondary shortcut until the user marks arrived.
                  Post-arrival: Evidence is the next primary action, so this button promotes to gold-gradient. */}
              <button
                type="button"
                style={{
                  padding: "6px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                  cursor: isClosed ? "not-allowed" : "pointer",
                  border: (isClosed || !hasArrival) ? "1px solid #1c1c1c" : "none",
                  background: isClosed
                    ? "#0b0b0b"
                    : !hasArrival
                      ? "transparent"
                      : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
                  color: isClosed ? "#6f6f6f" : !hasArrival ? "#6f6f6f" : "#050505",
                }}
                onClick={() => { try { goAddEvidence(); } catch (e) { console.error(e); } }}
                disabled={isClosed}
                title={!hasArrival ? "Optional — you can also capture after you mark arrived" : "Add evidence"}
              >
                + Evidence
              </button>
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

      <div className={"p-3 " + (contextLockId ? "opacity-[0.94] transition-opacity" : "")} style={{ display: "grid", gap: 8 }}>

{/* Overview 2-column layout */}
{activeTab === "overview" ? (
  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(200px, 2fr)", gap: 8, alignItems: "start" }}>
    {/* LEFT: Primary action */}
    <div style={{ display: "grid", gap: 8 }}>
      {/* PEAKOPS_INCIDENT_CLOSED_AFFORDANCE_V1 (2026-04-24)
          When an incident is closed, the "Submitted for review / waiting for
          supervisor approval" card is stale — review already happened. Show
          a confident "Incident closed" affordance with a Summary CTA instead.
          When the field has submitted but the incident isn't closed, keep
          the existing review-pending card. */}
      {isClosed ? (
        <section style={{ borderRadius: 10, border: "1px solid rgba(34,197,94,0.30)", background: "rgba(34,197,94,0.06)", padding: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase" as const, color: "#22c55e" }}>Incident closed</div>
          <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 4 }}>This incident is finalized. Open the summary to review the artifact.</div>
          <div style={{ marginTop: 10 }}>
            <button type="button" style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)", color: "#050505", fontSize: 16, fontWeight: 800, cursor: "pointer", boxShadow: "0 2px 12px rgba(200,168,78,0.20)" }} onClick={() => { try { router.push(summaryPath(incidentId, orgId)); } catch {} }}>
              View Summary
            </button>
          </div>
        </section>
      ) : _hasSubmitted ? (
        <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#22c55e" }}>Submitted for review</div>
          <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 4 }}>Session submitted. Waiting for supervisor approval.</div>
          <div style={{ marginTop: 10 }}>
            <button type="button" style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)", color: "#050505", fontSize: 16, fontWeight: 800, cursor: "pointer", boxShadow: "0 2px 12px rgba(200,168,78,0.20)" }} onClick={() => { try { router.push(reviewPath(incidentId, orgId)); } catch {} }}>
              Go to Review
            </button>
          </div>
        </section>
      ) : (
        <NextBestAction
          arrived={hasArrival}
          hasSession={_hasSession}
          hasEvidence={_hasEvidence}
          hasNotes={_hasNotes}
          hasApproved={_hasApproved}
          evidenceCount={evidenceCount}
          onOpenNotes={() => router.push(notesPath(incidentId, orgId))}
          onAddEvidence={() => {
            if (isClosed) return toast("Incident is closed (read-only).", 2600);
            goAddEvidence();
          }}
          onMarkArrived={() => { if (!isClosed) { try { markArrived(); } catch {} } else toast("Incident is closed (read-only).", 2600); }}
          onSubmitSession={() => { if (!isClosed) { void submitSession(); } else toast("Incident is closed (read-only).", 2600); }}
        />
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
    </div>

    {/* RIGHT: Status + Timers + Sync */}
    <div style={{ display: "grid", gap: 8 }}>
      {/* Timers */}
      <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "10px 14px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "#6f6f6f", marginBottom: 8 }}>Field Timing</div>
        <div style={{ display: "grid", gap: 0 }}>
          {[
            { label: "Arrival", value: _arrivalAgo, empty: _arrivalAgo === "—", emptyText: "Not started" },
            { label: "Evidence", value: _evidenceAgo, empty: _evidenceAgo === "—", emptyText: "No evidence" },
            { label: "Notes", value: _notesAgo, empty: _notesAgo === "—", emptyText: "No notes" },
          ].map((t, i) => (
            <div key={t.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: i < 2 ? "1px solid #1c1c1c" : "none" }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#b3b3b3" }}>{t.label}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: t.empty ? "#C8A84E" : "#f5f5f5" }}>{t.empty ? t.emptyText : t.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Sync state */}
      {refreshError ? (
        <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", overflow: "hidden", display: "flex" }}>
          <div style={{ width: 3, flexShrink: 0, background: "rgba(220,60,60,0.4)" }} />
          <div style={{ flex: 1, padding: "8px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#b3b3b3" }}>Offline</span>
              {process.env.NODE_ENV !== "production" && (functionsBaseIsLocal || isDemoMode) ? (
                <button type="button" style={{ padding: "2px 6px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#6f6f6f", fontSize: 9, cursor: "pointer" }} onClick={() => { clearRememberedFunctionsBase(); location.reload(); }}>Retry</button>
              ) : null}
            </div>
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: "pointer", fontSize: 9, color: "#6f6f6f" }}>Details</summary>
              <div style={{ marginTop: 4, fontSize: 9, color: "#6f6f6f", wordBreak: "break-all" }}>
                {refreshError.message}
                {refreshError.endpoint ? <div>endpoint: {refreshError.endpoint}</div> : null}
                {refreshError.status ? <div>status: {refreshError.status}</div> : null}
              </div>
            </details>
          </div>
        </div>
      ) : null}
    </div>
  </div>
) : null}

{/* Non-overview content continues below */}
{activeTab !== "overview" && refreshError ? (
  <div style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "8px 12px", fontSize: 10, color: "#b3b3b3" }}>
    Offline: {refreshError.message}
  </div>
) : null}

{/* Quick actions */}
        {activeTab === "evidence" ? (
        <section ref={myJobSectionRef} style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <h2 id="evidence" style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#f5f5f5" }}>Evidence</h2>
      <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)", lineHeight: 1.6 }}>
        {evidence.length} {evidence.length === 1 ? "item" : "items"}
      </span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button type="button" style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(200,168,78,0.35)", background: "rgba(200,168,78,0.1)", color: "#C8A84E", fontSize: 11, fontWeight: 700, letterSpacing: "0.02em", cursor: isClosed ? "not-allowed" : "pointer", opacity: isClosed ? 0.5 : 1 }} disabled={isClosed} onClick={() => { try { goAddEvidence(); } catch {} }}>+ Add evidence</button>
      {process.env.NODE_ENV !== "production" ? (
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
      <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5" }}>No evidence yet</div>
      <div style={{ marginTop: 4, fontSize: 12, color: "#6f6f6f", lineHeight: 1.5, maxWidth: 320, marginLeft: "auto", marginRight: "auto" }}>
        Capture photos and files now — they save to this incident and can be assigned to a job later.
      </div>
      <button
        type="button"
        style={{
          marginTop: 14,
          padding: "12px 22px",
          borderRadius: 8,
          border: "none",
          background: isClosed ? "#1c1c1c" : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
          color: isClosed ? "#6f6f6f" : "#050505",
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: "0.02em",
          cursor: isClosed ? "not-allowed" : "pointer",
          boxShadow: isClosed ? "none" : "0 2px 12px rgba(200,168,78,0.20)",
        }}
        disabled={isClosed}
        onClick={() => { try { goAddEvidence(); } catch {} }}
      >
        + Add Evidence
      </button>
      {isClosed ? (
        <div style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f" }}>
          Incident is closed (read-only).
        </div>
      ) : !hasActiveFieldJobs ? (
        <div style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f", maxWidth: 320, marginLeft: "auto", marginRight: "auto", lineHeight: 1.5 }}>
          No active job yet — your upload will attach to this incident. You can assign it to a job from the Evidence Mapping section below once a job exists.
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
    if (unassigned > 0) needsParts.push(`${unassigned} unassigned`);
    return (
      <>
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={chipStyle(false)}>{total} captured</span>
          <span style={chipStyle(total > 0 && labeled === total)}>{labeled}/{total} labeled</span>
          <span style={chipStyle(total > 0 && assigned === total)}>{assigned}/{total} assigned</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 500, color: ready ? "#22c55e" : "#b3b3b3" }}>
          {ready ? "✓ Ready for review" : <>Needs: <span style={{ color: "#f5f5f5" }}>{needsParts.join(", ")}</span></>}
        </div>
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
                    title={`${hasLabels ? "Labeled" : "Needs label"} · ${hasJob ? "Assigned" : "Needs job"}`}
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
    <span>Tap a tile to preview, label, or assign to a job.</span>
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
                <span>Job: <span style={{ color: "#f5f5f5", fontWeight: 600 }}>{selJobTitle}</span></span>
              ) : (
                <>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)" }}>Needs a job</span>
                  {currentJobId ? (
                    <button
                      type="button"
                      style={{ padding: "3px 9px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: "1px solid rgba(200,168,78,0.35)", background: "rgba(200,168,78,0.1)", color: "#C8A84E", cursor: isClosed ? "not-allowed" : "pointer" }}
                      disabled={isClosed}
                      onClick={() => { try { assignEvidenceJob(selId, String(currentJobId)); } catch {} }}
                      title="Attach this evidence to your active job"
                    >
                      Assign to my job
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

        {activeTab === "jobs" ? (
        <section style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#C8A84E" }}>My Job</span>
            <span style={{ fontSize: 10, color: "#6f6f6f" }}>default for new evidence</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: "#6f6f6f", lineHeight: 1.4 }}>Active field jobs appear here. Completed jobs move to Review.</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "#b3b3b3" }}>
            {(() => {
              const reviewReadyCount = (jobs || []).filter((j: any) => {
                const s = normalizeJobStatus(j?.status);
                return s !== "open" && s !== "in_progress" && s !== "assigned";
              }).length;
              return reviewReadyCount > 0 ? `${reviewReadyCount} job${reviewReadyCount === 1 ? "" : "s"} ready in Review` : "";
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
              ? "Incident is closed (read-only)"
              : jobsBusy
                ? "Job update in progress…"
                : !currentJid || !current
                  ? "Select a job first"
                  : !currentIsFieldSelectable
                    ? `Job is already ${currentNormalizedStatus || "past complete"}`
                    : "Mark this job complete so it becomes reviewable";

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
                      Create first job
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, color: "#6f6f6f", lineHeight: 1.5 }}>
                      A job groups evidence under a specific task. Create one to enable Evidence Mapping and supervisor review.
                    </div>
                    <input
                      type="text"
                      value={jobTitle}
                      onChange={(e) => setJobTitle(e.target.value)}
                      placeholder="Job name (e.g. Pole inspection)"
                      disabled={isClosed || createJobInflight}
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
                          ? "Incident is closed (read-only)"
                          : createJobInflight
                            ? "Job create in progress…"
                            : !createJobTitle
                              ? "Enter a job name"
                              : "Create this job and auto-select it"
                      }
                      style={{
                        width: "100%",
                        marginTop: 8,
                        padding: "9px 14px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: "0.02em",
                        cursor: createJobDisabled ? "not-allowed" : "pointer",
                        border: createJobDisabled ? "1px solid #1c1c1c" : "1px solid rgba(200,168,78,0.35)",
                        background: createJobDisabled ? "#101010" : "rgba(200,168,78,0.1)",
                        color: createJobDisabled ? "#6f6f6f" : "#C8A84E",
                      }}
                    >
                      {createJobInflight ? "Creating…" : "+ Create Job"}
                    </button>
                  </div>
                ) : null}

                <select
                  style={{ width: "100%", fontSize: 13, background: "#101010", border: "1px solid #1c1c1c", borderRadius: 6, padding: "8px 10px", color: "#f5f5f5" }}
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

                <button
                  type="button"
                  style={{
                    padding: "9px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: "0.02em",
                    cursor: markCompleteDisabled ? "not-allowed" : "pointer",
                    border: markCompleteDisabled ? "1px solid #1c1c1c" : "1px solid rgba(200,168,78,0.35)",
                    background: markCompleteDisabled ? "#101010" : "rgba(200,168,78,0.1)",
                    color: markCompleteDisabled ? "#6f6f6f" : "#C8A84E",
                  }}
                  disabled={markCompleteDisabled}
                  onClick={() => { try { markCurrentJobComplete(); } catch {} }}
                  title={markCompleteDisabledReason}
                >
                  ✓ Mark job complete
                </button>
                <div style={{ fontSize: 10, color: "#6f6f6f", lineHeight: 1.5, marginTop: -2 }}>
                  A complete job with at least one linked evidence item becomes reviewable by the supervisor.
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
                  Jump to evidence mapping
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
            Field view is simplified. Job status management is in Review.
          </div>
        </section>
        ) : null}

        {activeTab === "evidence" ? (
        <section ref={evidenceMappingSectionRef} style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <h2 id="evidence-mapping" style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#f5f5f5" }}>Evidence Mapping</h2>
              <span style={{ fontSize: 10, color: "#6f6f6f" }}>job assignment</span>
            </div>
            <button
              type="button"
              style={{
                padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.02em", cursor: (isClosed || jobsBusy || !currentJobId) ? "not-allowed" : "pointer",
                border: (isClosed || jobsBusy || !currentJobId) ? "1px solid #1c1c1c" : "1px solid rgba(200,168,78,0.35)",
                background: (isClosed || jobsBusy || !currentJobId) ? "#101010" : "rgba(200,168,78,0.1)",
                color: (isClosed || jobsBusy || !currentJobId) ? "#6f6f6f" : "#C8A84E",
              }}
              disabled={isClosed || jobsBusy || !currentJobId}
              onClick={() => { try { assignAllUnassignedToCurrentJob(); } catch {} }}
              title={currentJobId ? "Assign all unassigned evidence to My Job" : "Select My Job first"}
            >
              Assign all to My Job
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "#6f6f6f", lineHeight: 1.5 }}>
            When a job is active, new evidence auto-attaches to it. Otherwise it stays on the incident and you can assign it here once a job is available.
          </div>
          {(evidence || []).length === 0 ? (
            <div style={{ marginTop: 12, padding: "14px 10px", borderRadius: 8, border: "1px dashed #1c1c1c", background: "#050505", textAlign: "center", fontSize: 11, color: "#6f6f6f", lineHeight: 1.5 }}>
              Nothing to map yet. Evidence you add will show up here with a job selector.
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
                      <div className="text-sm text-gray-100 truncate">{String(ev?.file?.originalName || ev?.id || "evidence")}</div>
                      <div className="text-[11px] text-gray-400 truncate">evidenceId: {eid}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {evSec ? `uploaded ${fmtAgo(evSec)}` : `id: …${eid ? eid.slice(-6) : "—"}`}
                      </div>
                      {linkedJob ? (
                        <div className="text-[11px] text-cyan-200/85 truncate">
                          job: {String(linkedJob?.title || linkedJob?.id || linkedJob?.jobId || "")}
                        </div>
                      ) : (
                        <div style={{ marginTop: 2 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: "#C8A84E", padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)" }}>
                            Unassigned — stays on this incident
                          </span>
                        </div>
                      )}
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
                          {String(j?.title || "(untitled)")} ({jobStatusText(j?.status)})
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
          ) : null}
        </section>
        ) : null}

        {/* Timeline story */}
        
        {activeTab === "timeline" ? (
        <section style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "#C8A84E" }}>Timeline</span>
            <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 7px", borderRadius: 3, border: "1px solid #1c1c1c", background: "#101010", color: "#6f6f6f" }}>Auto-log</span>
          </div>
          {/* PEAKOPS_TIMELINE_VS_GALLERY_DISCLOSURE_V1
              Timeline = count of logged events (FIELD_ARRIVED / EVIDENCE_ADDED / NOTES_SAVED / …).
              Gallery = count of actual evidence docs. These two counts can differ when
              legacy evidence was uploaded before the backend emit/read-path unification
              (functions_clean/_incidentPath.js), or when an emit silently failed. The
              gallery is authoritative for "how many photos do we have"; the timeline is
              authoritative for "what events were logged". Showing both with a one-line
              caption so neither number contradicts the other. */}
          {(() => {
            const eventCount = (Array.isArray(timeline) ? timeline : []).filter((t: any) => String(t?.type) === "EVIDENCE_ADDED").length;
            const galleryCount = _evidenceN;
            if (eventCount === galleryCount) return null;
            return (
              <div style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px dashed #1c1c1c", background: "#050505", fontSize: 10, color: "#b3b3b3", lineHeight: 1.5 }}>
                Timeline logs <span style={{ color: "#f5f5f5", fontWeight: 600 }}>{eventCount}</span> evidence-added event{eventCount === 1 ? "" : "s"}; gallery holds <span style={{ color: "#f5f5f5", fontWeight: 600 }}>{galleryCount}</span> item{galleryCount === 1 ? "" : "s"}. Gallery is authoritative.
              </div>
            );
          })()}


<TimelinePanel
  items={timeline as any}
  onJumpToEvidence={jumpToEvidence}
  highlightId={selectedEvidenceId}
/>
        </section>
        ) : null}

        {/* Readiness — consolidated into the NextBestAction card above */}

        <div className="h-20" />
      </div>

      {/* Bottom dock */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: "10px 16px 12px", background: "rgba(5,5,5,0.96)", borderTop: "1px solid #1c1c1c", backdropFilter: "blur(12px)", zIndex: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {[
            { label: "Arrive", done: hasArrival, onClick: () => { try { markArrived(); } catch {} }, disabled: hasArrival || isClosed },
            { label: "Evidence", done: _hasEvidence, onClick: () => { try { goAddEvidence(); } catch {} }, disabled: isClosed },
            { label: "Notes", done: _hasNotes, onClick: () => { try { router.push(notesPath(incidentId, orgId)); } catch {} }, disabled: false },
          ].map((b) => (
            <button
              key={b.label}
              type="button"
              disabled={b.disabled}
              onClick={b.onClick}
              style={{
                padding: "12px 0", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: b.disabled ? "not-allowed" : "pointer",
                borderLeft: b.done ? "2px solid #22c55e" : "none",
                borderRight: "none", borderTop: "none", borderBottom: "none",
                background: b.done ? "rgba(34,197,94,0.06)" : "#101010",
                color: b.done ? "#22c55e" : b.disabled ? "#6f6f6f" : "#f5f5f5",
                boxShadow: b.done ? "none" : "inset 0 -1px 0 rgba(255,255,255,0.03)",
                outline: b.done ? "none" : "1px solid #1c1c1c",
              }}
            >
              {b.done && <span style={{ marginRight: 4 }}>&#10003;</span>}
              {b.label}
            </button>
          ))}

          {_hasSubmitted ? (
            <button
              type="button"
              onClick={() => { try { router.push(reviewPath(incidentId, orgId)); } catch {} }}
              style={{
                padding: "12px 0", borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: "pointer",
                border: "none",
                background: "linear-gradient(180deg, #9A7E2A 0%, #B89A3E 100%)",
                color: "#050505",
                boxShadow: "0 2px 8px rgba(200,168,78,0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
              }}
            >
              Review
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting || !hasArrival || (!(_hasEvidence || _hasNotes)) || isClosed}
              onClick={() => { void submitSession(); }}
              style={{
                padding: "12px 0", borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: (submitting || !hasArrival || (!(_hasEvidence || _hasNotes)) || isClosed) ? "not-allowed" : "pointer",
                border: "none",
                background: (hasArrival && (_hasEvidence || _hasNotes) && !submitting && !isClosed) ? "linear-gradient(180deg, #9A7E2A 0%, #B89A3E 100%)" : "#101010",
                color: (hasArrival && (_hasEvidence || _hasNotes) && !submitting && !isClosed) ? "#050505" : "#6f6f6f",
                boxShadow: (hasArrival && (_hasEvidence || _hasNotes) && !submitting && !isClosed) ? "0 2px 8px rgba(200,168,78,0.15), inset 0 1px 0 rgba(255,255,255,0.08)" : "inset 0 -1px 0 rgba(255,255,255,0.03)",
                outline: (hasArrival && (_hasEvidence || _hasNotes) && !submitting && !isClosed) ? "none" : "1px solid #1c1c1c",
              }}
            >
              Submit
            </button>
          )}
        </div>
      </div>

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
