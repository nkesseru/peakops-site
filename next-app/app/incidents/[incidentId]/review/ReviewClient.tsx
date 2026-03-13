"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { getBestEvidenceImageRef, logThumbEvent } from "@/lib/evidence/signedThumb";






// PEAKOPS_REQUEST_UPDATE_V1
async function createSupervisorRequest(orgId: string, incidentId: string, message: string, jobId?: string) {
  const res = await fetch("/api/fn/createSupervisorRequestV1", {
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
  const res = await fetch("/api/fn/exportIncidentPacketV1", {
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
  const res = await fetch("/api/fn/approveAndLockJobV1", {
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

async function postJson<T>(url: string, body: any, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
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
      const ref = getBestEvidenceImageRef(ev);
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

  useEffect(() => {
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
  }, []);

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

  const orgId = "riverbend-electric";
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
  const [toastMsg, setToastMsg] = useState<string>("");
  const [mounted, setMounted] = useState(false);

  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [incidentDoc, setIncidentDoc] = useState<IncidentDoc | null>(null);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [jobActionBusy, setJobActionBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // Gallery state
  const [thumbReasonById, setThumbReasonById] = useState<Record<string, string>>({});
  const [thumbCacheBustById, setThumbCacheBustById] = useState<Record<string, number>>({});
  const [thumbRetryById, setThumbRetryById] = useState<Record<string, number>>({});
  const [thumbStatusById, setThumbStatusById] = useState<Record<string, number>>({});
  const [thumbErrorById, setThumbErrorById] = useState<Record<string, string>>({});
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
    const res = await fetch(url, { headers: demoHeaders });
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
    const retryN = Number(thumbRetryById[evidenceId] || 0);
    if (retryN < 1) {
      if (canDevLog) {
        logThumbEvent("img_error", {
	  evidenceId: (selectedEvidenceId || "unknown"),
          kind: media?.mode === "image" ? media.ref.kind : "unknown",
          bucket: media?.mode === "image" ? media.ref.bucket : "",
          storagePath: media?.mode === "image" ? media.ref.storagePath : "",
          src: url,
          retryCount: retryN,
        });
      }
      logThumbEvent("retry_start", {
	evidenceId: (selectedEvidenceId || "unknown"),
        kind: media?.mode === "image" ? media.ref.kind : "unknown",
        storagePath: media?.mode === "image" ? media.ref.storagePath : "",
        retryCount: retryN,
      });
      setThumbRetryById((m) => ({ ...m, [evidenceId]: retryN + 1 }));
      setThumbCacheBustById((m) => ({ ...m, [evidenceId]: Date.now() }));
      return;
    }
    try {
      const debugUrl = `${url}${url.includes("?") ? "&" : "?"}debug=1`;
      const res = await fetch(debugUrl, { method: "GET", cache: "no-store" });
      const txt = await res.text().catch(() => "");
      let out: any = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch {}
      const ct = String(out?.ct || out?.contentType || res.headers.get("content-type") || "").trim();
      const err = String(out?.error || "").trim();
      const magic = String(out?.magic?.got || "").trim();
      const size = out?.size != null ? String(out.size) : "";
      setThumbStatusById((m) => ({ ...m, [evidenceId]: Number(res.status || 0) }));
      setThumbErrorById((m) => ({ ...m, [evidenceId]: err || "thumb_proxy_failed" }));
      setThumbReasonById((m) => ({
        ...m,
        [evidenceId]: `thumb_proxy_failed http=${res.status} error=${err || "unknown"} ct=${ct || "unknown"} magic=${magic || "-"} size=${size || "-"}`,
      }));
      logThumbEvent("retry_fail", {
	evidenceId: (selectedEvidenceId || "unknown"),
        status: res.status,
        error: err || "unknown",
        storagePath: media?.mode === "image" ? media.ref.storagePath : "",
      });
    } catch {
      setThumbStatusById((m) => ({ ...m, [evidenceId]: 0 }));
      setThumbErrorById((m) => ({ ...m, [evidenceId]: "probe_failed" }));
      setThumbReasonById((m) => ({ ...m, [evidenceId]: "thumb_proxy_failed http=0 error=probe_failed" }));
      logThumbEvent("retry_fail", {
	evidenceId: (selectedEvidenceId || "unknown"),
        status: 0,
        error: "probe_failed",
        storagePath: media?.mode === "image" ? media.ref.storagePath : "",
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

  async function refresh(retryAttempt = 0, baseOverride?: string, fallbackUsed = false): Promise<JobDoc[]> {
    const base = String(baseOverride || functionsBase || "").trim();
    if (!base) return [];
    setLoading(true);
    setErr("");
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
        return st === "complete" && Number(nextEvidenceCountByJob[jid] || 0) >= 1;
      });
      const exists = reviewable.some((j: any) => String(j?.id || j?.jobId || "") === String(selectedJobId || ""));

      setIncidentDoc(nextIncidentDoc);
      setEvidence(nextEvidence);
      setJobs(nextJobs);
      setTimeline(nextTimeline);
      if (!exists) {
        const next = String(reviewable?.[0]?.id || reviewable?.[0]?.jobId || "");
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
      setErrDiag({
        endpoint: String((e as any)?.endpoint || ""),
        status: Number((e as any)?.status || 0) || undefined,
        body: String((e as any)?.body || "").slice(0, 500),
      });
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
      return st === "complete" && Number(evidenceCountByJob[jid] || 0) >= 1;
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
  const selectedJobStatus = computedBaseStatus(selectedJob || {});
  const selectedJobReviewStatus = computedReviewStatus(selectedJob || {});
  const selectedJobInReview = selectedJobReviewStatus === "review";
  const selectedJobApproved = selectedJobReviewStatus === "approved";
  const noReviewablesApproved = !hasReviewableJob && latestTerminalStatus === "approved";
  const selectedJobEvidence = useMemo(() => {
    const sid = String(selectedJobId || "");
    if (!sid) return [];
    return (evidence || []).filter((ev: any) => getLinkedJobId(ev) === sid);
  }, [evidence, selectedJobId]);
  const selectedJobReadyState = selectedJobReviewStatus === "review" || selectedJobStatus === "complete";
  const selectedJobEvidenceCount = selectedJobEvidence.length;
  const ready = selectedJobReadyState && selectedJobEvidenceCount >= 1;
  const missingItems = useMemo(() => {
    const out: string[] = [];
    if (noReviewablesApproved) return out;
    if (!hasReviewableJob) out.push("No reviewable jobs (status=complete and linked evidence>=1)");
    if (!selectedJobReadyState && !selectedJobApproved) out.push("Selected job must be complete or review");
    if (selectedJobEvidenceCount < 1) out.push("Selected job needs at least 1 linked evidence item");
    if (selectedJobApproved) out.push("Selected job is approved (terminal).");
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

  function openJobForReview(jobIdRaw: string) {
    const jid = String(jobIdRaw || "").trim();
    if (!jid) return;
    setSelectedJobId(jid);
    setEvidenceFilterJobId(jid);
    try { jobDetailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {}
  }

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const sid = String(selectedJobId || "");
    if (!sid) return;
    const linked = (evidence || []).filter((ev: any) => getLinkedJobId(ev) === sid);
    console.debug("[review-selected-job]", {
      selectedJobId: sid,
      totalEvidence: (evidence || []).length,
      linkedEvidenceCount: linked.length,
      firstLinkedIds: linked.slice(0, 3).map((ev: any) => String(ev?.id || "")),
    });
  }, [selectedJobId, evidence]);

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

    const res = await fetch("/api/fn/approveAndLockJobV1", {
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

  async function sendBack() {
    alert("TODO: wire send-back endpoint (sendBackIncidentV1). For now, this is a stub.");
  }

  async function approveJob(jobId: string) {
    try {
      if (selectedJobReviewStatus !== "review") {
        toast("Move to Review first.");
        return;
      }
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
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setJobActionBusy(false);
    }
  }

  async function rejectJob(jobId: string) {
    try {
      if (selectedJobReviewStatus !== "review") {
        toast("Move to Review first.");
        return;
      }
      const reason = String(rejectReason || "").trim();
      if (!reason) {
        toast("Reject reason is required.");
        return;
      }
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
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setJobActionBusy(false);
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
      await refreshAfterMutation((rows) => {
        const j = (rows || []).find((x: any) => String(x?.id || x?.jobId || "") === jid);
        const st = String(j?.status || "").toLowerCase();
        const rs = String((j as any)?.reviewStatus || "").toLowerCase();
        return st === "review" || rs === "review";
      });
    } catch (e: any) {
      setErr(String(e?.message || e));
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
      setErr(String(e?.message || e));
    } finally {
      setJobActionBusy(false);
    }
  }


  return (
    <main className="min-h-screen bg-black text-white">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
            <div className="text-lg font-semibold truncate">{incidentId}</div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            
<button
  className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
  onClick={() => {
    try {
      exportIncidentPacket(String(orgId||""), String(incidentId||""))
        .then((url) => {
          console.log("[ExportPacket] url:", url);
          window.open(url, "_blank", "noreferrer");
        })
        .catch((e:any) => console.error(e));
    } catch (e) { console.error(e); }
  }}
  title="Export incident packet ZIP"
>
  📦 Download Packet
</button>

<button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() => router.push(`/incidents/${incidentId}`)}
            >
              ← Back to Incident
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-blue-600/20 border border-blue-400/20 text-blue-100 hover:bg-blue-600/25 text-sm"
              onClick={() => router.push(`/incidents/${incidentId}/notes`)}
            >
              📝 Notes
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() => router.push(`/incidents/${incidentId}/summary`)}
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
        {err ? (
          <div className="rounded-xl border border-red-400/30 bg-red-500/10 text-red-100 text-xs px-3 py-2">
            <div className="font-semibold">Review refresh failed</div>
            <div className="mt-1 break-all">{err}</div>
            {errDiag?.endpoint ? <div className="mt-1 break-all text-red-200/90">endpoint: {errDiag.endpoint}</div> : null}
            {errDiag?.status ? <div className="mt-1 text-red-200/90">status: {errDiag.status}</div> : null}
            {errDiag?.body ? <pre className="mt-1 text-red-200/90 whitespace-pre-wrap break-words">{String(errDiag.body || "").slice(0, 500)}</pre> : null}
            {process.env.NODE_ENV !== "production" ? (
              <div className="mt-1 text-red-200/90 break-all">
                baseDebug: {(() => {
                  const d = getFunctionsBaseDebugInfo();
                  return `env=${d.envBase || "(unset)"} override=${d.overrideBase || "(unset)"} active=${d.activeBase || "(unset)"}`;
                })()}
              </div>
            ) : null}
            {process.env.NODE_ENV !== "production" && getEnvFunctionsBase() ? (
              <div className="mt-1 text-red-200/90">envBase present, fallback disabled</div>
            ) : null}
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
          </div>
        ) : null}
        {/* Status + actions */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-gray-400">Decision</div>
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-gray-500">Review Queue</div>
              <div className="mt-1 text-sm text-gray-200">Position {queuePositionLabel}</div>
              <div className="text-xs text-gray-500 mt-1">{queueRemaining} remaining after this</div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm disabled:opacity-50"
                disabled={!prevIncident}
                onClick={() => {
                  if (!prevIncident?.incidentId) return;
                  router.push(`/incidents/${encodeURIComponent(String(prevIncident.incidentId))}/review`);
                }}
              >
                ← Previous
              </button>

              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-blue-600/18 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25 disabled:opacity-50"
                disabled={!nextIncident}
                onClick={() => {
                  if (!nextIncident?.incidentId) return;
                  router.push(`/incidents/${encodeURIComponent(String(nextIncident.incidentId))}/review`);
                }}
              >
                Next →
              </button>
            </div>
          </div>
        </div>

              <div className="text-sm text-gray-200">
                {ready
                  ? "Ready to approve."
                  : noReviewablesApproved
                    ? "No reviewable jobs. Latest decision: approved."
                    : "Not ready yet — select a complete/review job with linked evidence."}
              </div>
              {err && canDevLog ? <div className="text-xs text-red-300 mt-1 truncate">Error: {err}</div> : null}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10 disabled:opacity-50"
                onClick={sendBack}
                disabled={loading}
                title="Send back to field with reasons"
              >
                ↩︎ Send Back
              </button>

              <button
                className={
                  "px-3 py-2 rounded-xl text-sm font-semibold border " +
                  (ready
                    ? "bg-green-700/25 border-green-400/25 text-green-200 hover:bg-green-700/35"
                    : "bg-white/5 border-white/10 text-gray-500")
                }
                onClick={() => {
                  try {
                    // Try common state vars
                    // @ts-ignore
                    const jid =
                      (typeof selectedJobId !== "undefined" && selectedJobId) ? String(selectedJobId) :
                      // @ts-ignore
                      (typeof activeJobId !== "undefined" && activeJobId) ? String(activeJobId) :
                      // @ts-ignore
                      (typeof selectedJob !== "undefined" && selectedJob && (selectedJob.id || selectedJob.jobId)) ? String(selectedJob.id || selectedJob.jobId) :
                      "";
                    if (!jid) { console.error("[Approve&Lock] missing selected jobId"); return; }
                    approveAndLockJob(String(orgId || ""), String(incidentId || ""), jid)
                      .then(() => { try { location.reload(); } catch {} })
                      .catch((e:any) => console.error(e));
                  } catch (e) { console.error(e); }
                }}
                disabled={!ready || loading}
                title={ready ? "Approve & lock the record" : "Not ready yet"}
              >
                🛡 Approve & Lock
              </button>
            </div>
          </div>
        </section>

{/* PEAKOPS_MOVE_REQ_UPDATE_UNDER_DECISION_V4 */}
{/* PEAKOPS_V2_REVIEW_ACTIONS_UI */}
      <div className="rounded-2xl bg-white/5 border border-white/10 p-4 mt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400">Request update</div>
            <div className="text-sm text-gray-200">Ask the field team for better photos / missing info.</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
              onClick={() => { setReqOpen(false); }}
            >
              View evidence
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-xl bg-blue-600/18 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25"
              onClick={() => {
                try {
                  const msg = window.prompt("What update do you want from the field team?");
                  if (!msg || !String(msg).trim()) return;
                  // Best-effort selected job id
                  // @ts-ignore
                  const jid =
                    (typeof selectedJobId !== "undefined" && selectedJobId) ? String(selectedJobId) :
                    // @ts-ignore
                    (typeof activeJobId !== "undefined" && activeJobId) ? String(activeJobId) :
                    // @ts-ignore
                    (typeof selectedJob !== "undefined" && selectedJob && (selectedJob.id || selectedJob.jobId)) ? String(selectedJob.id || selectedJob.jobId) :
                    "";
                  createSupervisorRequest(String(orgId||""), String(incidentId||""), String(msg).trim(), jid)
                    .then(() => { try { location.reload(); } catch {} })
                    .catch((e:any) => console.error(e));
                } catch (e) { console.error(e); }
              }}
            >
              Request update
            </button>
          </div>
        </div>

        {reqOpen ? (
          <div className="mt-3">
            <textarea
              className="w-full min-h-[110px] bg-black/30 border border-white/10 rounded-xl p-3 text-sm text-gray-200 outline-none"
              placeholder="Example: Please re-shoot the pole base from 10ft back + include hazard tape + include GPS landmark..."
              value={reqText}
              onChange={(e) => setReqText(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
		onClick={() => {
  		setReqOpen(false);
		}}             
		 >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-blue-600/22 border border-blue-400/22 text-sm text-blue-100 hover:bg-blue-600/30"
                onClick={() => {
                  saveRequest();
                  // v2: we just store + bounce to incident evidence area with a hint.
                  if (incidentId) router.push("/incidents/" + incidentId + "?hi=request_update");
                  setReqOpen(false);
                }}
              >
                Save request
              </button>
            </div>
            <div className="mt-2 text-[11px] text-gray-500">
              V2 behavior: stored locally for demo. V2.1: persist to Firestore + notify crew.
            </div>
          </div>
        ) : null}
      </div>





        {/* Readiness */}
        <section className={"rounded-2xl border p-4 " + (ready ? "bg-green-700/15 border-green-400/20" : "bg-white/5 border-white/10")}>
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Readiness</div>
            <span className="text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300">
              {loading ? "Refreshing…" : "Live"}
            </span>
          </div>

          <div className="mt-3 grid gap-2 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
              <div className="text-gray-300">Field activity detected (info)</div>
              <div className={hasSession ? "text-green-300" : "text-gray-500"}>{hasSession ? "✓" : "—"}</div>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
              <div className="text-gray-200">Selected job evidence (1+)</div>
              <div className={selectedJobEvidenceCount >= 1 ? "text-green-300" : "text-gray-500"}>{selectedJobEvidenceCount >= 1 ? "✓" : "—"}</div>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
              <div className="text-gray-200">Selected job state (complete/review)</div>
              <div className={selectedJobReadyState ? "text-green-300" : "text-gray-500"}>{selectedJobReadyState ? "✓" : "—"}</div>
            </div>
          </div>

          <div className="mt-2 text-xs text-gray-400">
            Approval readiness is based on selected job state and linked evidence.
          </div>
          {missingItems.length ? (
            <div className="mt-2 text-xs text-amber-200">
              Missing: {missingItems.join(" • ")}
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Jobs Review</div>
              <div className="text-xs text-gray-500">
                Reviewable: {reviewableJobs.length} (status=complete and linked evidence&gt;=1)
              </div>
              {reviewableJobs.length === 0 ? (
                <div className="mt-1 text-xs text-amber-200">
                  {terminalJobs.length > 0
                    ? `No reviewable jobs. Latest decision: ${latestTerminalStatus || "finalized"}.`
                    : "No reviewable jobs yet. Complete a job in Field view."}
                </div>
              ) : null}
            </div>
            {mounted && showJobsDebugPanel ? (
              <details className="text-[11px] text-gray-300">
                <summary className="cursor-pointer select-none">Jobs debug (raw listJobsV1 docs)</summary>
                <pre className="mt-1 max-h-44 overflow-auto rounded bg-black/40 border border-white/10 p-2 whitespace-pre-wrap break-words">
                  {JSON.stringify(rawJobsDebug, null, 2)}
                </pre>
              </details>
            ) : null}
            {process.env.NODE_ENV !== "production" ? (
              <button
                type="button"
                className="px-2 py-1 rounded text-xs border bg-white/6 border-white/12 text-gray-200 hover:bg-white/10 disabled:opacity-50"
                disabled={loading || jobActionBusy}
                onClick={() => { void backfillJobLinks(); }}
              >
                Backfill job links
              </button>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              {reviewableJobs.length === 0 ? (
                <div className="text-sm text-gray-400">No jobs in complete state pending approval.</div>
              ) : reviewableJobs.map((j: any) => {
                const jid = String(j?.id || j?.jobId || "");
                const active = jid === String(selectedJobId || "");
                const rs = computedReviewStatus(j);
                return (
                  <div
                    key={jid}
                    className={
                      "w-full rounded-lg border px-3 py-2 transition " +
                      (active ? "bg-blue-600/15 border-blue-400/30" : "bg-black/30 border-white/10 hover:border-white/20")
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedJobId(jid)}
                        className="text-left min-w-0 flex-1"
                      >
                        <div className="text-sm text-gray-100 truncate">{String(j?.title || jid)}</div>
                        <div className="text-[11px] text-gray-400">
                          state: {computedBaseStatus(j)} • review: {rs} {j?.assignedTo ? `• assigned: ${String(j.assignedTo)}` : ""}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="px-2 py-1 rounded text-xs border bg-white/6 border-white/12 text-gray-200 hover:bg-white/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          openJobForReview(jid);
                        }}
                      >
                        Open
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div ref={jobDetailPanelRef} className="rounded-xl border border-white/10 bg-black/30 p-3">
              {!selectedJob ? (
                <div className="text-sm text-gray-400">Select a job to review details.</div>
              ) : (
                <>
                  <div className="text-sm font-semibold text-gray-100">{String(selectedJob?.title || selectedJobId)}</div>
                  <div className="text-xs text-gray-400 mt-1">jobId: {String(selectedJobId)}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    state: {selectedJobStatus || "open"} • review: {selectedJobReviewStatus}
                  </div>

                  <div className="mt-3 text-xs uppercase tracking-wide text-gray-400">Evidence for this job</div>
                  <div className="mt-2 space-y-1 max-h-48 overflow-auto">
                    {selectedJobEvidence.length === 0 ? (
                      <div className="text-xs text-gray-500">No evidence linked (assign on incident page)</div>
                    ) : selectedJobEvidence.map((ev: any) => (
                      <div key={String(ev?.id || "")} className="text-xs text-gray-200 truncate">
                        {String(getFileField(ev, "originalName") || ev?.id || "evidence")}
                      </div>
                    ))}
                  </div>

                  {selectedJobStatus === "complete" && selectedJobReviewStatus !== "review" && selectedJobReviewStatus !== "approved" ? (
                    <div className="mt-3">
                      <button
                        type="button"
                        className="w-full px-3 py-2 rounded-lg bg-blue-700/25 border border-blue-400/25 text-blue-200 hover:bg-blue-700/35 disabled:opacity-50"
                        disabled={loading || jobActionBusy}
                        onClick={() => { void moveSelectedJobToReview(); }}
                      >
                        Move to Review
                      </button>
                    </div>
                  ) : null}
                  {selectedJobReviewStatus === "review" ? (
                    <>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          className="px-3 py-2 rounded-lg bg-green-700/25 border border-green-400/25 text-green-200 hover:bg-green-700/35 disabled:opacity-50"
                          disabled={loading || jobActionBusy}
                          onClick={() => approveJob(String(selectedJobId))}
                        >
                          Approve Job
                        </button>
                        <button
                          type="button"
                          className="px-3 py-2 rounded-lg bg-red-700/25 border border-red-400/25 text-red-200 hover:bg-red-700/35 disabled:opacity-50"
                          disabled={loading || jobActionBusy}
                          onClick={() => rejectJob(String(selectedJobId))}
                        >
                          Reject Job
                        </button>
                      </div>
                      <textarea
                        className="mt-2 w-full min-h-[70px] bg-black/30 border border-white/10 rounded-xl p-2 text-xs text-gray-200 outline-none"
                        placeholder="Reject reason (required for reject)"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                      />
                    </>
                  ) : null}
                  {(selectedJobReviewStatus === "approved" || selectedJobReviewStatus === "revision_requested") ? (
                    <div className="mt-3 text-xs text-gray-400">
                      Final status: {selectedJobReviewStatus}. Actions are locked.
                    </div>
                  ) : null}
                  {(selectedJobStatus !== "complete" && selectedJobReviewStatus !== "review" && selectedJobReviewStatus !== "approved" && selectedJobReviewStatus !== "revision_requested") ? (
                    <div className="mt-3 text-xs text-gray-400">
                      Actions are unavailable for state: {selectedJobStatus || "unknown"} (review: {selectedJobReviewStatus}).
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-white/10 bg-black/25 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-400">History (Approved/Rejected)</div>
            <div className="mt-2 space-y-2">
              {terminalJobs.length === 0 ? (
                <div className="text-xs text-gray-500">No terminal job decisions yet.</div>
              ) : terminalJobs.map((j: any) => {
                const jid = String(j?.id || j?.jobId || "");
                const st = String(j?.status || "").toLowerCase();
                const active = jid === String(selectedJobId || "");
                return (
                  <button
                    key={`history_${jid}`}
                    type="button"
                    className={
                      "w-full text-left rounded-lg border px-3 py-2 transition " +
                      (active ? "bg-white/10 border-white/30" : "bg-black/30 border-white/10 hover:border-white/20")
                    }
                    onClick={() => openJobForReview(jid)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm text-gray-100 truncate">{String(j?.title || jid)}</div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/15 bg-white/8 text-gray-200">
                        {st || "terminal"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        
                {/* PEAKOPS_REVIEW_EVIDENCE_GALLERY_V1 */}
        <section ref={evidenceSectionRef} className="rounded-2xl bg-white/5 border border-white/10 p-4" id="review-evidence">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Evidence</div>
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
              {process.env.NODE_ENV !== "production" ? (
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
              {process.env.NODE_ENV !== "production" ? (
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
                  router.push("/incidents/" + incidentId + "#evidence");
                }}
                title="Open the field incident page evidence rail"
              >
                Open full evidence
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
                return visibleEvidence.map((ev: any) => {
                  const id = String(ev?.id || ev?.evidenceId || "");
                  const media = getTileMedia(ev as any);
                  const u = media.mode === "image" ? buildThumbProxyUrl(media.ref, id) : "";
                  const name = String(getFileField(ev, "originalName") || id);
                  const labels = (ev?.labels || []).map((x: any) => String(x).toUpperCase());
                  const reason = String(thumbReasonById[id] || "").trim();

                  return (
                    <button
                      key={id || name}
                      type="button"
                      className={
                        "min-w-[148px] w-[148px] sm:min-w-[168px] sm:w-[168px] aspect-[4/3] relative rounded-xl overflow-hidden border " +
                        (selectedEvidenceId === id ? "border-blue-400/40 ring-2 ring-blue-500/20 " : "border-white/10 ") +
                        "bg-black/40 hover:border-white/25 hover:scale-[1.015] hover:bg-black/50 transition-all duration-150"
                      }
                      onClick={() => openEvidence(ev)}
                      title={name}
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
                        <div className="w-full h-full flex items-center justify-center text-xs text-gray-500 text-center px-2">
                          {media.mode === "placeholder" ? media.label : "Unavailable"}
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
                        {name || "evidence"}
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
            Click a tile to preview. Use “Open full evidence” for the full field page rail.
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
            {timeline.slice(0, 12).map((t) => (
              <div
                key={t.id}
                className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-100">
                    {String(t.type || "EVENT")}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    actor: {String(t.actor || "system")} {t.refId ? `• ref: ${t.refId}` : ""}
                  </div>
                </div>
                <div className="text-xs text-gray-500">{fmtAgo(t.occurredAt?._seconds)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

