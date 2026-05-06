"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { enqueueSupervisorRequestUpdate, enqueueSupervisorRequestClear, outboxFlushSupervisorRequests } from "@/lib/offlineOutbox";
import {
  clearRememberedFunctionsBase,
  getEnvFunctionsBase,
  getFunctionsBase,
  getFunctionsBaseDebugInfo,
  getFunctionsBaseFallback,
  isLikelyFetchNetworkError,
  probeAndRestoreEnvFunctionsBase,
  rememberFunctionsBase,
  warnFunctionsBaseIfSuspicious,
} from "@/lib/functionsBase";
import { ensureDemoActor, getActorRole, getActorUid } from "@/lib/demoActor";
import { getFileField } from "@/lib/evidence/fileField";
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl } from "@/lib/evidence/signedThumb";
import { incidentPath, notesPath, reviewPath, summaryPath } from "@/lib/navigation/incidentRoutes";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import { deriveNextAction, type NextActionKey } from "@/lib/workflow/nextBestAction";
import { displayIncidentTitle } from "@/lib/incidents/displayIncidentTitle";
import { resolveJobDisplayState, buildJobUiState } from "@/lib/incidents/resolveJobDisplayState";
import QaAuthDebugChip from "@/components/dev/QaAuthDebugChip";






// PEAKOPS_REQUEST_UPDATE_V1
async function createSupervisorRequest(orgId: string, incidentId: string, message: string, jobId?: string) {
  const res = await authedFetch("/api/fn/createSupervisorRequestV1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId, incidentId, message, jobId: jobId || "", actorUid: "dev-admin" }),
    cache: "no-store",
  });
  const txt = await res.text().catch(() => "");
  let out: any = {};
  try { out = txt ? JSON.parse(txt) : {}; } catch {}
  if (!res.ok || !out?.ok) throw new Error(out?.error || `createSupervisorRequestV1 failed: ${res.status}`);
  return out;
}


// PEAKOPS_EXPORT_PACKET_UI_V1
async function exportIncidentPacket(orgId: string, incidentId: string): Promise<string> {
  const res = await authedFetch("/api/fn/exportIncidentPacketV1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId, incidentId }),
    cache: "no-store",
  });
  const txt = await res.text().catch(() => "");
  let out: any = {};
  try { out = txt ? JSON.parse(txt) : {}; } catch {}
  if (!res.ok || !out?.ok || !out?.url) {
    throw new Error(out?.error || `exportIncidentPacketV1 failed: ${res.status} ${txt.slice(0,200)}`);
  }
  return String(out.url);
}


// PEAKOPS_APPROVE_LOCK_WIRE_V1

function getSelectedJobIdForApprove(): string {
  try {
    // Try common variable names in this component scope
    // @ts-ignore
    if (typeof selectedJobId !== "undefined" && selectedJobId) return String(selectedJobId);
    // @ts-ignore
    if (typeof activeJobId !== "undefined" && activeJobId) return String(activeJobId);
    // @ts-ignore
    if (typeof jobId !== "undefined" && jobId) return String(jobId);
    // @ts-ignore
    if (typeof selectedJob !== "undefined" && selectedJob && (selectedJob.id || selectedJob.jobId)) return String(selectedJob.id || selectedJob.jobId);
    // @ts-ignore
    if (typeof jobSelected !== "undefined" && jobSelected && (jobSelected.id || jobSelected.jobId)) return String(jobSelected.id || jobSelected.jobId);
  } catch {}
  return "";
}

async function approveAndLockJob(orgId: string, incidentId: string, jobId: string) {
  const res = await authedFetch("/api/fn/approveAndLockJobV1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId, incidentId, jobId, actorUid: "dev-admin" }),
    cache: "no-store",
  });
  const txt = await res.text().catch(() => "");
  let out: any = {};
  try { out = txt ? JSON.parse(txt) : {}; } catch {}
  if (!res.ok || !out?.ok) {
    throw new Error(out?.error || `approveAndLockJobV1 failed: ${res.status} ${txt.slice(0,200)}`);
  }
  return out;
}


// PEAKOPS_REVIEW_MEDIA_V1
function mediaUrlFromRef(ref: any): string {
  const bucket = String(ref?.bucket || ref?.file?.bucket || "").trim();
  const path = String(ref?.storagePath || ref?.file?.storagePath || "").trim();
  if (bucket && path) return `/api/media?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
  return "";
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
  labels?: string[];
  file?: {
    bucket?: string;
    derivativeBucket?: string;
    previewBucket?: string;
    thumbBucket?: string;
    originalName?: string;
    storagePath?: string;
    contentType?: string;
    conversionStatus?: string;
    previewPath?: string;
    previewContentType?: string;
    thumbPath?: string;
    thumbContentType?: string;
    derivatives?: {
      preview?: { storagePath?: string; contentType?: string; bucket?: string };
      thumb?: { storagePath?: string; contentType?: string; bucket?: string };
    };
  };
  evidence?: {
    jobId?: string | null;
  };
  jobId?: string | null;
  storedAt?: { _seconds?: number };
  createdAt?: { _seconds?: number };
  sessionId?: string;
};

type TimelineDoc = {
  id: string;
  type: string;
  actor?: string;
  refId?: string | null;
  sessionId?: string | null;
  occurredAt?: { _seconds?: number };
  meta?: any;
};

type JobDoc = {
  id: string;
  jobId?: string;
  orgId?: string;
  incidentId?: string;
  title?: string;
  status?: string;
  reviewStatus?: string;
  assignedOrgId?: string | null;
  notes?: string | null;
  assignedTo?: string | null;
  rejectReason?: string | null;
  // PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
  vendorId?: string | null;
  vendorName?: string | null;
};

type IncidentDoc = {
  id?: string;
  notesSummary?: {
    saved?: boolean;
    savedAt?: any;
    updatedAt?: any;
  };
  notes?: {
    saved?: boolean;
    savedAt?: any;
    updatedAt?: any;
  };
};

function getLinkedJobId(ev: any): string {
  return String(ev?.jobId || ev?.evidence?.jobId || "").trim();
}

function normStatus(v: any): string {
  return String(v || "").trim().toLowerCase();
}

function normReviewStatus(v: any): string {
  const rs = String(v || "").trim().toLowerCase();
  if (!rs) return "none";
  if (rs === "rejected") return "revision_requested";
  return rs;
}

function computedReviewStatus(job: any): string {
  const explicit = normReviewStatus(job?.reviewStatus);
  if (explicit !== "none") return explicit;
  const st = normStatus(job?.status);
  if (st === "review") return "review";
  if (st === "approved") return "approved";
  if (st === "rejected") return "revision_requested";
  return "none";
}

function computedBaseStatus(job: any): string {
  const st = normStatus(job?.status);
  if (st === "review" || st === "approved" || st === "rejected") return "complete";
  return st || "open";
}

// PEAKOPS_REVIEW_LANG_V1 (2026-04-28)
// Human labels for raw lifecycle statuses surfaced on the supervisor
// review page. Customers should never see machine tokens like
// "revision_requested" or "rejected" — every UI string maps through
// these helpers.
function humanizeJobBaseStatus(st: string): string {
  switch (String(st || "").toLowerCase()) {
    case "open": return "Open";
    case "in_progress":
    case "active": return "In progress";
    case "complete": return "Complete";
    default: return st ? st.charAt(0).toUpperCase() + st.slice(1) : "Open";
  }
}
function humanizeReviewStatus(rs: string): string {
  switch (String(rs || "").toLowerCase()) {
    case "review": return "In review";
    case "approved": return "Approved";
    case "rejected":
    case "revision_requested": return "Sent back";
    case "none":
    case "": return "—";
    default: return rs;
  }
}

// PEAKOPS_REVIEW_TIMELINE_HUMANIZE_V1 (2026-04-28)
// Mirror of the mapping in TimelinePanel.tsx so the inline timeline
// rendered on /review never shows raw event tokens like
// "FIELD_SUBMITTED" or "JOB_REJECTED" to a customer.
function prettyTimelineType(t: string): string {
  const key = String(t || "").toLowerCase();
  const m: Record<string, string> = {
    notes_saved: "Notes saved",
    evidence_added: "Photos saved",
    field_arrived: "Field arrived",
    field_submitted: "Submitted to supervisor",
    field_approved: "Supervisor approved",
    material_added: "Material logged",
    incident_opened: "Job opened",
    incident_closed: "Job closed",
    session_started: "Session started",
    job_created: "Job created",
    job_completed: "Job completed",
    job_approved: "Job approved",
    job_rejected: "Job sent back",
    job_locked: "Job locked",
    supervisor_request_update: "Update requested",
  };
  if (m[key]) return m[key];
  return key
    .replace(/_/g, " ")
    .replace(/^./, (x) => x.toUpperCase()) || "Event";
}
function timelineClock(sec?: number): string {
  if (!sec) return "";
  try {
    return new Date(sec * 1000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

async function postJson<T>(url: string, body: any, extraHeaders?: Record<string, string>): Promise<T> {
  // PEAKOPS_PHASE3_AUTHED_FETCH_V1 (2026-04-27)
  // Only called with /api/fn/* URLs in this file; route through authedFetch
  // so the Firebase ID token reaches the Phase 3 enforcement gate.
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(body || {}),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  try {
    return JSON.parse(txt) as T;
  } catch {
    // allow non-json responses in dev
    return ({ ok: true, raw: txt } as any) as T;
  }
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function isHeicEvidence(ev: EvidenceDoc) {
  const ct = String(getFileField(ev, "contentType") || "").toLowerCase();
  const name = String(getFileField(ev, "originalName") || "");
  const sp = String(getFileField(ev, "storagePath") || "");
  return (
    ct.includes("heic") ||
    ct.includes("heif") ||
    /\.(heic|heif)$/i.test(name) ||
    /\.(heic|heif)$/i.test(sp)
  );
}

type ImageRefKind = "thumbnailPath" | "thumbPath" | "previewPath" | "original";
type ImageRef = { kind: ImageRefKind; bucket: string; storagePath: string };
type TileMedia =
  | { mode: "image"; ref: ImageRef }
  | { mode: "placeholder"; label: string; reason: string };

function isRenderableImageType(ev: EvidenceDoc) {
  const ct = String(getFileField(ev, "contentType") || "").toLowerCase().trim();
  if (ct === "image/png" || ct === "image/jpeg" || ct === "image/jpg" || ct === "image/webp" || ct === "image/gif") {
    return true;
  }
  const name = String(getFileField(ev, "originalName") || "").toLowerCase();
  const sp = String(getFileField(ev, "storagePath") || "").toLowerCase();
  return /\.(png|jpe?g|webp|gif)$/i.test(name) || /\.(png|jpe?g|webp|gif)$/i.test(sp);
}

function getTileMedia(ev: EvidenceDoc): TileMedia {
  if (isHeicEvidence(ev)) {
    const st = String(getFileField(ev, "conversionStatus") || "n/a").toLowerCase().trim();
    if (st === "done" || st === "ready") {
      const ref = getBestEvidencePreviewRef(ev);
      if (ref) return { mode: "image", ref };
    }
    return { mode: "placeholder", label: "HEIC (no preview)", reason: st || "n/a" };
  }
  if (!isRenderableImageType(ev)) return { mode: "placeholder", label: "Unavailable", reason: "unsupported_type" };
  const best = getBestEvidenceImageRef(ev);
  if (best) return { mode: "image", ref: best };
  return { mode: "placeholder", label: "Unavailable", reason: "missing_bucket_or_path" };
}

export default function ReviewClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();

  // PEAKOPS_REVIEW_QUEUE_V1
  const [queueItems, setQueueItems] = useState<Array<{ incidentId: string; orgId: string }>>([]);
  const enableDashboardQueue = String(process.env.NEXT_PUBLIC_REVIEW_QUEUE_DASHBOARD || "") === "1";

  useEffect(() => {
    if (!enableDashboardQueue) {
      setQueueItems([]);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/api/dashboard", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        const docs = Array.isArray(j?.items) ? j.items : [];
        const needs = docs.filter((x: any) => Number(x?.reviewable || 0) > 0);
        const updates = docs.filter((x: any) => !needs.some((n: any) => String(n?.incidentId) === String(x?.incidentId)) && !!x?.updateRequested);
        const q = [...needs, ...updates].map((x: any) => ({
          incidentId: String(x?.incidentId || "").trim(),
          orgId: String(x?.orgId || "").trim(),
        })).filter((x: any) => x.incidentId);
        if (!dead) setQueueItems(q);
      } catch {
        if (!dead) setQueueItems([]);
      }
    })();
    return () => { dead = true; };
  }, [enableDashboardQueue]);

  const queueIndex = useMemo(() => {
    return queueItems.findIndex((x) => String(x.incidentId) === String(incidentId || ""));
  }, [queueItems, incidentId]);

  const prevIncident = useMemo(() => {
    if (queueIndex <= 0) return null;
    return queueItems[queueIndex - 1] || null;
  }, [queueItems, queueIndex]);

  const nextIncident = useMemo(() => {
    if (queueIndex < 0) return queueItems[0] || null;
    return queueItems[queueIndex + 1] || null;
  }, [queueItems, queueIndex]);

  const queuePositionLabel = useMemo(() => {
    if (queueIndex < 0 || queueItems.length === 0) return "Not in queue";
    return `${queueIndex + 1} / ${queueItems.length}`;
  }, [queueIndex, queueItems]);

  const queueRemaining = useMemo(() => {
    if (queueIndex < 0 || queueItems.length === 0) return queueItems.length;
    return Math.max(0, queueItems.length - (queueIndex + 1));
  }, [queueIndex, queueItems]);

  // PEAKOPS_V2_REVIEW_REQUEST_UPDATE (canonical)
  const [reqOpen, setReqOpen] = useState(false);
  const [reqText, setReqText] = useState("");
  const reqKey = "peakops_review_request_" + String(incidentId || "");

  useEffect(() => {
    ensureDemoActor(incidentId);
    try { outboxFlushSupervisorRequests(); } catch {}

    try {
      const prev = localStorage.getItem(reqKey) || "";
      if (prev) setReqText(prev);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  const saveRequest = () => {
    try {
      localStorage.setItem(reqKey, reqText || "");
    } catch {}
  };

  // PEAKOPS_REVIEW_ORGID_URL_V1
  // orgId is URL-sourced, matching the single-source-of-truth rule used by
  // IncidentClient. No hardcoded fallback. Supervisor navigation uses the
  // orgId-preserving helpers in @/lib/navigation/incidentRoutes.
  const _reviewSp = useSearchParams();
  const orgId = String(_reviewSp?.get?.("orgId") || "").trim();
  // PEAKOPS_REVIEW_DEV_MODE_V2 (2026-04-29)
  // Dev tools (Re-link photos, Refresh thumbnails, Show thumb debug,
  // Force remint URLs) gated STRICTLY on ?dev=1. Previous V1 also fired
  // when NODE_ENV !== "production"; local QA is now customer-clean by
  // default and engineers opt in via the URL flag.
  const devMode = useMemo(() => {
    try {
      const v = String(_reviewSp?.get?.("dev") || "").trim();
      return v === "1" || v.toLowerCase() === "true";
    } catch {
      return false;
    }
  }, [_reviewSp]);
  const functionsBase = getFunctionsBase();
  useEffect(() => {
    warnFunctionsBaseIfSuspicious(functionsBase);
  }, [functionsBase]);
  const [activeOrgId, setActiveOrgId] = useState(orgId);
  const canDevLog = useMemo(() => {
    try {
      const demoMode = String(localStorage.getItem("peakops_demo_mode") || "") === "1";
      const host = String(new URL(String(functionsBase || "")).hostname || "").toLowerCase();
      const localHost = host === "127.0.0.1" || host === "localhost";
      return demoMode || localHost;
    } catch {
      return false;
    }
  }, [functionsBase]);
  const showJobsDebugPanel = canDevLog;
  const demoHeaders = useMemo(() => {
    try {
      const demoMode = String(localStorage.getItem("peakops_demo_mode") || "") === "1";
      const looksDemoIncident = /^inc_/i.test(String(incidentId || ""));
      if (canDevLog && (looksDemoIncident || demoMode)) return { "x-peakops-demo": "1" };
    } catch {}
    return {} as Record<string, string>;
  }, [canDevLog, incidentId]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [errDiag, setErrDiag] = useState<{ endpoint?: string; status?: number; body?: string } | null>(null);
  // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
  // Set when getIncidentV1 returns 404 / "incident_not_found". Drives
  // a clean customer-facing empty state instead of the raw debug panel.
  const [incidentNotFound, setIncidentNotFound] = useState(false);
  const [toastMsg, setToastMsg] = useState<string>("");
  const [mounted, setMounted] = useState(false);

  // PEAKOPS_REVIEW_NBA_V1 (2026-04-28)
  // Same Firebase Auth claims source as the field/summary pages so NBA
  // resolves identical role logic across the lifecycle.
  // PEAKOPS_REVIEW_AUTH_GATE_V2 (2026-04-28)
  // Pull `user` + `loading` so we can render a loading card before
  // committing to either the field-only or supervisor branch.
  const { user: authUser, loading: authLoading, claims: authClaims } = useAuth();

  // Force-refresh claims once on /review mount so a stale cached
  // token doesn't render the wrong branch when the user just had
  // their custom claims updated server-side. Result is plumbed into
  // useAuth's existing onAuthStateChanged listener via the next
  // tick — we don't need to set local state here.
  const [tokenForceRefreshed, setTokenForceRefreshed] = useState(false);
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    (async () => {
      try {
        await authUser.getIdToken(true);
      } catch {
        /* swallow — useAuth already exposes the cached fallback */
      }
      if (!cancelled) setTokenForceRefreshed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [incidentDoc, setIncidentDoc] = useState<IncidentDoc | null>(null);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [jobActionBusy, setJobActionBusy] = useState(false);
  const [closingIncident, setClosingIncident] = useState(false);
  // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
  // Synchronous double-click guards. State updates lag by a render so
  // a fast double-click can fire two POSTs before the button visibly
  // disables. These refs are checked synchronously at the entry of
  // each handler. Released in the matching finally block.
  const approveJobRef = useRef(false);
  const rejectJobRef = useRef(false);
  const closeIncidentRef = useRef(false);
  // PEAKOPS_REVIEW_GENERATE_REPORT_V1 (2026-05-01)
  // Loading state for the Review-side direct export trigger. Used to
  // disable the NBA button + show "Preparing report…" feedback while
  // exportIncidentPacketV1 runs. Distinct from closingIncident so a
  // double-click between Close and Generate Report can't conflate
  // the two states.
  const [exportingReport, setExportingReport] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // PEAKOPS_REVIEW_INLINE_CONFIRM_V1 (2026-04-28)
  // Inline confirmation panel state for destructive review actions.
  // Replaces native window.confirm, which a previous QA pass demonstrated
  // could auto-commit (browser dialog suppression, focused-Enter race,
  // or Cypress-style auto-accept) on the first click. With this state
  // the first click only ever toggles UI — only the explicit Confirm
  // button in the panel below the NBA card is allowed to call the API.
  type PendingConfirmAction = null | "approve" | "send_back" | "close";
  const [pendingConfirmAction, setPendingConfirmAction] =
    useState<PendingConfirmAction>(null);
  // Optional reason captured inline for "Send Back" so the field team
  // gets context. Cleared on cancel/success/failure.
  const [pendingSendBackReason, setPendingSendBackReason] = useState<string>("");

  // Gallery state
  const [thumbReasonById, setThumbReasonById] = useState<Record<string, string>>({});
  const [thumbCacheBustById, setThumbCacheBustById] = useState<Record<string, number>>({});
  const [thumbRetryById, setThumbRetryById] = useState<Record<string, number>>({});
  const [thumbStatusById, setThumbStatusById] = useState<Record<string, number>>({});
  const [thumbErrorById, setThumbErrorById] = useState<Record<string, string>>({});
  // PEAKOPS_REVIEW_THUMB_SIGNED_V1 (2026-04-24)
  // Minted signed URLs keyed by evidenceId, populated by the prefetch effect
  // below. Replaces the previous /api/media proxy approach, which returns 410
  // Gone in production. Renders through toInlineMediaUrl(...) so emulator
  // URLs still flow through /api/media while production URLs go direct to
  // storage.googleapis.com.
  const [thumbUrlById, setThumbUrlById] = useState<Record<string, string>>({});
  const thumbMintInflightRef = useRef<Record<string, boolean>>({});
  // Terminal-failure flag. Once a thumbnail fails (mint !ok, mint exception,
  // or <img> onError), we never re-mint until the component unmounts (hard
  // page reload or navigating to a different incident). Matches the
  // one-shot-terminal pattern used by IncidentClient.
  const thumbTerminalRef = useRef<Record<string, boolean>>({});
  const [thumbDebugOverlay, setThumbDebugOverlay] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>("");
  const [evidenceLimit, setEvidenceLimit] = useState<number>(12);
  const [evidenceFilterJobId, setEvidenceFilterJobId] = useState<string>("");
  const evidenceSectionRef = useRef<HTMLElement | null>(null);
  const jobDetailPanelRef = useRef<HTMLDivElement | null>(null);
  const reviewRetryRef = useRef(false);
  const thumbRefreshInflightRef = useRef<Record<string, boolean>>({});
  const thumbRefreshDebounceRef = useRef<any>(null);

  // Notes saved flag (local)
  const [notesSavedLocal, setNotesSavedLocal] = useState(false);
  const syncNotesSavedLocal = () => {
    try {
      const k = "peakops_notes_saved_" + String(incidentId);
      setNotesSavedLocal(!!localStorage.getItem(k));
    } catch {}
  };

  function toast(msg: string, ms = 2200) {
    setToastMsg(String(msg || ""));
    window.setTimeout(() => setToastMsg(""), ms);
  }

  function actorUid() {
    return getActorUid();
  }
  function actorRole() {
    return getActorRole();
  }

  const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

  async function fetchTextOrThrow(url: string, request: string) {
    // Refresh path only fetches /api/fn/* URLs; route through authedFetch.
    const res = await authedFetch(url, { headers: demoHeaders });
    const text = await res.text();
    if (!res.ok) {
      if (canDevLog) {
        console.debug("[review-refresh-fail]", {
          request,
          url,
          httpStatus: res.status,
          response: String(text || "").slice(0, 600),
        });
      }
      const e: any = new Error(`GET ${url} -> ${res.status} ${text}`);
      e.endpoint = url;
      e.status = res.status;
      e.body = String(text || "").slice(0, 500);
      throw e;
    }
    return text;
  }

  async function getEvidenceReadUrl(bucket: string, storagePath: string, expiresSec = 900): Promise<string> {
    const out: any = await postJson(`/api/fn/createEvidenceReadUrlV1`, {
      orgId: activeOrgId || orgId,
      incidentId,
      storagePath,
      bucket,
      expiresSec,
    }, demoHeaders);
    if (!out?.ok || !out?.url) throw new Error(out?.error || "createEvidenceReadUrlV1 failed");
    return String(out.url);
  }

  function buildThumbProxyUrl(ref: ImageRef, evidenceId: string): string {
    const params = new URLSearchParams({
      orgId: activeOrgId || orgId,
      incidentId,
      bucket: ref.bucket,
      storagePath: ref.storagePath,
      kind: ref.kind,
    });
    const n = Number(thumbCacheBustById[evidenceId] || 0);
    if (n) params.set("t", String(n));
    return `/api/media?bucket=${encodeURIComponent(ref.bucket)}&path=${encodeURIComponent(ref.storagePath)}`;
  }

  function refreshVisibleThumbsDebounced() {
    if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    thumbRefreshDebounceRef.current = setTimeout(() => {
      const now = Date.now();
      (visibleEvidence || []).forEach((ev: any) => {
        const id = String(ev?.id || ev?.evidenceId || "");
        if (!id || thumbRefreshInflightRef.current[id]) return;
        thumbRefreshInflightRef.current[id] = true;
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbReasonById((m) => ({ ...m, [id]: "" }));
        setThumbErrorById((m) => ({ ...m, [id]: "" }));
        setThumbCacheBustById((m) => ({ ...m, [id]: now }));
        setTimeout(() => {
          thumbRefreshInflightRef.current[id] = false;
        }, 300);
      });
    }, 120);
  }

  async function handleThumbDecodeError(evidenceId: string, url: string, media?: TileMedia) {
    // PEAKOPS_REVIEW_THUMB_SIGNED_V1 (2026-04-24)
    // One-shot terminal. Previously retried via a counter and a cache-buster;
    // that caused the same re-mint storm the field page had. The signed URL
    // from createEvidenceReadUrlV1 is either fetchable or not — a browser
    // retry doesn't change its contents. Mark terminal, clear the URL so the
    // "Unavailable" placeholder renders, and stop. Cleared only on component
    // unmount (hard page reload or navigation).
    if (thumbTerminalRef.current[evidenceId]) return;
    thumbTerminalRef.current[evidenceId] = true;
    setThumbUrlById((m) => {
      const n = { ...m };
      delete n[evidenceId];
      return n;
    });
    setThumbErrorById((m) => ({ ...m, [evidenceId]: "img_load_failed" }));
    setThumbReasonById((m) => ({ ...m, [evidenceId]: "img_load_failed" }));
    setThumbStatusById((m) => ({ ...m, [evidenceId]: Number(m[evidenceId] || 0) }));
    if (canDevLog) {
      logThumbEvent("terminal", {
        evidenceId: (selectedEvidenceId || evidenceId || "unknown"),
        kind: media?.mode === "image" ? media.ref.kind : "unknown",
        bucket: media?.mode === "image" ? media.ref.bucket : "",
        storagePath: media?.mode === "image" ? media.ref.storagePath : "",
        src: url,
      });
    }
  }

  // Download all visible (opens tabs; popup blockers may apply)
  async function downloadAllVisible() {
    try {
      const list = (evidence || [])
        .filter((ev: any) => {
          const sp = String(getFileField(ev, "storagePath") || "");
          return !!sp && !sp.includes("demo_placeholder");
        })
        .slice(0, evidenceLimit);

      for (const ev of list) {
        const media = getTileMedia(ev as any);
        if (media.mode !== "image") continue;
        try {
          const url = await getEvidenceReadUrl(media.ref.bucket, media.ref.storagePath, 900);
          try { window.open(url, "_blank", "noopener,noreferrer"); } catch {}
        } catch {}
      }
    } catch {}
  }

  async function openEvidence(ev: any) {
    try {
      const media = getTileMedia(ev as any);
      if (media.mode !== "image") return;
      const id = String(ev?.id || ev?.evidenceId || "");

      setSelectedEvidenceId(id || "");
      setPreviewName(String(getFileField(ev, "originalName") || id || "evidence"));
      setPreviewOpen(true);

      const url = await getEvidenceReadUrl(media.ref.bucket, media.ref.storagePath, 900);
      setPreviewUrl(url);
    } catch {
      setPreviewUrl("");
    }
  }

  function openEvidenceFromAction(target: any) {
    try {
      if (!target) {
        toast("No evidence available yet.", 2200);
        if (process.env.NODE_ENV !== "production") {
          console.warn("[review-view-evidence] missing target evidence");
        }
        return;
      }
      if (typeof openEvidence !== "function") {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[review-view-evidence] openEvidence handler missing");
        }
        toast("Evidence handler unavailable.", 2200);
        return;
      }
      void openEvidence(target);
    } catch (e: any) {
      const msg = String(e?.message || e || "view_evidence_failed");
      toast("View evidence failed: " + msg, 2600);
      if (process.env.NODE_ENV !== "production") {
        console.warn("[review-view-evidence] failed", e);
      }
    }
  }

  async function refresh(retryAttempt = 0, baseOverride?: string, fallbackUsed = false): Promise<JobDoc[]> {
    const base = String(baseOverride || functionsBase || "").trim();
    if (!base) return [];
    setLoading(true);
    setErr("");
    setIncidentNotFound(false);
    setErrDiag(null);
    try {
      let requestOrgId = String(activeOrgId || orgId || "").trim() || orgId;
      let nextIncidentDoc: IncidentDoc | null = null;
      let nextEvidence: EvidenceDoc[] = [];
      let nextJobs: JobDoc[] = [];
      let nextTimeline: TimelineDoc[] = [];

      const incUrl =
        `/api/fn/getIncidentV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const incText = await fetchTextOrThrow(incUrl, "getIncidentV1");
      const inc = incText ? JSON.parse(incText) : {};
      if (inc?.ok && inc?.doc) {
        nextIncidentDoc = inc.doc;
        const nextOrg = String(inc?.doc?.orgId || "").trim();
        if (nextOrg) {
          requestOrgId = nextOrg;
          setActiveOrgId(nextOrg);
        }
      }

      const jobsUrl =
        `/api/fn/listJobsV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=100` +
        `&actorUid=${encodeURIComponent(actorUid())}&actorRole=${encodeURIComponent(actorRole())}`;
      const jobsText = await fetchTextOrThrow(jobsUrl, "listJobsV1");
      const jb = jobsText ? JSON.parse(jobsText) : {};
      if (jb?.ok && Array.isArray(jb.docs)) nextJobs = jb.docs;

      const evUrl =
        `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      const evText = await fetchTextOrThrow(evUrl, "listEvidenceLocker");
      const ev = evText ? JSON.parse(evText) : {};
      if (ev?.ok && Array.isArray(ev.docs)) nextEvidence = ev.docs;

      const tlUrl =
        `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=500`;
      const tlText = await fetchTextOrThrow(tlUrl, "getTimelineEventsV1");
      const tl = tlText ? JSON.parse(tlText) : {};
      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs = tl.docs.slice();
        docs.sort((a: any, b: any) => (b?.occurredAt?._seconds || 0) - (a?.occurredAt?._seconds || 0));
        nextTimeline = docs;
      }

      const nextEvidenceCountByJob: Record<string, number> = {};
      (nextEvidence || []).forEach((ev: any) => {
        const jid = String(getLinkedJobId(ev) || "").trim();
        if (!jid) return;
        nextEvidenceCountByJob[jid] = Number(nextEvidenceCountByJob[jid] || 0) + 1;
      });
      const reviewable = (nextJobs || []).filter((j: any) => {
        const jid = String(j?.id || j?.jobId || "").trim();
        const st = String(j?.status || "").trim().toLowerCase();
        return (st === "complete" || st === "review") && Number(nextEvidenceCountByJob[jid] || 0) >= 1;
      });
      const selectedExists = (nextJobs || []).some(
        (j: any) => String(j?.id || j?.jobId || "") === String(selectedJobId || "")
      );

      setIncidentDoc(nextIncidentDoc);
      setEvidence(nextEvidence);
      setJobs(nextJobs);
      setTimeline(nextTimeline);
      if (!selectedExists) {
        const next = String(reviewable?.[0]?.id || reviewable?.[0]?.jobId || nextJobs?.[0]?.id || nextJobs?.[0]?.jobId || "");
        setSelectedJobId(next);
      }

      if (nextJobs.length > 0 && reviewable.length === 0 && canDevLog && !reviewRetryRef.current) {
        reviewRetryRef.current = true;
        window.setTimeout(() => {
          void refresh();
        }, 500);
      } else if (reviewable.length > 0 || nextJobs.length === 0) {
        reviewRetryRef.current = false;
      }

      syncNotesSavedLocal();
      return nextJobs;
    } catch (e: any) {
      const msg = String(e?.message || e || "refresh failed");
      const isNetworkFailure = isLikelyFetchNetworkError(e);
      if (isNetworkFailure && retryAttempt < 1) {
        const fallbackBase = getFunctionsBaseFallback(base);
        if (fallbackBase) void rememberFunctionsBase(fallbackBase);
        if (fallbackBase) {
          probeAndRestoreEnvFunctionsBase(fallbackBase);
        }
        if (canDevLog) {
          console.debug("[review-refresh-fail] transient network failure, retrying once", {
            base,
            fallbackBase: fallbackBase || "",
            incidentId,
            error: msg,
          });
        }
        if (fallbackBase) {
          window.setTimeout(() => { void refresh(retryAttempt + 1, fallbackBase, true); }, 500);
          return [];
        }
        window.setTimeout(() => { void refresh(retryAttempt + 1, base, fallbackUsed); }, 500);
        return [];
      }
      if (canDevLog) {
        console.debug("[review-refresh-fail]", {
          functionsBase: base,
          incidentId,
          fallbackUsed,
          error: msg,
          endpoint: String((e as any)?.endpoint || ""),
          status: Number((e as any)?.status || 0) || undefined,
          body: String((e as any)?.body || "").slice(0, 500),
        });
      }
      const diagStatus = Number((e as any)?.status || 0) || undefined;
      const diagBody = String((e as any)?.body || "").slice(0, 500);
      setErrDiag({
        endpoint: String((e as any)?.endpoint || ""),
        status: diagStatus,
        body: diagBody,
      });
      // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
      // Detect 404 / "incident_not_found" so the page can render a
      // clean empty state instead of the raw debug panel.
      if (
        diagStatus === 404 ||
        /incident_not_found/i.test(diagBody) ||
        /incident not found/i.test(msg)
      ) {
        setIncidentNotFound(true);
      }
      setErr(`${msg} [functionsBase=${base}${fallbackUsed ? " fallback=applied" : ""}]`);
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function refreshAfterMutation(expect?: (rows: JobDoc[]) => boolean) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await refresh();
      if (!expect || expect(rows || [])) return;
      if (attempt < 2) await sleep(250);
    }
  }

  // Refresh loop
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    return () => {
      if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    reviewRetryRef.current = false;
    refresh();
    const t = setInterval(refresh, 60000);
    const onFocus = () => {
      syncNotesSavedLocal();
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, functionsBase]);

  const evidenceN = useMemo(() => {
    return evidence.filter((ev: any) => {
      const sp = String(getFileField(ev, "storagePath") || "");
      return !!sp && !sp.includes("demo_placeholder");
    }).length;
  }, [evidence]);

  const hasSession = useMemo(() => {
    return timeline.some((t) => ["SESSION_STARTED", "FIELD_ARRIVED", "EVIDENCE_ADDED"].includes(String(t.type)));
  }, [timeline]);

  const evidenceCountByJob = useMemo(() => {
    const out: Record<string, number> = {};
    (evidence || []).forEach((ev: any) => {
      const jid = String(getLinkedJobId(ev) || "").trim();
      if (!jid) return;
      out[jid] = Number(out[jid] || 0) + 1;
    });
    return out;
  }, [evidence]);
  const reviewableJobs = useMemo(() => {
    return (jobs || []).filter((j: any) => {
      const jid = String(j?.id || j?.jobId || "").trim();
      const st = String(j?.status || "").trim().toLowerCase();
      return (st === "complete" || st === "review") && Number(evidenceCountByJob[jid] || 0) >= 1;
    });
  }, [jobs, evidenceCountByJob]);
  const rawJobsDebug = useMemo(
    () =>
      (jobs || []).map((j: any) => ({
        id: String(j?.id || j?.jobId || ""),
        title: String(j?.title || ""),
        status: String(j?.status || ""),
        reviewStatus: String(j?.reviewStatus || ""),
        computedBaseStatus: computedBaseStatus(j),
        computedReviewStatus: computedReviewStatus(j),
        assignedOrgId: String(j?.assignedOrgId || ""),
      })),
    [jobs]
  );
  const terminalJobs = useMemo(() => {
    return (jobs || [])
      .filter((j: any) => {
        const rs = computedReviewStatus(j);
        return rs === "approved" || rs === "revision_requested";
      })
      .slice(0, 10);
  }, [jobs]);
  const latestTerminalStatus = useMemo(() => {
    const rs = computedReviewStatus(terminalJobs?.[0] || {});
    return rs === "approved" || rs === "revision_requested" ? rs : "";
  }, [terminalJobs]);
  const selectedJob = useMemo(
    () => (jobs || []).find((j: any) => String(j?.id || j?.jobId || "") === String(selectedJobId || "")),
    [jobs, selectedJobId]
  );
  const hasReviewableJob = reviewableJobs.length > 0;
  const incidentStatus = String((incidentDoc as any)?.status || "").trim().toLowerCase();
  const incidentClosed = incidentStatus === "closed";
  const hasFieldSubmitted =
    incidentStatus === "submitted" ||
    (Array.isArray(timeline) &&
      timeline.some((t: any) => String(t?.type || "").trim().toLowerCase() === "field_submitted"));
  const allJobsApproved = Array.isArray(jobs) && jobs.length > 0 && jobs.every((j: any) => {
    const rs = String(j?.reviewStatus || "").trim().toLowerCase();
    const st = String(j?.status || "").trim().toLowerCase();
    return rs === "approved" || st === "approved" || !!j?.locked;
  });
  // PEAKOPS_REVIEW_TIMELINE_CLOSED_V1 (2026-05-05)
  // Honor timeline-derived close. If the timeline records an
  // `incident_closed` event but `incidentDoc.status` is still
  // "approved" (data lag between supervisor approve and the close
  // pipeline writing back), the canonical state is Closed and the
  // Close Job CTA must NOT show. This was the root of the "Closed
  // appears on the timeline but Close Job CTA still active" buyer
  // contradiction.
  const hasClosedTimelineEvent = Array.isArray(timeline) && timeline.some(
    (t: any) => {
      const ty = String(t?.type || "").toLowerCase();
      return ty === "incident_closed" || ty === "job_closed";
    },
  );
  const incidentClosedCanonical = incidentClosed || hasClosedTimelineEvent;
  const canCloseIncident = !incidentClosedCanonical && allJobsApproved && hasFieldSubmitted;

  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05) /
  // PEAKOPS_REVIEW_TIMELINE_CLOSED_V1 (2026-05-05)
  // Page-level UI state for Supervisor Review. Drives header pill,
  // approve/send-back/close visibility, and review messaging. Now
  // also accepts a timeline-derived close signal so a job whose
  // close event has fired but whose status field hasn't caught up
  // still resolves to Closed everywhere.
  const reviewUiState = buildJobUiState({
    // Force-close when the timeline has the event, even if the
    // status field is still "approved".
    status: hasClosedTimelineEvent ? "closed" : incidentStatus,
    allTasksApproved: allJobsApproved,
    hasSubmitted: hasFieldSubmitted,
    anyRejected: Array.isArray(jobs) && jobs.some((j: any) => {
      const rs = String(j?.reviewStatus || "").toLowerCase();
      const st = String(j?.status || "").toLowerCase();
      return rs === "rejected" || rs === "revision_requested" || st === "rejected";
    }),
  });
  const selectedJobStatus = computedBaseStatus(selectedJob || {});
  const selectedJobReviewStatus = computedReviewStatus(selectedJob || {});
  const selectedJobInReview = selectedJobReviewStatus === "review";
  const selectedJobApproved = selectedJobReviewStatus === "approved";
  const noReviewablesApproved = !hasReviewableJob && latestTerminalStatus === "approved";
  const queuePositionDisplay = hasReviewableJob ? queuePositionLabel : "0 / 0";
  const queueNavEnabled = hasReviewableJob;
  const selectedJobEvidence = useMemo(() => {
    const sid = String(selectedJobId || "");
    if (!sid) return [];
    return (evidence || []).filter((ev: any) => getLinkedJobId(ev) === sid);
  }, [evidence, selectedJobId]);
  const selectedJobReadyState = selectedJobReviewStatus === "review" || selectedJobStatus === "complete" || selectedJobStatus === "review";
  const selectedJobEvidenceCount = selectedJobEvidence.length;
  const ready = selectedJobReadyState && selectedJobEvidenceCount >= 1;
  const canApproveNow = ready && hasReviewableJob && !selectedJobApproved;
  const missingItems = useMemo(() => {
    const out: string[] = [];
    if (noReviewablesApproved) return out;
    if (!hasReviewableJob) out.push("Before this can be approved, at least one completed job needs attached photos.");
    if (!selectedJobReadyState && !selectedJobApproved) out.push("Selected job must be complete or in review");
    if (selectedJobEvidenceCount < 1) out.push("Selected job needs at least one attached photo");
    if (selectedJobApproved) out.push("Selected job is already approved.");
    return out;
  }, [noReviewablesApproved, hasReviewableJob, selectedJobReadyState, selectedJobApproved, selectedJobEvidenceCount]);
  const visibleEvidence = useMemo(() => {
    const base = (evidence || [])
      .filter((ev: any) => {
        const sp = String(getFileField(ev, "storagePath") || "");
        return !!sp && !sp.includes("demo_placeholder");
      });
    const fid = String(evidenceFilterJobId || "").trim();
    const scoped = fid
      ? base.filter((ev: any) => getLinkedJobId(ev) === fid)
      : base;
    return scoped.slice(0, evidenceLimit);
  }, [evidence, evidenceFilterJobId, evidenceLimit]);

  // PEAKOPS_REVIEW_THUMB_SIGNED_V1 (2026-04-24)
  // Mint signed thumbnail URLs for every visible evidence tile that doesn't
  // already have one. Uses the shared signedThumb helper so review and field
  // pages go through the same code path and same mint cache. One mint per
  // evidenceId per page load; terminal-failure gate prevents any retry loop.
  useEffect(() => {
    const effectiveOrgId = String(activeOrgId || orgId || "").trim();
    if (!effectiveOrgId || !incidentId) return;
    (visibleEvidence || []).forEach((ev: any) => {
      const id = String(ev?.id || ev?.evidenceId || "");
      if (!id) return;
      if (thumbTerminalRef.current[id]) return;
      if (thumbUrlById[id]) return;
      if (thumbMintInflightRef.current[id]) return;
      const ref = getBestEvidenceImageRef(ev);
      if (!ref?.bucket || !ref?.storagePath) return;
      thumbMintInflightRef.current[id] = true;
      (async () => {
        try {
          const resp = await mintEvidenceReadUrl({
            orgId: effectiveOrgId,
            incidentId,
            bucket: ref.bucket,
            storagePath: ref.storagePath,
            expiresSec: getThumbExpiresSec(),
          });
          if (resp?.ok && resp.url) {
            setThumbUrlById((m) => ({ ...m, [id]: resp.url! }));
            setThumbStatusById((m) => ({ ...m, [id]: Number(resp?.status || 200) }));
            setThumbErrorById((m) => ({ ...m, [id]: "" }));
          } else {
            thumbTerminalRef.current[id] = true;
            setThumbReasonById((m) => ({ ...m, [id]: String(resp?.error || "mint_failed") }));
            setThumbErrorById((m) => ({ ...m, [id]: String(resp?.error || "mint_failed") }));
            setThumbStatusById((m) => ({ ...m, [id]: Number(resp?.status || 0) }));
          }
        } catch (e: any) {
          thumbTerminalRef.current[id] = true;
          setThumbReasonById((m) => ({ ...m, [id]: String(e?.message || e || "mint_error") }));
        } finally {
          thumbMintInflightRef.current[id] = false;
        }
      })();
    });
    // Intentionally don't depend on thumbUrlById to avoid loops; the in-body
    // guard (if (thumbUrlById[id]) return) handles the deduplication.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEvidence, activeOrgId, orgId, incidentId]);

  function openJobForReview(jobIdRaw: string) {
    const jid = String(jobIdRaw || "").trim();
    if (!jid) return;
    setSelectedJobId(jid);
    setEvidenceFilterJobId(jid);
    try { jobDetailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {}
  }

  // PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
  // Removed dev console diagnostics for selected-job — was noise in
  // the review console without enough signal to keep around. Real
  // operational issues surface via the existing toasts and error
  // paths below.

  async function approveAndLock() {
  try {
    const oid = String(orgId || "").trim();
    const iid = String(incidentId || "").trim();

    setLoading?.(true as any);

    // existing approve/lock request
    const jid =
      typeof selectedJob !== "undefined" && selectedJob && (selectedJob.id || selectedJob.jobId)
        ? String(selectedJob.id || selectedJob.jobId)
        : "";

    if (!jid) {
      console.error("[Approve&Lock] missing selected jobId");
      return;
    }

    const res = await authedFetch("/api/fn/approveAndLockJobV1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: oid, incidentId: iid, jobId: jid }),
      cache: "no-store",
    });

    const txt = await res.text().catch(() => "");
    let out: any = {};
    try { out = txt ? JSON.parse(txt) : {}; } catch {}

    if (!res.ok || out?.ok === false) {
      throw new Error(out?.error || `approveAndLockJobV1 failed: ${res.status} ${String(txt || "").slice(0,200)}`);
    }

    console.log("[Approve&Lock] approved", jid);

    // Auto-generate compliance artifact
    try {
      const artifactUrl = await exportIncidentPacket(oid, iid);
      console.log("[Artifact] generated", artifactUrl);
    } catch (artifactErr) {
      console.error("[Artifact] auto-generate failed after approval", artifactErr);
    }

    try {
      router.push(`/incidents/${iid}/summary?orgId=${encodeURIComponent(oid)}&autogen=1`);
    } catch {
      try { location.href = `/incidents/${iid}/summary?orgId=${encodeURIComponent(oid)}&autogen=1`; } catch {}
    }
  } catch (e) {
    console.error(e);
  } finally {
    try { setLoading?.(false as any); } catch {}
  }
}

  // PEAKOPS_REVIEW_SEND_BACK_V3 (2026-04-28)
  // Commit-only path for Send Back. The button click no longer enters
  // here directly — it sets pendingConfirmAction = "send_back" and the
  // inline confirm panel's "Confirm Send Back" is the only caller. The
  // panel collects the reason inline (no native window.prompt) and
  // passes it through here.
  async function commitSendBack(reason: string) {
    const dev = process.env.NODE_ENV !== "production";
    if (jobActionBusy || loading) {
      toast("Please wait — another action is in progress.", 2400);
      return;
    }
    const jid = String(selectedJobId || "");
    if (!jid) {
      toast("Select a job first.", 2400);
      setPendingConfirmAction(null);
      return;
    }
    // PEAKOPS_REVIEW_HERO_V1 (2026-04-30)
    // The supervisor never has to think about "Move to Review" — if
    // the task is still `complete`, transparently promote it to
    // `review` first so the rejectJobV1 backend's gating doesn't
    // strand the user. Failure here drops the user back to the
    // confirm panel with a clean retry.
    if (selectedJobReviewStatus !== "review") {
      try {
        await moveSelectedJobToReview();
      } catch (e: any) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[review-sendback-commit] auto-promote failed", String(e?.message || e));
        }
        toast("We couldn't prepare this job to be sent back. Please retry.", 3000);
        return;
      }
    }
    const trimmedReason = String(reason || "").trim();
    if (!trimmedReason) {
      toast("A short reason is required to send a job back.", 2800);
      return;
    }
    try {
      setRejectReason(trimmedReason);
      setJobActionBusy(true);
      const out: any = await postJson(`/api/fn/rejectJobV1`, {
        orgId: activeOrgId || orgId,
        incidentId,
        jobId: jid,
        reason: trimmedReason,
        rejectedBy: "supervisor_ui",
      }, demoHeaders);
      if (!out?.ok) throw new Error(out?.error || "send-back failed");
      setRejectReason("");
      await refresh();
      toast("Update requested. The field team will see your note.", 2200);
      if (dev) console.debug("[review-sendback-commit] success", { jid });
    } catch (e: any) {
      if (dev) console.warn("[review-sendback-commit] failure", String(e?.message || e));
      toast("We couldn't complete that action. Please refresh and try again.", 3600);
    } finally {
      setJobActionBusy(false);
      setPendingConfirmAction(null);
      setPendingSendBackReason("");
    }
  }

  async function approveJob(jobId: string) {
    // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
    if (approveJobRef.current) return;
    try {
      if (selectedJobReviewStatus !== "review") {
        toast("Move to Review first.");
        return;
      }
      approveJobRef.current = true;
      setJobActionBusy(true);
      const out: any = await postJson(`/api/fn/approveJobV1`, {
        orgId: activeOrgId || orgId,
        incidentId,
        jobId,
        approvedBy: "supervisor_ui",
      }, demoHeaders);
      if (!out?.ok) throw new Error(out?.error || "approveJobV1 failed");
      await refreshAfterMutation((rows) => {
        const j = (rows || []).find((x: any) => String(x?.id || x?.jobId || "") === String(jobId || ""));
        const st = String(j?.status || "").toLowerCase();
        return st === "approved";
      });
      toast("Job approved.", 2200);
    } catch (e: any) {
      // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
      // Customer-safe message; raw error goes to dev console only.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[review-approve] failure", String(e?.message || e));
      }
      toast("We couldn't approve that job. Please refresh and try again.", 3600);
    } finally {
      setJobActionBusy(false);
      approveJobRef.current = false;
    }
  }

  // PEAKOPS_REVIEW_CLOSE_V2 (2026-04-28)
  // Commit-only path; only the inline confirm panel may call this.
  async function closeIncident() {
    const dev = process.env.NODE_ENV !== "production";
    // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
    if (closeIncidentRef.current) return;
    if (closingIncident || loading) return;
    const oid = String(activeOrgId || orgId || "").trim();
    const iid = String(incidentId || "").trim();
    if (!oid || !iid) {
      toast("Close failed: missing org/incident context.", 3200);
      setPendingConfirmAction(null);
      return;
    }
    if (!canCloseIncident) {
      toast("Job is not ready to close yet.", 2200);
      setPendingConfirmAction(null);
      return;
    }
    try {
      closeIncidentRef.current = true;
      setClosingIncident(true);
      const res = await authedFetch("/api/fn/closeIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: oid,
          incidentId: iid,
          closedBy: "supervisor_ui",
          actorRole: getActorRole(),
          actorUid: getActorUid(),
        }),
        cache: "no-store",
      });
      const txt = await res.text().catch(() => "");
      let out: any = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch {}
      if (!res.ok || !out?.ok) throw new Error(out?.error || `closeIncidentV1 failed: ${res.status}`);
      toast("Job closed.", 2200);
      await refresh();
    } catch (e: any) {
      toast("We couldn't complete that action. Please refresh and try again.", 3600);
    } finally {
      setClosingIncident(false);
      // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
      closeIncidentRef.current = false;
      setPendingConfirmAction(null);
    }
  }

  // PEAKOPS_REVIEW_GENERATE_REPORT_V1 (2026-05-01)
  // One-click Generate Report from the Review screen. Previously the
  // NBA "open_report" action only did router.push(summaryPath), which
  // forced the user to click Generate Report a second time on the
  // Summary page. This fires exportIncidentPacketV1 directly using
  // the same call shape SummaryClient uses, then navigates to
  // /summary so the user lands on the canonical "report ready / can
  // download" surface. Re-entrancy guarded by exportingReport state.
  async function triggerExportThenNavigate() {
    if (exportingReport) return;
    const oid = String(activeOrgId || orgId || "").trim();
    const iid = String(incidentId || "").trim();
    if (!oid || !iid) {
      toast("Missing org/incident context.", 3200);
      return;
    }
    try {
      setExportingReport(true);
      toast("Preparing report…", 1800);
      const res = await authedFetch("/api/fn/exportIncidentPacketV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: oid,
          incidentId: iid,
          requestedBy: getActorUid?.() || "review_ui",
          actorUid: getActorUid?.() || "review_ui",
          actorRole: getActorRole?.() || "admin",
        }),
        cache: "no-store",
      });
      const txt = await res.text().catch(() => "");
      let out: any = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch {}
      // 409 = packet already generated for this incident — treat as
      // success; SummaryClient will pick up the existing packet from
      // incident.packetMeta and surface the Download button.
      const okSignal = res.ok && out?.ok;
      const alreadyExists = res.status === 409;
      if (!okSignal && !alreadyExists) {
        // PEAKOPS_REVIEW_DEBUG_LOG_GUARD_V1 (2026-05-05)
        // Removed the [review-generate-report] console.warn — even
        // gated on `dev`, QA / preview deploys ran with dev truthy
        // and the string leaked into operator consoles. The toast
        // below is the user-facing signal; the server already logs
        // the failing incident via [export-packet] failed.
        toast("We couldn't generate the report. Please try again.", 3600);
        return;
      }
      try { router.push(summaryPath(iid, oid)); } catch {}
    } catch (_e: any) {
      toast("We couldn't generate the report. Please try again.", 3600);
    } finally {
      setExportingReport(false);
    }
  }

  // PEAKOPS_REVIEW_APPROVE_COMMIT_V1 (2026-04-28)
  // Commit-only path for Approve & Lock; only the inline confirm panel
  // may call this. The first-click handler `requestApprove` only
  // toggles pendingConfirmAction — never reaches here.
  async function commitApproveAndLock() {
    const dev = process.env.NODE_ENV !== "production";
    if (jobActionBusy || loading || closingIncident) {
      toast("Please wait — another action is in progress.", 2400);
      return;
    }
    const jid = String(selectedJobId || "").trim();
    if (!jid) {
      toast("Select a job to review first.", 2400);
      setPendingConfirmAction(null);
      return;
    }
    setJobActionBusy(true);
    try {
      await approveAndLockJob(
        String(activeOrgId || orgId || ""),
        String(incidentId || ""),
        jid,
      );
      await refresh();
      toast("Job approved.", 1800);
    } catch (e: any) {
      const msg = String(e?.message || e || "approve_and_lock_failed");
      setErr(msg);
      toast("We couldn't complete that action. Please refresh and try again.", 3600);
    } finally {
      setJobActionBusy(false);
      setPendingConfirmAction(null);
    }
  }

  async function rejectJob(jobId: string) {
    // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
    if (rejectJobRef.current) return;
    try {
      if (selectedJobReviewStatus !== "review") {
        toast("Move to Review first.");
        return;
      }
      const reason = String(rejectReason || "").trim();
      if (!reason) {
        toast("Add a short reason before sending this job back.");
        return;
      }
      rejectJobRef.current = true;
      setJobActionBusy(true);
      const out: any = await postJson(`/api/fn/rejectJobV1`, {
        orgId: activeOrgId || orgId,
        incidentId,
        jobId,
        reason,
        rejectedBy: "supervisor_ui",
      }, demoHeaders);
      if (!out?.ok) throw new Error(out?.error || "rejectJobV1 failed");
      setRejectReason("");
      await refreshAfterMutation((rows) => {
        const j = (rows || []).find((x: any) => String(x?.id || x?.jobId || "") === String(jobId || ""));
        const st = String(j?.status || "").toLowerCase();
        return st === "rejected";
      });
      toast("Job sent back.", 2200);
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[review-reject] failure", String(e?.message || e));
      }
      toast("We couldn't send that job back. Please refresh and try again.", 3600);
    } finally {
      setJobActionBusy(false);
      rejectJobRef.current = false;
    }
  }

  async function moveSelectedJobToReview() {
    try {
      const jid = String(selectedJobId || "").trim();
      if (!jid) return;
      if (selectedJobStatus !== "complete") {
        toast("Only complete jobs can be moved to review.");
        return;
      }
      setJobActionBusy(true);
      const out: any = await postJson(`/api/fn/updateJobStatusV1`, {
        orgId: activeOrgId || orgId,
        incidentId,
        jobId: jid,
        status: "review",
        reviewStatus: "review",
      }, demoHeaders);
      if (!out?.ok) throw new Error(out?.error || "updateJobStatusV1 failed");
      await refresh();
    } catch (e: any) {
      // PEAKOPS_REVIEW_REENTRY_GUARDS_V1 (2026-05-04)
      // Customer-safe message; raw error to dev console only.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[review-move-to-review] failure", String(e?.message || e));
      }
      toast("We couldn't move that job to review. Please refresh and try again.", 3600);
    } finally {
      setJobActionBusy(false);
    }
  }

  async function backfillJobLinks() {
    try {
      setJobActionBusy(true);
      const out: any = await postJson(`/api/fn/backfillEvidenceJobIdV1`, {
        orgId: activeOrgId || orgId,
        incidentId,
        dryRun: false,
      }, demoHeaders);
      if (!out?.ok) throw new Error(out?.error || "backfillEvidenceJobIdV1 failed");
      if (process.env.NODE_ENV !== "production") {
        console.debug("[review-backfill-job-links]", out);
      }
      await refresh();
      await sleep(150);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[review-backfill] failure", String(e?.message || e));
      }
      toast("We couldn't backfill those links. Please refresh and try again.", 3600);
    } finally {
      setJobActionBusy(false);
    }
  }


  // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
  // Clean customer-facing empty state when getIncidentV1 returns 404
  // (typical for a deep-link to an incident that was deleted, never
  // existed, or that the user can't access). Replaces the legacy
  // raw debug panel (endpoint / status / body / envBase / fallback
  // disabled) with a calm card. Raw diagnostics live in a dev-only
  // disclosure inside the card so engineers can still see the cause
  // when running locally.
  if (incidentNotFound) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
              <div className="text-lg font-semibold truncate" title={incidentId}>
                {displayIncidentTitle(incidentId, incidentDoc as any, jobs as any)}
              </div>
              <div className="mt-2">
                <QaAuthDebugChip />
              </div>
            </div>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() => router.push(`/incidents${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`)}
            >
              ← Back to incidents
            </button>
          </div>
        </div>
        <div className="p-4">
          <section
            style={{
              borderRadius: 12,
              border: "1px solid #1c1c1c",
              background: "#0b0b0b",
              padding: "24px 22px",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: "#6f6f6f",
                textTransform: "uppercase" as const,
              }}
            >
              Not found
            </div>
            <div style={{ marginTop: 6, fontSize: 18, fontWeight: 700, color: "#f5f5f5" }}>
              Incident not found
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: "#b3b3b3", lineHeight: 1.5 }}>
              This incident may have been deleted, moved, or you may not have access.
            </div>
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                onClick={() => router.push(`/incidents${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`)}
                style={{
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
            </div>
            {/* PEAKOPS_NOT_FOUND_DEV_GATE_V1 (2026-04-30) */}
            {devMode ? (
              <details style={{ marginTop: 16, fontSize: 10, color: "#6f6f6f" }}>
                <summary style={{ cursor: "pointer" }}>Technical details (dev only)</summary>
                <div style={{ marginTop: 6, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  incidentId: {incidentId}
                  {errDiag?.endpoint ? <div>endpoint: {errDiag.endpoint}</div> : null}
                  {errDiag?.status ? <div>status: {errDiag.status}</div> : null}
                  {errDiag?.body ? <div>body: {String(errDiag.body).slice(0, 240)}</div> : null}
                </div>
              </details>
            ) : null}
          </section>
        </div>
      </main>
    );
  }

  // PEAKOPS_REVIEW_AUTH_GATE_V2 (2026-04-28)
  // Three-state role gate to eliminate the cold-nav flash where the
  // page commits to a render branch before claims are loaded:
  //   1. Loading (auth still resolving OR claims empty + token refresh
  //      hasn't completed yet) → neutral "Checking review access" card.
  //   2. Explicit "field" → field waiting card (no supervisor UI).
  //   3. Anything else (supervisor / admin / unknown-but-resolved) →
  //      full supervisor render below.
  // Backend Phase 3 enforcement is the source of truth for write
  // authorization; this gate is purely about not rendering the wrong
  // UI during the cold-nav window.
  const _reviewerRole = String(authClaims?.role || "").toLowerCase();
  const _authStillLoading = authLoading || (!!authUser && !_reviewerRole && !tokenForceRefreshed);
  if (_authStillLoading) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
              <div className="text-lg font-semibold truncate" title={incidentId}>
                {displayIncidentTitle(incidentId, incidentDoc as any, jobs as any)}
              </div>
              <div className="mt-2">
                <QaAuthDebugChip />
              </div>
            </div>
          </div>
        </div>
        <div className="p-4">
          <section
            style={{
              borderRadius: 12,
              border: "1px solid #1c1c1c",
              background: "#0b0b0b",
              padding: "24px 22px",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: "#6f6f6f",
                textTransform: "uppercase" as const,
              }}
            >
              Loading
            </div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
              Checking review access…
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>
              Verifying your permissions.
            </div>
          </section>
        </div>
      </main>
    );
  }
  // PEAKOPS_REVIEW_UNKNOWN_ROLE_V1 (2026-04-28)
  // If the user is signed in but no role claim exists after a fresh
  // token refresh, they don't belong on /review. Render an explicit
  // "Access unavailable" card so the page never falls through into
  // either field or supervisor UI for an unconfigured user.
  const _knownRoles = new Set(["field", "supervisor", "admin"]);
  if (!!authUser && !_knownRoles.has(_reviewerRole)) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
              <div className="text-lg font-semibold truncate" title={incidentId}>
                {displayIncidentTitle(incidentId, incidentDoc as any, jobs as any)}
              </div>
              <div className="mt-2">
                <QaAuthDebugChip />
              </div>
            </div>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() => router.push(incidentPath(incidentId, orgId))}
            >
              ← Jobs
            </button>
          </div>
        </div>
        <div className="p-4">
          <section
            style={{
              borderRadius: 12,
              border: "1px solid rgba(220,60,60,0.30)",
              background: "rgba(220,60,60,0.06)",
              padding: "20px 22px",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: "#fca5a5",
                textTransform: "uppercase" as const,
              }}
            >
              Access unavailable
            </div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
              Review access not assigned
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>
              Your account does not have a role configured for this organisation. Contact your PeakOps administrator to request access.
            </div>
          </section>
        </div>
      </main>
    );
  }
  if (_reviewerRole === "field") {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
              <div className="text-lg font-semibold truncate" title={incidentId}>
                {displayIncidentTitle(incidentId, incidentDoc as any, jobs as any)}
              </div>
              <div className="mt-2">
                <QaAuthDebugChip />
              </div>
            </div>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() => router.push(incidentPath(incidentId, orgId))}
            >
              ← Jobs
            </button>
          </div>
        </div>
        <div className="p-4">
          <section
            style={{
              borderRadius: 12,
              border: "1px solid rgba(34,197,94,0.30)",
              background: "rgba(34,197,94,0.06)",
              padding: "20px 22px",
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 280px", minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  color: "#86efac",
                  textTransform: "uppercase" as const,
                }}
              >
                Submitted for review
              </div>
              <div style={{ marginTop: 4, fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
                Waiting for supervisor approval
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>
                The field work has been submitted. A supervisor will review and
                approve from here. No field action is needed right now.
              </div>
            </div>
            <button
              type="button"
              onClick={() => router.push(incidentPath(incidentId, orgId))}
              style={{
                padding: "12px 22px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.02em",
                cursor: "pointer",
                border: "1px solid #1c1c1c",
                background: "transparent",
                color: "#b3b3b3",
                flexShrink: 0,
              }}
            >
              ← Jobs
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white">
      {/* PEAKOPS_REVIEW_HEADER_V2 (2026-04-30)
          Sticky top bar — restructured per UI/UX upgrade:
          - Single "← Jobs" back link (replaces the Mission Control +
            Back to Incident pair).
          - Title + status pill + job-count subtitle on the left.
          - Notes / Summary / Download Report demoted to ghost
            utilities on the right. Download appears only when the
            report is ready. */}
      <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-start gap-3">
            <button
              type="button"
              onClick={() => router.push(incidentPath(incidentId, orgId))}
              className="mt-0.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-xs text-gray-200 shrink-0"
              title="Back to job"
            >
              ← Jobs
            </button>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
              <div className="text-lg font-semibold truncate" title={incidentId}>
                {displayIncidentTitle(incidentId, incidentDoc as any, jobs as any)}
              </div>
              <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-gray-400">
                {(() => {
                  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
                  // Header pill reads off the page-level reviewUiState.
                  // Same source of truth feeds the inline NBA close
                  // button visibility and the review CTA below.
                  const ds = reviewUiState.displayState;
                  const label = ds === "Awaiting Supervisor Review" ? "Awaiting Review" : ds;
                  const tone =
                    ds === "Closed" ? { bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.30)", color: "#a7f3d0" } :
                    ds === "Approved" ? { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.30)", color: "#86efac" } :
                    ds === "Awaiting Supervisor Review" ? { bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.30)", color: "#fcd34d" } :
                    ds === "Sent Back" ? { bg: "rgba(220,60,60,0.10)", border: "rgba(220,60,60,0.30)", color: "#fca5a5" } :
                    { bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.12)", color: "#d1d5db" };
                  return (
                    <span
                      className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={{ background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color }}
                    >
                      {label}
                    </span>
                  );
                })()}
                {Array.isArray(jobs) && jobs.length > 0 ? (
                  <span>
                    {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
                  </span>
                ) : null}
              </div>
              <div className="mt-2">
                <QaAuthDebugChip />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {(() => {
              const incPacketMeta: any = (incidentDoc as any)?.packetMeta || {};
              const packetReady =
                String(incPacketMeta?.status || "").toLowerCase() === "ready" ||
                !!String(incPacketMeta?.downloadUrl || "").trim() ||
                !!String(incPacketMeta?.packetHash || incPacketMeta?.zipSha256 || "").trim() ||
                (!!String(incPacketMeta?.bucket || "").trim() && !!String(incPacketMeta?.storagePath || "").trim());
              if (!incidentClosed || !packetReady) return null;
              return (
                <button
                  className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
                  onClick={() => {
                    try {
                      exportIncidentPacket(String(orgId||""), String(incidentId||""))
                        .then((url) => {
                          window.open(url, "_blank", "noreferrer");
                        })
                        .catch((e:any) => {
                          if (process.env.NODE_ENV !== "production") console.warn(e);
                        });
                    } catch (e) {
                      if (process.env.NODE_ENV !== "production") console.warn(e);
                    }
                  }}
                  title="Download report"
                >
                  Open Report
                </button>
              );
            })()}
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm text-gray-200"
              onClick={() => router.push(notesPath(incidentId, orgId))}
            >
              Notes
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm text-gray-200"
              onClick={() => router.push(summaryPath(incidentId, orgId))}
            >
              Summary
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {toastMsg ? (
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 text-amber-100 text-xs px-3 py-2">
            {toastMsg}
          </div>
        ) : null}

        {/* PEAKOPS_REVIEW_NBA_V1 (2026-04-28)
            Single dominant CTA on /review. Uses the shared
            deriveNextAction helper with viewContext: "review" so the
            "submitted, supervisor" branch maps to "Approve & Lock" /
            "Send Back" instead of generic "Review Work". The legacy
            review action panels below stay rendered as utilities, but
            their styling is demoted by PEAKOPS_REVIEW_DEMOTE_V1. */}
        {(() => {
          const safeJobs = Array.isArray(jobs) ? jobs : [];
          const safeEvidence = Array.isArray(evidence) ? evidence : [];
          const evidenceWithJob = safeEvidence.filter((ev: any) => {
            const top = String(ev?.jobId || "").trim();
            const nested = String(ev?.evidence?.jobId || "").trim();
            return !!(top || nested);
          });
          const unassignedEvidenceCount = safeEvidence.length - evidenceWithJob.length;
          const anyWorkItemComplete = safeJobs.some((j: any) => {
            const s = String(j?.status || "").toLowerCase();
            return s === "complete" || s === "review" || s === "approved";
          });
          const incPacketMeta: any = (incidentDoc as any)?.packetMeta || {};
          const packetReady =
            String(incPacketMeta?.status || "").toLowerCase() === "ready" ||
            !!String(incPacketMeta?.downloadUrl || "").trim() ||
            !!String(incPacketMeta?.packetHash || incPacketMeta?.zipSha256 || "").trim() ||
            (!!String(incPacketMeta?.bucket || "").trim() && !!String(incPacketMeta?.storagePath || "").trim());

          // PEAKOPS_REVIEW_NBA_CLOSED_FIX_V1 (2026-05-05)
          // Use the canonical closed signal (status==closed OR
          // timeline has incident_closed/job_closed event). The
          // earlier `!!incidentClosed` check only looked at the
          // status field, so a job with a fresh close timeline event
          // but a stale status would still surface a "Close Job"
          // CTA — exactly the buyer-trust contradiction QA flagged.
          let action = deriveNextAction({
            hasArrival: true,
            evidenceCount: safeEvidence.length,
            unassignedEvidenceCount,
            workItemCount: safeJobs.length,
            anyWorkItemComplete,
            allWorkItemsApproved: !!allJobsApproved,
            hasReviewableWorkItem: !!hasReviewableJob,
            hasSubmitted: !!hasFieldSubmitted,
            isClosed: !!incidentClosedCanonical,
            packetReady,
            role: String(authClaims?.role || "").toLowerCase(),
            currentWorkItemId: String(selectedJobId || ""),
            viewContext: "review",
          });
          // PEAKOPS_REVIEW_NBA_OVERRIDE_V1 (2026-05-05)
          // Belt-and-braces: when the canonical reviewUiState says
          // Closed, force the NBA to "Open Summary" regardless of
          // what deriveNextAction returned. Same override pattern as
          // the field page so the supervisor cannot accidentally
          // see a "Close Job" or "Approve & Lock" CTA on a record
          // the audit trail already shows as closed.
          if (reviewUiState.displayState === "Closed") {
            action = {
              state: "download_report",
              title: "Job closed",
              helper: "This job is closed. Open the summary to review the audit-ready report.",
              buttonLabel: "Open Summary",
              primaryAction: "open_report",
              enabled: true,
              tone: "success",
            };
          }

          // PEAKOPS_REVIEW_INLINE_CONFIRM_V1 (2026-04-28)
          // First-click handlers for destructive review actions. These
          // ONLY mutate UI state — they never call any API. The inline
          // confirmation panel rendered below the NBA card is the only
          // path that can reach the commit functions, defeating the
          // browser-dialog auto-accept that bit a previous QA pass.
          const requestApprove = () => {
            if (jobActionBusy || loading || closingIncident) {
              toast("Please wait — another action is in progress.", 2400);
              return;
            }
            let jid = String(selectedJobId || "").trim();
            if (!jid && reviewableJobs.length > 0) {
              const fallback = reviewableJobs[0];
              jid = String(fallback?.id || fallback?.jobId || "").trim();
              if (jid) setSelectedJobId(jid);
            }
            if (!jid) {
              toast("Select a job to review first.", 2400);
              return;
            }
            setPendingConfirmAction("approve");
          };

          const requestSendBack = () => {
            const dev = process.env.NODE_ENV !== "production";
            if (dev) console.debug("[review-sendback-click] clicked", {
              selectedJobId,
              selectedJobReviewStatus,
              jobActionBusy,
              loading,
            });
            if (jobActionBusy || loading) {
              toast("Please wait — another action is in progress.", 2400);
              return;
            }
            const jid = String(selectedJobId || "").trim();
            if (!jid) {
              toast("Select a job first.", 2400);
              return;
            }
            if (selectedJobReviewStatus !== "review") {
              toast("Move this job to Review before sending it back.", 2800);
              return;
            }
            setPendingSendBackReason("");
            setPendingConfirmAction("send_back");
          };

          const requestClose = () => {
            if (jobActionBusy || loading || closingIncident) {
              toast("Please wait — another action is in progress.", 2400);
              return;
            }
            if (!canCloseIncident) {
              toast("Job is not ready to close yet.", 2200);
              return;
            }
            setPendingConfirmAction("close");
          };

          const runAction = (key: NextActionKey) => {
            switch (key) {
              case "approve_work":
                requestApprove();
                return;
              case "send_back":
                requestSendBack();
                return;
              case "close":
                requestClose();
                return;
              case "open_report":
                // PEAKOPS_REVIEW_GENERATE_REPORT_V1 (2026-05-01)
                // Fire the export directly from Review so the user
                // doesn't need a second click on Summary. After the
                // POST resolves (or 409s with an already-existing
                // packet), navigate to Summary which surfaces the
                // ready-to-download state.
                void triggerExportThenNavigate();
                return;
              case "download_report":
                // Packet already exists. Land on Summary where the
                // Download button is wired to the opaque /api/reports
                // endpoint.
                try { router.push(summaryPath(incidentId, orgId)); } catch {}
                return;
              case "back_to_incident":
              case "mark_arrived":
              case "add_evidence":
              case "create_work_item":
              case "attach_evidence":
              case "finish_work_item":
              case "submit":
              case "review":
                try { router.push(incidentPath(incidentId, orgId)); } catch {}
                return;
              case "none":
                return;
            }
          };

          // PEAKOPS_PRIMARY_CTA_DEDUP_V1 (2026-04-29)
          // While the inline confirm panel is open, the panel's
          // "Confirm <action>" button becomes the screen's only yellow
          // primary CTA. The NBA primary visually demotes to gray so
          // the user's eye is drawn to the new commit button.
          const confirmPanelOpen = pendingConfirmAction !== null;
          const primaryBg = !action.enabled
            ? "#101010"
            : action.tone === "success"
              ? "linear-gradient(180deg, #22c55e 0%, #15803d 100%)"
              : action.tone === "muted"
                ? "#101010"
                : confirmPanelOpen
                  ? "#101010"
                  : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)";
          const primaryColor = !action.enabled
            ? "#6f6f6f"
            : action.tone === "success" ? "#050505"
            : action.tone === "muted" ? "#6f6f6f"
            : confirmPanelOpen ? "#6f6f6f"
            : "#050505";
          const primaryBorder =
            action.enabled && action.tone !== "success" && action.tone !== "muted" && !confirmPanelOpen
              ? "none"
              : "1px solid #1c1c1c";

          return (
            <section
              style={{
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
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#C8A84E", textTransform: "uppercase" as const }}>
                  Next best action
                </div>
                <div style={{ marginTop: 4, fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>{action.title}</div>
                <div style={{ marginTop: 4, fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>{action.helper}</div>
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
                    disabled={!action.enabled || loading || jobActionBusy || closingIncident || confirmPanelOpen}
                    onClick={() => runAction(action.primaryAction)}
                    style={{
                      padding: "12px 22px",
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: confirmPanelOpen ? 600 : 800,
                      letterSpacing: "0.02em",
                      cursor:
                        action.enabled && !loading && !jobActionBusy && !closingIncident && !confirmPanelOpen
                          ? "pointer"
                          : "not-allowed",
                      border: primaryBorder,
                      background: primaryBg,
                      color: primaryColor,
                      boxShadow:
                        action.enabled && action.tone !== "muted" && !confirmPanelOpen
                          ? "0 2px 12px rgba(200,168,78,0.20)"
                          : "none",
                    }}
                  >
                    {action.buttonLabel}
                  </button>
                )}
              </div>
            </section>
          );
        })()}

        {/* PEAKOPS_REVIEW_INLINE_CONFIRM_V1 (2026-04-28)
            Inline confirmation panel for destructive review actions.
            Sits directly under the NBA card so the user's eye stays in
            the same column. Replaces native window.confirm — only the
            "Confirm …" button below can call the commit functions, so
            any auto-accepted browser dialog cannot trigger a commit.
            The first click on Approve & Lock / Send Back / Close
            Incident only sets pendingConfirmAction. */}
        {pendingConfirmAction ? (
          <section
            data-testid="review-inline-confirm"
            style={{
              borderRadius: 12,
              border: "1px solid rgba(220,60,60,0.35)",
              background: "rgba(220,60,60,0.06)",
              padding: "16px 18px",
              display: "grid",
              gap: 10,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: "#fca5a5",
                textTransform: "uppercase" as const,
              }}
            >
              Confirm action
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
              {pendingConfirmAction === "approve"
                ? "Approve this job?"
                : pendingConfirmAction === "send_back"
                ? "Send this job back to the field?"
                : "Close this job?"}
            </div>
            <div style={{ fontSize: 13, color: "#b3b3b3", lineHeight: 1.5 }}>
              {pendingConfirmAction === "approve"
                ? "Records supervisor approval and locks further field edits."
                : pendingConfirmAction === "send_back"
                ? "The field team will see your note and can resubmit."
                : "Field edits will be locked and the report can be generated."}
            </div>

            {pendingConfirmAction === "send_back" ? (
              <div style={{ display: "grid", gap: 4 }}>
                <label
                  htmlFor="review-sendback-reason"
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase" as const,
                    color: "#6f6f6f",
                  }}
                >
                  Reason (sent to the field team)
                </label>
                <textarea
                  id="review-sendback-reason"
                  value={pendingSendBackReason}
                  onChange={(e) => setPendingSendBackReason(e.target.value)}
                  placeholder="What needs to be fixed?"
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #1c1c1c",
                    background: "#050505",
                    color: "#f5f5f5",
                    fontSize: 13,
                    outline: "none",
                    fontFamily: "inherit",
                    resize: "vertical",
                  }}
                />
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  setPendingConfirmAction(null);
                  setPendingSendBackReason("");
                }}
                disabled={jobActionBusy || closingIncident}
                style={{
                  padding: "10px 16px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor:
                    jobActionBusy || closingIncident ? "not-allowed" : "pointer",
                  border: "1px solid #1c1c1c",
                  background: "transparent",
                  color: "#b3b3b3",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  jobActionBusy ||
                  closingIncident ||
                  loading ||
                  (pendingConfirmAction === "send_back" &&
                    !pendingSendBackReason.trim())
                }
                onClick={() => {
                  if (pendingConfirmAction === "approve") {
                    void commitApproveAndLock();
                  } else if (pendingConfirmAction === "send_back") {
                    void commitSendBack(pendingSendBackReason);
                  } else if (pendingConfirmAction === "close") {
                    void closeIncident();
                  }
                }}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: "0.02em",
                  cursor:
                    jobActionBusy ||
                    closingIncident ||
                    loading ||
                    (pendingConfirmAction === "send_back" &&
                      !pendingSendBackReason.trim())
                      ? "not-allowed"
                      : "pointer",
                  border: "none",
                  background:
                    pendingConfirmAction === "approve"
                      ? "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)"
                      : "linear-gradient(180deg, #dc2626 0%, #991b1b 100%)",
                  color: pendingConfirmAction === "approve" ? "#050505" : "#fff",
                  opacity:
                    jobActionBusy ||
                    closingIncident ||
                    loading ||
                    (pendingConfirmAction === "send_back" &&
                      !pendingSendBackReason.trim())
                      ? 0.55
                      : 1,
                }}
              >
                {jobActionBusy || closingIncident
                  ? "Working…"
                  : pendingConfirmAction === "approve"
                  ? "Confirm Approve Job"
                  : pendingConfirmAction === "send_back"
                  ? "Confirm Send Back"
                  : "Confirm Close Job"}
              </button>
            </div>
          </section>
        ) : null}

        {/* PEAKOPS_REVIEW_ERR_PANEL_V2 (2026-04-28)
            Customer-facing failure copy (one line) + Retry button.
            Raw endpoint / status / body / envBase / fallback-disabled
            details are tucked into a dev-only collapsible so the
            customer never sees engineer text. */}
        {err ? (
          <div className="rounded-xl border border-red-400/30 bg-red-500/10 text-red-100 text-xs px-3 py-2">
            <div className="font-semibold">We had trouble loading this review.</div>
            <div className="mt-1 text-red-200/90">Your last loaded data is still visible. Tap Retry to try again.</div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="px-2 py-1 rounded border border-red-300/30 bg-black/30 hover:bg-black/50 text-[11px]"
                onClick={() => { void refresh(); }}
                disabled={loading}
              >
                Retry
              </button>
              {process.env.NODE_ENV !== "production" && canDevLog ? (
                <button
                  type="button"
                  className="px-2 py-1 rounded border border-red-300/30 bg-black/30 hover:bg-black/50 text-[11px]"
                  onClick={() => {
                    clearRememberedFunctionsBase();
                    location.reload();
                  }}
                >
                  Reset connection
                </button>
              ) : null}
            </div>
            {process.env.NODE_ENV !== "production" ? (
              <details className="mt-2 text-[11px] text-red-200/80">
                <summary className="cursor-pointer">Technical details (dev only)</summary>
                <div className="mt-1 break-all">{err}</div>
                {errDiag?.endpoint ? <div className="mt-1 break-all">endpoint: {errDiag.endpoint}</div> : null}
                {errDiag?.status ? <div className="mt-1">status: {errDiag.status}</div> : null}
                {errDiag?.body ? <pre className="mt-1 whitespace-pre-wrap break-words">{String(errDiag.body || "").slice(0, 500)}</pre> : null}
                <div className="mt-1 break-all">
                  baseDebug: {(() => {
                    const d = getFunctionsBaseDebugInfo();
                    return `env=${d.envBase || "(unset)"} override=${d.overrideBase || "(unset)"} active=${d.activeBase || "(unset)"}`;
                  })()}
                </div>
                {getEnvFunctionsBase() ? (
                  <div className="mt-1">envBase present, fallback disabled</div>
                ) : null}
              </details>
            ) : null}
          </div>
        ) : null}
        {/* PEAKOPS_REVIEW_HERO_V1 (2026-04-30)
            The Decision panel was a noisy duplicate of the NBA card
            (same status copy, same "Next Action" eyebrow) plus queue
            nav. The status copy lived in three places on the same
            screen. The hero card below absorbs the queue nav next to
            the task title; the NBA card above owns the status+CTA.
            Net: one decision surface, no duplicate readouts. */}

{/* PEAKOPS_REVIEW_UNIFY_SEND_BACK_V1 (2026-04-30)
    The standalone "Request update" panel was removed. It called
    createSupervisorRequest (a notification-only path that left the
    task in review state) while the NBA's "Send Back" called
    rejectJobV1 (the real send-back that actually returns the task to
    the field). Two paths, same intent — confusing.
    Now there is exactly one send-back surface: the NBA card's
    secondary action, labeled "Ask for update", which opens the
    inline confirm panel and routes through rejectJobV1 (with the
    auto-promote complete→review transition baked into commitSendBack
    so the supervisor never sees that step). */}





        {/* PEAKOPS_REVIEW_HERO_V1 (2026-04-30)
            Readiness section removed. Its three checks ("Selected task
            has at least one photo", "Selected task is complete or in
            review", "Field activity detected") were system-language
            paraphrases of state already encoded by the NBA card's
            enabled/disabled state. The photo count moves into the
            hero card's meta line; the rest is implicit. */}

        {/* PEAKOPS_REVIEW_HERO_V1 (2026-04-30)
            Single decision surface. The selected task is the hero —
            title, status pill, photo count. When more than one task
            is reviewable, a chip strip lets the supervisor switch
            without leaving the card. Per-task Approve / Send Back /
            Move-to-Review buttons were removed: the NBA card above is
            the only commit path, and commitSendBack auto-promotes
            complete→review behind the scenes so the user never sees
            that step. */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs uppercase tracking-wide text-gray-400">Job in review</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-[11px] text-gray-300 disabled:opacity-50"
                disabled={!queueNavEnabled || !prevIncident}
                onClick={() => {
                  if (!prevIncident?.incidentId) return;
                  const prevOrg = String((prevIncident as any)?.orgId || orgId || "").trim();
                  router.push(reviewPath(String(prevIncident.incidentId), prevOrg));
                }}
                title="Previous job in the review queue"
              >
                ← Prev job
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg bg-blue-600/15 border border-blue-400/20 hover:bg-blue-600/25 text-[11px] text-blue-100 disabled:opacity-50"
                disabled={!queueNavEnabled || !nextIncident}
                onClick={() => {
                  if (!nextIncident?.incidentId) return;
                  const nextOrg = String((nextIncident as any)?.orgId || orgId || "").trim();
                  router.push(reviewPath(String(nextIncident.incidentId), nextOrg));
                }}
                title="Next job in the review queue"
              >
                Next job →
              </button>
            </div>
          </div>

          {/* Hero body — closed / waiting / hero */}
          {incidentClosed ? (
            <div className="mt-4 text-sm text-emerald-200/90">
              Job closed. The report is ready to generate.
            </div>
          ) : !selectedJob ? (
            <div className="mt-4">
              {reviewableJobs.length === 0 && terminalJobs.length > 0 ? (
                <div className="text-sm text-emerald-200/90">All jobs approved — ready to close.</div>
              ) : reviewableJobs.length === 0 ? (
                <div className="text-sm text-gray-300">
                  Waiting on the field team to mark a job complete with attached photos.
                </div>
              ) : (
                <div className="text-sm text-gray-300">
                  {reviewableJobs.length} {reviewableJobs.length === 1 ? "job" : "jobs"} ready — pick one to review.
                </div>
              )}
              {reviewableJobs.length === 0 && terminalJobs.length === 0 ? (
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-md text-[11px] font-semibold border border-amber-300/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
                    onClick={() => router.push(incidentPath(incidentId, orgId, { hash: "evidence" }))}
                  >
                    ← Return to Evidence
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-md text-[11px] font-semibold border border-white/15 bg-white/5 text-gray-200 hover:bg-white/10"
                    onClick={() => router.push(incidentPath(incidentId, orgId, { hash: "tasks" }))}
                  >
                    Open Jobs →
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div ref={jobDetailPanelRef} className="mt-3">
              <div className="min-w-0">
                <div className="text-base font-semibold text-gray-100 truncate" title={String(selectedJob?.title || "Job")}>
                  {String(selectedJob?.title || "Job")}
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/15 bg-white/5 text-gray-200">
                    {humanizeReviewStatus(selectedJobReviewStatus || "") !== "—"
                      ? humanizeReviewStatus(selectedJobReviewStatus || "")
                      : humanizeJobBaseStatus(selectedJobStatus || "open")}
                  </span>
                  <span className="text-[11px] text-gray-400">
                    {selectedJobEvidenceCount} {selectedJobEvidenceCount === 1 ? "photo" : "photos"} attached
                  </span>
                  {/* PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
                      Read-only vendor pill in the review meta line.
                      The supervisor sees the assignment as part of
                      the review context. Editing happens on the
                      incident detail page; surfacing it here too
                      would clutter the review focal point. */}
                  {String(selectedJob?.vendorName || "").trim() ? (
                    <span className="text-[11px] text-gray-400" title="Service provider assigned to this task">
                      Vendor: <span className="text-gray-200">{String(selectedJob?.vendorName).trim()}</span>
                    </span>
                  ) : null}
                </div>
              </div>

              {selectedJobEvidence.length > 0 ? (
                <div className="mt-3 space-y-1 max-h-40 overflow-auto pr-1">
                  {/* PEAKOPS_REVIEW_PHOTO_LABELS_V2 (2026-05-05)
                      Customer-facing labels — "Photo 1", "Photo 2",
                      etc. Raw camera filenames ("5.png", "IMG_1234.jpg")
                      were leaking into the supervisor view; index-based
                      captions read like a real report. The original
                      filename stays in the title attribute for
                      operators who need it. */}
                  {selectedJobEvidence.map((ev: any, idx: number) => {
                    const orig = String(getFileField(ev, "originalName") || "").trim();
                    return (
                      <div
                        key={String(ev?.id || "")}
                        title={orig || `Photo ${idx + 1}`}
                        className="text-xs text-gray-300 truncate rounded bg-black/30 border border-white/10 px-2 py-1"
                      >
                        Photo {idx + 1}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 text-xs text-amber-200/90">
                  No photos attached yet — the field team needs to attach photos before this can be approved.
                </div>
              )}

              {(selectedJobReviewStatus === "approved" || selectedJobReviewStatus === "revision_requested") ? (
                <div className="mt-3 text-xs text-gray-400">
                  {selectedJobReviewStatus === "approved"
                    ? "Approved. No further action needed."
                    : "Sent back to the field team. Waiting for a fresh submission."}
                </div>
              ) : null}
            </div>
          )}

          {/* Other reviewable tasks — chip strip when more than one is ready */}
          {reviewableJobs.length > 1 ? (
            <div className="mt-4 pt-3 border-t border-white/10">
              <div className="text-[10px] uppercase tracking-[0.14em] text-gray-500 mb-2">Other jobs ready</div>
              <div className="flex flex-wrap gap-2">
                {reviewableJobs.map((j: any) => {
                  const jid = String(j?.id || j?.jobId || "");
                  const active = jid === String(selectedJobId || "");
                  if (active) return null;
                  return (
                    <button
                      key={jid}
                      type="button"
                      onClick={() => openJobForReview(jid)}
                      className="px-3 py-1.5 rounded-full text-[11px] border bg-black/30 border-white/15 text-gray-200 hover:border-white/30 hover:bg-white/5"
                    >
                      {String(j?.title || `Job ${jid.slice(-6)}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* History — collapsed disclosure so it never crowds the hero */}
          {terminalJobs.length > 0 ? (
            <details className="mt-4 pt-3 border-t border-white/10">
              <summary className="cursor-pointer text-[10px] uppercase tracking-[0.14em] text-gray-500 select-none">
                History · {terminalJobs.length}
              </summary>
              <div className="mt-2 space-y-1.5">
                {terminalJobs.map((j: any) => {
                  const jid = String(j?.id || j?.jobId || "");
                  const st = String(j?.status || "").toLowerCase();
                  const active = jid === String(selectedJobId || "");
                  return (
                    <button
                      key={`history_${jid}`}
                      type="button"
                      className={
                        "w-full text-left rounded-md border px-3 py-1.5 transition " +
                        (active ? "bg-white/10 border-white/30" : "bg-black/30 border-white/10 hover:border-white/20")
                      }
                      onClick={() => openJobForReview(jid)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-gray-100 truncate">{String(j?.title || `Job ${jid.slice(-6)}`)}</div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/15 bg-white/5 text-gray-200">
                          {st === "approved" ? "Approved" : st === "rejected" ? "Sent back" : "Closed"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </details>
          ) : null}

          {devMode ? (
            <div className="mt-4 pt-3 border-t border-white/10 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                className="px-2 py-1 rounded text-[10px] border bg-white/5 border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-50"
                disabled={loading || jobActionBusy}
                onClick={() => { void backfillJobLinks(); }}
                title="Re-link evidence photos to their tasks (dev only)"
              >
                Re-link photos
              </button>
              {mounted && showJobsDebugPanel ? (
                <details className="text-[10px] text-gray-300">
                  <summary className="cursor-pointer select-none">Tasks debug (raw)</summary>
                  <pre className="mt-1 max-h-44 overflow-auto rounded bg-black/40 border border-white/10 p-2 whitespace-pre-wrap break-words">
                    {JSON.stringify(rawJobsDebug, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </section>

        
                {/* PEAKOPS_REVIEW_EVIDENCE_GALLERY_V1 */}
        <section ref={evidenceSectionRef} className="rounded-2xl bg-white/5 border border-white/10 p-4" id="review-evidence">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Photos</div>
              <div className="text-xs text-gray-500">
                {evidenceN} captured • showing {visibleEvidence.length}{evidenceFilterJobId ? " (filtered)" : " (latest)"}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                onClick={() => downloadAllVisible()}
                title="Opens each evidence download in a new tab (may be popup-blocked)"
              >
                ⬇ Download all
              </button>
              {devMode ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                  onClick={() => {
                    setThumbReasonById({});
                    refreshVisibleThumbsDebounced();
                  }}
                >
                  Refresh thumbnails
                </button>
              ) : null}
              {devMode ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                  onClick={() => setThumbDebugOverlay((v) => !v)}
                >
                  {thumbDebugOverlay ? "Hide thumb debug" : "Show thumb debug"}
                </button>
              ) : null}

              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                onClick={() => {
                  if (!incidentId) return;
                  router.push(incidentPath(incidentId, orgId, { hash: "evidence" }));
                }}
                title="Open the field incident page evidence rail"
              >
                Open full record
              </button>

              {evidenceN > evidenceLimit ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-blue-600/18 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25"
                  onClick={() => setEvidenceLimit((n) => Math.min(n + 12, evidenceN))}
                >
                  Load more
                </button>
              ) : null}
              {evidenceFilterJobId ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                  onClick={() => setEvidenceFilterJobId("")}
                >
                  Clear filter
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-3 -mx-1 px-1 overflow-x-auto">
            <div className="flex gap-2 justify-center">
              {(() => {
                return visibleEvidence.map((ev: any, evIdx: number) => {
                  const id = String(ev?.id || ev?.evidenceId || "");
                  const media = getTileMedia(ev as any);
                  // PEAKOPS_REVIEW_THUMB_SIGNED_V1 (2026-04-24)
                  // Read the minted signed URL from state (populated by the
                  // prefetch effect above) and run it through toInlineMediaUrl
                  // so emulator URLs still route through /api/media while
                  // production URLs go direct to storage.googleapis.com.
                  // buildThumbProxyUrl (which hardcoded /api/media) is no
                  // longer called — /api/media returns 410 outside the
                  // emulator and would break review thumbnails in prod.
                  const mintedRaw = media.mode === "image" ? (thumbUrlById[id] || "") : "";
                  const u = toInlineMediaUrl(mintedRaw);
                  // PEAKOPS_REVIEW_PHOTO_LABELS_V3 (2026-05-05)
                  // Customer-facing tile caption is "Photo N" — never
                  // the raw filename. The original filename is kept on
                  // the title attribute for engineers/operators who
                  // explicitly hover.
                  const originalName = String(getFileField(ev, "originalName") || "").trim();
                  const photoLabel = `Photo ${evIdx + 1}`;
                  const labels = (ev?.labels || []).map((x: any) => String(x).toUpperCase());
                  const reason = String(thumbReasonById[id] || "").trim();

                  return (
                    <button
                      key={id || photoLabel}
                      type="button"
                      className={
                        "min-w-[148px] w-[148px] sm:min-w-[168px] sm:w-[168px] aspect-[4/3] relative rounded-xl overflow-hidden border " +
                        (selectedEvidenceId === id ? "border-blue-400/40 ring-2 ring-blue-500/20 " : "border-white/10 ") +
                        "bg-black/40 hover:border-white/25 hover:scale-[1.015] hover:bg-black/50 transition-all duration-150"
                      }
                      onClick={() => openEvidenceFromAction(ev)}
                      title={originalName || photoLabel}
                    >
                      {u ? (
                        <img
                          src={u}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onLoad={() => {
                            setThumbRetryById((m) => ({ ...m, [id]: 0 }));
                            setThumbStatusById((m) => ({ ...m, [id]: 200 }));
                            setThumbErrorById((m) => ({ ...m, [id]: "" }));
                            logThumbEvent("retry_ok", {
			      evidenceId: (selectedEvidenceId || "unknown"),
                              kind: media.mode === "image" ? media.ref.kind : "unknown",
                              storagePath: media.mode === "image" ? media.ref.storagePath : "",
                            });
                            setThumbReasonById((m) => {
                              if (!m[id]) return m;
                              const n = { ...m };
                              delete n[id];
                              return n;
                            });
                          }}
                          onError={() => { void handleThumbDecodeError(id, u, media); }}
                        />
                      ) : (
                        // PEAKOPS_REVIEW_THUMB_LOADING_V1 (2026-05-05)
                        // Show "Loading…" while the signed read URL
                        // is in flight; only fall through to
                        // "Unavailable" when the media metadata
                        // itself is a hard placeholder (unrenderable
                        // type, missing bucket/path) OR a fetch has
                        // genuinely failed (thumbReasonById entry
                        // exists). Previously the falsy-URL branch
                        // collapsed both states into "Unavailable",
                        // so the buyer saw "Unavailable" briefly on
                        // every cold load before the real image
                        // landed.
                        <div className="w-full h-full flex items-center justify-center text-xs text-gray-500 text-center px-2">
                          {media.mode === "placeholder"
                            ? media.label
                            : reason
                              ? "Unavailable"
                              : "Loading…"}
                        </div>
                      )}

                      <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                        {labels.slice(0, 2).map((l: string) => (
                          <span
                            key={l}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-black/40 border border-white/15 text-gray-100 backdrop-blur"
                          >
                            {l}
                          </span>
                        ))}
                      </div>

                      <div className="absolute bottom-2 left-2 right-2 text-[10px] text-gray-200/90 truncate bg-black/40 px-2 py-1 rounded">
                        {photoLabel}
                      </div>
                      {process.env.NODE_ENV !== "production" && reason ? (
                        <div className="absolute left-2 right-2 bottom-8 text-[10px] text-red-200 truncate bg-black/55 px-2 py-1 rounded border border-red-400/30">
                          {reason}
                        </div>
                      ) : process.env.NODE_ENV !== "production" && media.mode === "placeholder" ? (
                        <div className="absolute left-2 right-2 bottom-8 text-[10px] text-yellow-200 truncate bg-black/55 px-2 py-1 rounded border border-yellow-400/30">
                          {media.reason}
                        </div>
                      ) : null}
                      {process.env.NODE_ENV !== "production" && thumbDebugOverlay && media.mode === "image" ? (
                        <div className="absolute left-2 right-2 top-8 text-[10px] text-cyan-100 bg-black/60 px-2 py-1 rounded border border-cyan-300/30">
                          <div className="truncate">id={id}</div>
                          <div className="truncate">b={media.ref.bucket}</div>
                          <div className="truncate">p={media.ref.storagePath}</div>
                          <div className="truncate">mint_http={String(thumbStatusById[id] || 0)}</div>
                          <div className="truncate">mint_error={String(thumbErrorById[id] || "-")}</div>
                          <div className="truncate">probe_http=-</div>
                          <div className="truncate">probe_error=-</div>
                        </div>
                      ) : null}
                    </button>
                  );
                });
              })()}
            </div>
          </div>

          <div className="mt-2 text-[11px] text-gray-500">
            Click a tile to preview. Use “Open full record” for the full field page rail.
          </div>
        </section>


        {/* PEAKOPS_REVIEW_EVIDENCE_MODAL_V1 */}
        {previewOpen ? (
          <div className="fixed inset-0 bg-black/70 backdrop-blur flex items-center justify-center p-6 z-50">
            <div className="w-full max-w-4xl rounded-2xl bg-black border border-white/10 overflow-hidden">
              <div className="flex items-center justify-between p-3 border-b border-white/10 gap-3">
                <div className="text-sm text-gray-200 truncate">{previewName}</div>
                <div className="flex items-center gap-2">
                  {previewUrl ? (
                    <a
                      className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      download
                      title="Download image"
                    >
                      ⬇ Download
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="px-3 py-2 rounded-xl bg-blue-600/20 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25"
                    onClick={() => setPreviewOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="p-3">
                {previewUrl ? (
                  <img src={toInlineMediaUrl(previewUrl)} className="w-full max-h-[70vh] object-contain" />
                ) : (
                  <div className="text-gray-400 text-sm">Loading…</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
{/* Timeline summary */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Timeline</div>
            <div className="text-xs text-gray-500">{timeline.length} events</div>
          </div>

          <div className="mt-3 space-y-2">
            {timeline.slice(0, 12).map((t) => {
              const clock = timelineClock(t.occurredAt?._seconds);
              const ago = fmtAgo(t.occurredAt?._seconds);
              return (
                <div
                  key={t.id}
                  className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-100">
                      {prettyTimelineType(String(t.type || ""))}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 whitespace-nowrap">{clock || ago}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
