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
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, logThumbEvent } from "@/lib/evidence/signedThumb";
import { authedFetch } from "@/lib/apiClient";
import {
  incidentStatusLabel,
  incidentStatusPill,
  normalizeIncidentStatusShared,
} from "@/lib/incidents/incidentStatus";
import RecordNav from "@/components/RecordNav";
import AppTopBar from "@/components/AppTopBar";

// PEAKOPS_REVIEW_OPERATIONAL_LANGUAGE_V1 (PR 51)
// Inline minimal translation helpers so Review reads as an
// operational record instead of a database dump. Mirrors the
// SummaryClient pattern (PEAKOPS_OPERATIONAL_LANGUAGE_V1) but
// without the member-registry lookup — Phase 1 uses event-type
// role fallbacks. A shared lib/operationalLanguage.ts would let
// both files import the same source; deferred until Review and
// Summary are aligned and the extract is fully mechanical.
function prettyTimelineEventReview(t?: string): string {
  const norm = String(t || "").trim().toLowerCase();
  const map: Record<string, string> = {
    incident_opened: "Incident opened",
    incident_closed: "Operational record closed",
    job_approved: "Supervisor approved job",
    job_rejected: "Supervisor rejected job",
    job_completed: "Job marked complete",
    field_submitted: "Field crew submitted completion package",
    field_arrived: "Field crew arrived",
    session_started: "Field session started",
    session_completed: "Field session completed",
    evidence_added: "Evidence captured and attached",
    notes_saved: "Supervisor notes updated",
    material_added: "Material logged",
    supervisor_request_update: "Supervisor requested update",
  };
  if (map[norm]) return map[norm];
  if (!t) return "Event";
  return String(t)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function actorFallbackForEvent(t?: string): string {
  const norm = String(t || "").trim().toLowerCase();
  if (
    norm.startsWith("field_") ||
    norm.startsWith("session_") ||
    norm === "evidence_added" ||
    norm === "material_added"
  )
    return "Field crew";
  if (
    norm.startsWith("job_") ||
    norm === "notes_saved" ||
    norm === "incident_closed" ||
    norm === "supervisor_request_update"
  )
    return "Supervisor";
  return "System";
}

// PEAKOPS_REVIEW_TRUST_STRIP_V1 (PR 52)
// Deterministic operational-trust signals. No AI, no probabilistic
// confidence score, no greenwashing — every state derives from pure
// data already loaded in ReviewClient. A signal that can't be
// verified surfaces a neutral "partial" or "unverified" state with
// factual detail copy, never a red flag.
type PelletState = "verified" | "partial" | "unverified";
type TrustPellet = {
  key: "evidence" | "sequence" | "identity" | "integrity";
  label: string;
  state: PelletState;
  detail: string;
};

type PelletTimeline = Array<{
  type?: string;
  actor?: string;
  occurredAt?: { _seconds?: number } | null;
}>;

type PelletJob = { id?: string; jobId?: string; status?: string; reviewStatus?: string; locked?: boolean };
type PelletEvidence = { jobId?: string | null; evidence?: { jobId?: string | null } | null };

function _normEvent(t?: string): string {
  return String(t || "").trim().toLowerCase();
}

function _isTerminalJob(j: PelletJob): boolean {
  // Mirrors the latestTerminalStatus derivation already in ReviewClient:
  // a job counts as "decided" when it's been approved, locked, or
  // rejected. Phase 2 only inspects closed incidents, so terminal-set
  // membership is the right unit for the Evidence pellet.
  const s = String(j.status || "").toLowerCase();
  const rs = String(j.reviewStatus || "").toLowerCase();
  if (j.locked) return true;
  return s === "approved" || s === "rejected" || rs === "approved" || rs === "rejected";
}

function _evidenceLinkedJobId(ev: PelletEvidence): string {
  return String(ev?.evidence?.jobId || ev?.jobId || "").trim();
}

function _minOccurredAtSec(timeline: PelletTimeline, typeKeys: string[]): number | undefined {
  const wanted = new Set(typeKeys.map((t) => t.toLowerCase()));
  let earliest: number | undefined;
  for (const t of timeline) {
    if (!wanted.has(_normEvent(t.type))) continue;
    const s = Number(t.occurredAt?._seconds || 0);
    if (s > 0 && (earliest === undefined || s < earliest)) earliest = s;
  }
  return earliest;
}

function pelletEvidence(jobs: PelletJob[], evidence: PelletEvidence[]): TrustPellet {
  const terminal = (jobs || []).filter(_isTerminalJob);
  if (terminal.length === 0) {
    return {
      key: "evidence",
      label: "Evidence",
      state: "unverified",
      detail: "No closed jobs to verify.",
    };
  }
  const linked = terminal.filter((j) => {
    const jid = String(j.id || j.jobId || "").trim();
    if (!jid) return false;
    return (evidence || []).some((ev) => _evidenceLinkedJobId(ev) === jid);
  });
  if (linked.length === terminal.length) {
    return {
      key: "evidence",
      label: "Evidence",
      state: "verified",
      detail: `${terminal.length} of ${terminal.length} ${terminal.length === 1 ? "job has" : "jobs have"} linked evidence.`,
    };
  }
  return {
    key: "evidence",
    label: "Evidence",
    state: "partial",
    detail: `${linked.length} of ${terminal.length} ${terminal.length === 1 ? "job has" : "jobs have"} linked evidence.`,
  };
}

function pelletSequence(timeline: PelletTimeline): TrustPellet {
  const earliestField = _minOccurredAtSec(timeline || [], [
    "field_arrived",
    "session_started",
    "field_submitted",
  ]);
  const earliestApproval = _minOccurredAtSec(timeline || [], [
    "job_approved",
    "incident_closed",
  ]);
  if (!earliestApproval) {
    return {
      key: "sequence",
      label: "Sequence",
      state: "unverified",
      detail: "No supervisor approval recorded yet.",
    };
  }
  if (!earliestField) {
    return {
      key: "sequence",
      label: "Sequence",
      state: "partial",
      detail: "Field activity not separately timestamped.",
    };
  }
  if (earliestApproval > earliestField) {
    return {
      key: "sequence",
      label: "Sequence",
      state: "verified",
      detail: "Field activity preceded supervisor approval.",
    };
  }
  return {
    key: "sequence",
    label: "Sequence",
    state: "partial",
    detail: "Field activity and approval timestamps overlap.",
  };
}

function pelletIdentity(timeline: PelletTimeline): TrustPellet {
  const decisive = (timeline || []).filter((t) => {
    const n = _normEvent(t.type);
    return n === "job_approved" || n === "incident_closed";
  });
  if (decisive.length === 0) {
    return {
      key: "identity",
      label: "Identity",
      state: "unverified",
      detail: "No supervisor decisions recorded.",
    };
  }
  const unattributed = decisive.filter((t) => !String(t.actor || "").trim());
  if (unattributed.length === 0) {
    return {
      key: "identity",
      label: "Identity",
      state: "verified",
      detail: `${decisive.length} ${decisive.length === 1 ? "decision" : "decisions"} attributed to a supervisor.`,
    };
  }
  return {
    key: "identity",
    label: "Identity",
    state: "partial",
    detail: `${decisive.length - unattributed.length} of ${decisive.length} decisions attributed.`,
  };
}

function pelletIntegrity(
  incident: IncidentDoc | null | undefined,
  timeline: PelletTimeline,
): TrustPellet {
  const closed = String(incident?.status || "").toLowerCase() === "closed";
  const closedEvent = (timeline || []).find((t) => _normEvent(t.type) === "incident_closed");
  const hash = String(incident?.packetMeta?.originalRecordHash || "").trim();
  if (closed && closedEvent && hash) {
    // Show the sha256 prefix — enough to be a meaningful fingerprint
    // for a supervisor cross-referencing the export, not enough to be
    // a security surface on its own.
    const fingerprint = hash.replace(/^sha256:/i, "").slice(0, 12);
    return {
      key: "integrity",
      label: "Integrity",
      state: "verified",
      detail: `Sealed packet hash ${fingerprint}…`,
    };
  }
  if (closed && closedEvent) {
    return {
      key: "integrity",
      label: "Integrity",
      state: "partial",
      detail: "Closed, but no exported packet hash yet.",
    };
  }
  return {
    key: "integrity",
    label: "Integrity",
    state: "unverified",
    detail: "Record not yet closed.",
  };
}

function rationaleSentence(
  pellets: { evidence: TrustPellet; sequence: TrustPellet; identity: TrustPellet },
  jobs: PelletJob[],
): string | null {
  const parts: string[] = [];

  if (pellets.evidence.state === "verified") {
    const n = (jobs || []).filter(_isTerminalJob).length;
    parts.push(`All ${n} ${n === 1 ? "job has" : "jobs have"} linked evidence`);
  } else if (pellets.evidence.state === "partial") {
    // Trim the trailing period from the pellet's detail for prose flow.
    parts.push(pellets.evidence.detail.replace(/\.$/, ""));
  }
  // unverified evidence → omit from rationale entirely

  if (pellets.identity.state === "verified") {
    parts.push("supervisor approval is logged");
  }

  if (pellets.sequence.state === "verified") {
    parts.push("the operational sequence is consistent");
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] + ".";
  if (parts.length === 2) return parts[0] + " and " + parts[1] + ".";
  return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1] + ".";
}






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
  locked?: boolean;
};

type IncidentDoc = {
  id?: string;
  // PEAKOPS_REVIEW_HEADER_FIELDS_V1 (PR 51)
  // Surface dossier fields needed by the Summary-style header. The
  // wire response already returns these; we just type them so we
  // don't have to cast on read.
  title?: string;
  status?: string;
  location?: string;
  createdAt?: { _seconds?: number };
  updatedAt?: { _seconds?: number };
  // PEAKOPS_REVIEW_TRUST_STRIP_V1 (PR 52)
  // packetMeta is read by the Integrity trust pellet to verify the
  // exported packet's deterministic originalRecordHash (PR 46). All
  // other Phase 2 trust signals derive from the existing
  // jobs / evidence / timeline state, which already loads.
  packetMeta?: {
    status?: string;
    exportedAt?: string;
    originalRecordHash?: string;
    topLevelHash?: string;
    supplementalAddendaHash?: string;
    packetVersion?: number;
    evidenceCount?: number;
    jobCount?: number;
  };
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
  const sp = useSearchParams();

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

  // PEAKOPS_REVIEW_ORG_FROM_URL_V1 (2026-05-15)
  // orgId comes from the URL's `?orgId=...` searchParam, mirroring
  // PR #16/#23/#25 for Notes/Incident/Summary. The previous
  // hardcode (`"riverbend-electric"`) caused every Cloud Function
  // call to be evaluated against the wrong org's membership doc —
  // server returned 401/403 and Review remained blocked. Empty
  // string when missing; the missing-org guard panel below renders
  // instead of the main UI in that case.
  const orgId = String(sp?.get("orgId") || "").trim();
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
    // PEAKOPS_REVIEW_MISSING_ORG_GUARD_V1 (2026-05-15)
    // Short-circuit when no orgId is in the URL. Mirrors the
    // IncidentClient guard in PR #24 and the Summary guard in
    // PR #25. Without this, refresh() would fire its fan-out
    // with empty orgId and surface 400 errors. The component
    // renders a safe missing-org panel below in that case.
    if (!orgId && !activeOrgId) {
      setLoading(false);
      return [];
    }
    setLoading(true);
    setErr("");
    setErrDiag(null);
    try {
      let requestOrgId = String(activeOrgId || orgId || "").trim();
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
  const canApproveNow = ready && hasReviewableJob && !selectedJobApproved;
  const missingItems = useMemo(() => {
    const out: string[] = [];
    if (noReviewablesApproved) return out;
    if (!hasReviewableJob) out.push("No jobs are waiting for your sign-off.");
    if (!selectedJobReadyState && !selectedJobApproved) out.push("Selected job isn't finished yet.");
    if (selectedJobEvidenceCount < 1) out.push("Selected job has no proof attached yet.");
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


  // PEAKOPS_REVIEW_MISSING_ORG_GUARD_V1 (2026-05-15)
  // Safe missing-org panel. Renders instead of the main UI when
  // the URL has no `?orgId=...` query param. The mirror guard in
  // refresh() above prevents any /api/fn/* network calls from
  // firing while this panel is shown.
  if (!orgId && !activeOrgId) {
    return (
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="p-6">
          <div className="max-w-2xl mx-auto rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5">
            <div className="text-sm text-amber-100 font-semibold">Review unavailable</div>
            <div className="mt-2 text-sm text-amber-50/90">
              The supervisor review page needs an <code className="px-1 py-0.5 rounded bg-white/10">orgId</code> in the URL to load.
            </div>
            <div className="mt-3 text-xs text-amber-100/80">
              Open this review from the Incident page, or include{" "}
              <code className="px-1 py-0.5 rounded bg-white/10">?orgId=&lt;your-org-id&gt;</code> in the URL.
            </div>
          </div>
        </div>
      </main>
    );
  }

  // PEAKOPS_REVIEW_CLOSED_STATE_V1 (PR 51)
  // Canonical closed-state predicate. Mirrors the rest of the app's
  // status pipeline (lib/incidents/incidentStatus) — the only true
  // "review is finished" signal is incident.status === "closed".
  const incidentStatusNormalized = normalizeIncidentStatusShared(
    incidentDoc?.status,
  );
  const isIncidentClosed = incidentStatusNormalized === "closed";

  // Last activity = max(incident.updatedAt, latest timeline event).
  // Same pattern Summary uses for the masthead meta line.
  const lastActivitySec = (() => {
    const updatedSec = Number(incidentDoc?.updatedAt?._seconds || 0);
    const latestEventSec = Number(timeline[0]?.occurredAt?._seconds || 0);
    return Math.max(updatedSec, latestEventSec);
  })();

  // PEAKOPS_REVIEW_TRUST_STRIP_V1 (PR 52)
  // Compute the four deterministic trust pellets + the rationale
  // sentence the closed-state banner reads from. All four signals
  // are pure data; no AI, no fake confidence score. A signal that
  // can't be verified surfaces a neutral "partial"/"unverified"
  // state rather than a red flag — see the helper definitions at
  // module scope for the exact derivation rules.
  const trustPellets = useMemo(() => {
    const ev = pelletEvidence(jobs as any, evidence as any);
    const seq = pelletSequence(timeline as any);
    const id = pelletIdentity(timeline as any);
    const intg = pelletIntegrity(incidentDoc, timeline as any);
    return { evidence: ev, sequence: seq, identity: id, integrity: intg };
  }, [jobs, evidence, timeline, incidentDoc]);

  const closedRationale = useMemo(
    () =>
      rationaleSentence(
        {
          evidence: trustPellets.evidence,
          sequence: trustPellets.sequence,
          identity: trustPellets.identity,
        },
        jobs as any,
      ),
    [trustPellets, jobs],
  );

  // Hero preview selection. Reuses the existing selectedEvidenceId
  // state from Phase 1 so a click in the hero's secondary strip
  // updates the same selection the modal-open path reads. Default
  // hero piece = the most recently-stored evidence with a renderable
  // image; falls back to first in the list.
  const heroEvidence = useMemo(() => {
    if (!evidence || evidence.length === 0) return null;
    if (selectedEvidenceId) {
      const found = evidence.find(
        (ev: any) => String(ev?.id || ev?.evidenceId || "") === selectedEvidenceId,
      );
      if (found) return found;
    }
    return evidence[0];
  }, [evidence, selectedEvidenceId]);

  // Pull the EVIDENCE_ADDED timeline event for the hero piece so we
  // can surface "captured by" + GPS provenance. Both fields are
  // optional on the wire — render only if populated.
  const heroProvenance = useMemo(() => {
    const id = String((heroEvidence as any)?.id || "");
    if (!id) return null;
    const ev = (timeline || []).find(
      (t: any) =>
        _normEvent(t.type) === "evidence_added" && String(t.refId || "") === id,
    );
    if (!ev) return null;
    const actorRaw = String(ev.actor || "").trim();
    const sessionIdRaw = String(ev.sessionId || "").trim();
    const meta = (ev as any).meta || {};
    const gps = meta.gps && typeof meta.gps === "object" ? meta.gps : null;
    const lat = gps && Number.isFinite(Number(gps.lat)) ? Number(gps.lat) : null;
    const lon = gps && Number.isFinite(Number(gps.lon)) ? Number(gps.lon) : null;
    return {
      actorLabel:
        actorRaw === "field" || actorRaw === "field_crew"
          ? "Field crew"
          : actorRaw === "supervisor"
          ? "Supervisor"
          : actorFallbackForEvent("evidence_added"),
      sessionId: sessionIdRaw || null,
      gpsLat: lat,
      gpsLon: lon,
      occurredAtSec: Number(ev.occurredAt?._seconds || 0) || null,
    };
  }, [heroEvidence, timeline]);

  // PEAKOPS_REVIEW_HERO_SIGNED_URL_V1
  // Direct-signed-URL state map for the Evidence Hero panel.
  // Pre-fix: the hero used buildThumbProxyUrl(...) which routes through
  // /api/media, which proxies through a hardcoded localhost
  // FIREBASE_STORAGE_EMULATOR_HOST in production → 500
  // "fetch failed" → image renders as a black box. Summary works
  // because it uses mintEvidenceReadUrl → direct GCS V4 signed URL.
  // Post-fix: Review's hero mints the same direct signed URL via the
  // already-shipping getEvidenceReadUrl helper (the same path
  // openEvidence uses for the modal, verified working). The image
  // bytes come straight from GCS — no /api/media proxy in the
  // hot path. DAMAGE chip, provenance strip, Open-full-evidence
  // navigation all unchanged.
  const [heroSignedUrlByKey, setHeroSignedUrlByKey] = useState<Record<string, string>>({});
  const [heroSignedUrlErrByKey, setHeroSignedUrlErrByKey] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    if (!isIncidentClosed) return; // hero only renders on closed incidents
    if (!evidence || evidence.length === 0) return;

    async function mintForItem(ev: any) {
      const id = String(ev?.id || ev?.evidenceId || "");
      if (!id) return;
      // Skip if already minted for this id.
      if (heroSignedUrlByKey[id]) return;
      const media = getTileMedia(ev);
      if (media.mode !== "image") return;
      try {
        const url = await getEvidenceReadUrl(
          media.ref.bucket,
          media.ref.storagePath,
          900,
        );
        if (cancelled) return;
        setHeroSignedUrlByKey((m) => ({ ...m, [id]: String(url) }));
        setHeroSignedUrlErrByKey((m) => {
          if (!m[id]) return m;
          const n = { ...m };
          delete n[id];
          return n;
        });
      } catch (e: any) {
        if (cancelled) return;
        setHeroSignedUrlErrByKey((m) => ({
          ...m,
          [id]: String(e?.message || e || "mint_failed"),
        }));
      }
    }

    // Mint for the hero piece first, then the secondary strip.
    (async () => {
      if (heroEvidence) await mintForItem(heroEvidence);
      if (evidence.length > 1) {
        for (const ev of evidence) {
          if (cancelled) return;
          await mintForItem(ev);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isIncidentClosed, evidence, heroEvidence]);

  return (
    <main className="min-h-screen bg-black text-white">
      <AppTopBar />
      {/* PEAKOPS_REVIEW_HEADER_SHELL_V1 (PR 51)
          Sticky top bar realigned to the Summary dossier voice. Eyebrow
          names the surface ("INCIDENT RECORD · {org} · SUPERVISOR
          REVIEW"); title prefers incident.title and falls back to the
          raw incidentId only when no title exists. Location surfaces
          directly under the title when present. Meta line carries the
          status chip + job count + evidence count + last activity.
          Download Packet removed from the header — the Summary CTA
          remains the export gateway. */}
      <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-4">
        <div className="max-w-3xl mx-auto flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            {/* PEAKOPS_FRAMING_LAYER_V1 (PR 71) — eyebrow word swap.
                "Incident Record" → "Field Record" and
                "Supervisor Review" → "Pending Approval".
                Routes, RecordNav labels, and status pipeline unchanged. */}
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
              Field Record
              {orgId ? ` · ${orgId}` : ""}
              <span className="text-amber-200/30"> · </span>
              Pending Approval
            </div>
            <h1 className="text-xl sm:text-2xl font-semibold leading-tight tracking-tight text-white truncate">
              {incidentDoc?.title || incidentId}
            </h1>
            {incidentDoc?.location ? (
              <div className="text-[12px] text-gray-300 truncate">
                {incidentDoc.location}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-400">
              {incidentDoc?.status ? (
                <span
                  className={
                    "text-[11px] px-2 py-0.5 rounded-full border " +
                    incidentStatusPill(incidentDoc.status)
                  }
                >
                  {incidentStatusLabel(incidentDoc.status)}
                </span>
              ) : null}
              <span className="text-white/20">·</span>
              <span>{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</span>
              <span className="text-white/20">·</span>
              <span>
                {evidence.length}{" "}
                {evidence.length === 1 ? "piece of evidence" : "pieces of evidence"}
              </span>
              {lastActivitySec > 0 ? (
                <>
                  <span className="text-white/20">·</span>
                  <span>last activity {fmtAgo(lastActivitySec)}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() =>
                router.push(
                  `/incidents/${incidentId}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
                )
              }
            >
              ← Back to Incident
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-blue-600/20 border border-blue-400/20 text-blue-100 hover:bg-blue-600/25 text-sm"
              onClick={() => {
                const o = String(sp?.get("orgId") || "").trim();
                const qs = o ? `?orgId=${encodeURIComponent(o)}` : "";
                router.push(`/incidents/${incidentId}/notes${qs}`);
              }}
            >
              📝 Notes
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() =>
                router.push(
                  `/incidents/${incidentId}/summary${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
                )
              }
            >
              Summary
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-4 space-y-4">
        {/* PEAKOPS_RECORD_NAV_V1 */}
        <RecordNav
          incidentId={String(incidentId || "")}
          orgId={orgId}
          current="review"
          isSealed={isIncidentClosed}
        />
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
        {/* PEAKOPS_REVIEW_CLOSED_BANNER_V1 (PR 51)
            When the incident is closed, the active-review controls
            (Decision, Request Update, Readiness, Jobs Review) are
            hidden and replaced with a calm finish-state banner.
            Timeline + Evidence remain visible — they're informational
            records of what already happened, not actions to take. */}
        {isIncidentClosed ? (
          <section className="rounded-2xl bg-emerald-500/[0.04] border border-emerald-300/20 px-5 py-6 sm:px-7 sm:py-7">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-emerald-200/70">
              Review complete
            </div>
            <div className="mt-2 text-[15px] sm:text-base text-emerald-50/90 leading-snug">
              Operational record closed after supervisor approval.
            </div>

            {/* PEAKOPS_REVIEW_TRUST_STRIP_V1 (PR 52)
                One-sentence command-confidence rationale assembled
                from the same deterministic checks the trust pellets
                read from. Sentence is omitted entirely when no
                clauses verify, so we never display empty filler. */}
            {closedRationale ? (
              <div className="mt-2 text-[13px] text-emerald-50/75 leading-snug">
                {closedRationale}
              </div>
            ) : null}

            {/* PEAKOPS_REVIEW_TRUST_PELLETS_V1 (PR 52)
                Four operational-trust pellets — Evidence, Sequence,
                Identity, Integrity. State derives purely from
                already-loaded data. "verified" wears a soft green
                check; "partial" / "unverified" wear neutral gray
                dots so the absence of a signal never reads as red.
                Detail copy lives in the title attribute for hover —
                no probabilistic scores, no greenwashing. */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {[
                trustPellets.evidence,
                trustPellets.sequence,
                trustPellets.identity,
                trustPellets.integrity,
              ].map((p) => {
                const verified = p.state === "verified";
                return (
                  <span
                    key={p.key}
                    title={p.detail}
                    className={
                      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] " +
                      (verified
                        ? "bg-emerald-500/12 border-emerald-300/35 text-emerald-50"
                        : "bg-white/[0.04] border-white/15 text-gray-300/85")
                    }
                  >
                    <span
                      className={
                        "inline-block w-[14px] text-center font-semibold leading-none " +
                        (verified ? "text-emerald-200" : "text-gray-500")
                      }
                      aria-hidden
                    >
                      {verified ? "✓" : "·"}
                    </span>
                    <span>{p.label}</span>
                  </span>
                );
              })}
            </div>

            <div className="mt-5">
              <button
                type="button"
                className="px-4 py-2 rounded-xl bg-emerald-500/15 border border-emerald-300/30 text-emerald-50 hover:bg-emerald-500/25 text-sm font-medium"
                onClick={() =>
                  router.push(
                    `/incidents/${incidentId}/summary${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
                  )
                }
              >
                View Summary
              </button>
            </div>
          </section>
        ) : null}

        {/* PEAKOPS_REVIEW_EVIDENCE_HERO_V1 (PR 52)
            Closed-state Evidence Hero. Promotes the evidence section
            from a horizontal thumbnail strip (Phase 1) to a hero
            panel: large preview of one piece + a secondary strip for
            the rest + a provenance line surfacing the recorded
            captured-by actor, session, and (when present) GPS from
            the evidence_added timeline event meta. Pipeline is the
            same as Phase 1 — getTileMedia → buildThumbProxyUrl for
            thumbs, openEvidence for the full-size modal click. PR 29
            SignatureDoesNotMatch fix lives in that path; no changes. */}
        {isIncidentClosed && heroEvidence ? (
          <section className="rounded-2xl bg-white/5 border border-white/10 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">
                  Evidence
                </div>
                <div className="text-xs text-gray-500">
                  {evidence.length === 1
                    ? "1 piece captured · reviewed"
                    : `${evidence.length} pieces captured · reviewed`}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg bg-white/6 border border-white/10 hover:bg-white/10 text-[12px] text-gray-200"
                  onClick={() => {
                    if (!incidentId) return;
                    router.push(
                      "/incidents/" +
                        incidentId +
                        (orgId ? "?orgId=" + encodeURIComponent(orgId) : "") +
                        "#evidence",
                    );
                  }}
                >
                  Open full evidence
                </button>
              </div>
            </div>

            {/* Hero preview tile */}
            <div className="mt-4">
              {(() => {
                const ev: any = heroEvidence;
                const id = String(ev?.id || ev?.evidenceId || "");
                const media = getTileMedia(ev);
                // PEAKOPS_REVIEW_HERO_SIGNED_URL_V1
                // Direct GCS V4 signed URL minted by the effect above
                // via getEvidenceReadUrl. Same pattern Summary uses.
                // No /api/media proxy in the hot path → no localhost
                // emulator URL → image renders correctly in prod.
                const u =
                  media.mode === "image"
                    ? String(heroSignedUrlByKey[id] || "")
                    : "";
                const isMinting =
                  media.mode === "image" && !u && !heroSignedUrlErrByKey[id];
                const mintErr =
                  media.mode === "image" ? heroSignedUrlErrByKey[id] || "" : "";
                const name = String(getFileField(ev, "originalName") || id);
                const labels = (ev?.labels || []).map((x: any) => String(x).toUpperCase());
                return (
                  <button
                    type="button"
                    className="relative w-full aspect-[16/10] sm:aspect-[16/9] rounded-xl overflow-hidden border border-white/10 bg-black/40 hover:border-white/25 hover:bg-black/50 transition-all"
                    onClick={() => openEvidence(ev)}
                    title={name}
                  >
                    {u ? (
                      <img
                        src={u}
                        className="w-full h-full object-contain"
                        loading="lazy"
                      />
                    ) : isMinting ? (
                      <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">
                        Preparing preview…
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">
                        {mintErr
                          ? "Preview unavailable"
                          : media.mode === "placeholder"
                          ? media.label
                          : "Unavailable"}
                      </div>
                    )}

                    {labels.length ? (
                      <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
                        {labels.slice(0, 3).map((l: string) => (
                          <span
                            key={l}
                            className="text-[11px] px-2 py-0.5 rounded-full bg-black/55 border border-white/20 text-gray-50 backdrop-blur"
                          >
                            {l}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="absolute bottom-3 left-3 right-3 text-[12px] text-gray-100 bg-black/55 px-3 py-1.5 rounded-md truncate">
                      {name || "evidence"}
                    </div>
                  </button>
                );
              })()}
            </div>

            {/* Secondary strip — only when >1 evidence */}
            {evidence.length > 1 ? (
              <div className="mt-3 -mx-1 px-1 overflow-x-auto">
                <div className="flex gap-2">
                  {evidence.map((ev: any) => {
                    const id = String(ev?.id || ev?.evidenceId || "");
                    const isHero =
                      id === String((heroEvidence as any)?.id || "");
                    const media = getTileMedia(ev);
                    // PEAKOPS_REVIEW_HERO_SIGNED_URL_V1
                    // Same signed-URL state map the hero preview reads;
                    // secondary thumbnails get minted by the same effect.
                    const u =
                      media.mode === "image"
                        ? String(heroSignedUrlByKey[id] || "")
                        : "";
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedEvidenceId(id)}
                        className={
                          "min-w-[88px] w-[88px] aspect-square rounded-lg overflow-hidden border " +
                          (isHero
                            ? "border-emerald-300/50 ring-2 ring-emerald-400/20 "
                            : "border-white/10 hover:border-white/25 ") +
                          "bg-black/40 transition-all"
                        }
                      >
                        {u ? (
                          <img src={u} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-500 px-1 text-center">
                            {media.mode === "placeholder" ? media.label : "—"}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Provenance strip — only renders rows that have data */}
            {(() => {
              const ev: any = heroEvidence;
              const storedSec = Number(
                ev?.storedAt?._seconds || ev?.createdAt?._seconds || 0,
              );
              const rows: React.ReactNode[] = [];
              if (heroProvenance?.actorLabel) {
                rows.push(
                  <span key="actor">
                    Captured by {heroProvenance.actorLabel}
                  </span>,
                );
              }
              if (storedSec > 0) {
                rows.push(<span key="stored">Stored {fmtAgo(storedSec)}</span>);
              }
              if (heroProvenance?.sessionId) {
                rows.push(
                  <span key="session" className="font-mono text-[11px]">
                    Session {heroProvenance.sessionId.slice(0, 12)}
                  </span>,
                );
              }
              if (heroProvenance?.gpsLat !== null && heroProvenance?.gpsLon !== null) {
                rows.push(
                  <span key="gps">
                    GPS {heroProvenance!.gpsLat!.toFixed(3)}°,{" "}
                    {heroProvenance!.gpsLon!.toFixed(3)}°
                  </span>,
                );
              }
              if (rows.length === 0) return null;
              return (
                <div className="mt-4 pt-3 border-t border-white/[0.06]">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-gray-500 mb-1.5">
                    Provenance
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-300">
                    {rows.map((r, i) => (
                      <span key={i} className="flex items-center gap-3">
                        {r}
                        {i < rows.length - 1 ? (
                          <span className="text-white/20">·</span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </section>
        ) : null}

        {!isIncidentClosed ? (
        <>
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
              {queuePositionLabel === "Not in queue" ? null : (
                <div className="text-xs text-gray-500 mt-1">{queueRemaining} remaining after this</div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm disabled:opacity-50"
                disabled={!prevIncident}
                onClick={() => {
                  if (!prevIncident?.incidentId) return;
                  router.push(`/incidents/${encodeURIComponent(String(prevIncident.incidentId))}/review${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`);
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
                  router.push(`/incidents/${encodeURIComponent(String(nextIncident.incidentId))}/review${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`);
                }}
              >
                Next →
              </button>
            </div>
          </div>
        </div>

              <div className="text-sm text-gray-200">
                {hasReviewableJob
                  ? (noReviewablesApproved
                      ? "No reviewable jobs. Latest decision: approved."
                      : canApproveNow
                        ? "Ready to approve."
                        : "Not ready yet — pick a finished job with proof attached.")
                  : "Nothing is waiting for your review."}
              </div>
              {err && canDevLog ? <div className="text-xs text-red-300 mt-1 truncate">Error: {err}</div> : null}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {hasReviewableJob ? (
                <>
                  <button
                    className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10 disabled:opacity-50"
                    onClick={sendBack}
                    disabled={loading}
                    title="Send back to field with reasons"
                  >
                    ↩︎ Send Back
                  </button>

                  <div className="flex flex-col items-start">
                    <button
                      className={
                        "px-3 py-2 rounded-xl text-sm font-semibold border " +
                        (canApproveNow
                          ? "bg-green-700/25 border-green-400/25 text-green-200 hover:bg-green-700/35"
                          : "bg-white/5 border-white/10 text-gray-500")
                      }
                      onClick={async () => {
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
                          if (!jid) {
                            const msg = "Select a job first.";
                            setErr(msg);
                            toast(msg, 2200);
                            console.error("[Approve&Lock] missing selected jobId");
                            return;
                          }
                          await approveAndLockJob(String(orgId || ""), String(incidentId || ""), jid);
                          await refreshAfterMutation((rows) => {
                            const j = (rows || []).find((x: any) => String(x?.id || x?.jobId || "") === String(jid || ""));
                            const st = String(j?.status || "").toLowerCase();
                            const rs = String(j?.reviewStatus || "").toLowerCase();
                            return st === "approved" || rs === "approved" || !!j?.locked;
                          });
                          toast("Selected job approved + locked ✓", 1800);
                        } catch (e: any) {
                          const msg = String(e?.message || e || "approve_and_lock_failed");
                          setErr(msg);
                          toast("Approve & Lock failed: " + msg, 3200);
                          console.error(e);
                        }
                      }}
                      disabled={!canApproveNow || loading}
                      title={canApproveNow ? "Approve and lock selected job" : "Not ready yet"}
                    >
                      🛡 Approve & Lock Selected Job
                    </button>
                    <div className="mt-1 text-[11px] text-gray-500">Applies to selected job only.</div>
                  </div>
                </>
              ) : (
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-500/15 border border-emerald-300/30 text-emerald-50 hover:bg-emerald-500/25 text-sm font-medium"
                  onClick={() =>
                    router.push(
                      `/incidents/${incidentId}/summary${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
                    )
                  }
                >
                  View Summary
                </button>
              )}
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
              onClick={() => {
                try {
                  const target = (visibleEvidence || [])[0];
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
                  setReqOpen(false);
                  void openEvidence(target);
                } catch (e: any) {
                  const msg = String(e?.message || e || "view_evidence_failed");
                  toast("View evidence failed: " + msg, 2600);
                  if (process.env.NODE_ENV !== "production") {
                    console.warn("[review-view-evidence] failed", e);
                  }
                }
              }}
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
                  if (incidentId) router.push("/incidents/" + incidentId + "?hi=request_update" + (orgId ? "&orgId=" + encodeURIComponent(orgId) : ""));
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
        <section className={"rounded-2xl border p-4 " + (canApproveNow ? "bg-green-700/15 border-green-400/20" : "bg-white/5 border-white/10")}>
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
          <div className="mt-1 text-xs text-gray-500">
            Incident close still requires all jobs approved.
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
                Jobs ready to review: {reviewableJobs.length}
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
        </>
        ) : null}

                {/* PEAKOPS_REVIEW_EVIDENCE_GALLERY_V1
                    PEAKOPS_REVIEW_EVIDENCE_HERO_V1 (PR 52) — the
                    horizontal-strip gallery is hidden in closed state.
                    The Evidence Hero panel above takes its place. */}
        {!isIncidentClosed ? (
        <section ref={evidenceSectionRef} className="rounded-2xl bg-white/5 border border-white/10 p-4" id="review-evidence">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Evidence</div>
              <div className="text-xs text-gray-500">
                {/* PEAKOPS_REVIEW_EVIDENCE_COPY_V1 (PR 51) — operational
                    voice instead of debug-ish "captured • showing X". */}
                {evidenceN === 0
                  ? "No evidence captured yet"
                  : `${evidenceN} ${evidenceN === 1 ? "piece" : "pieces"} captured`}
                {evidenceFilterJobId
                  ? ` · filtered to ${visibleEvidence.length}`
                  : visibleEvidence.length < evidenceN
                  ? ` · showing latest ${visibleEvidence.length}`
                  : evidenceN > 0
                  ? " · evidence reviewed"
                  : ""}
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
                  router.push("/incidents/" + incidentId + (orgId ? "?orgId=" + encodeURIComponent(orgId) : "") + "#evidence");
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
                        // PEAKOPS_REVIEW_EVIDENCE_CARD_SIZE_V1 (PR 51)
                        // Bumped from 148/168 → 200/220 so evidence
                        // doesn't read as a debug thumbnail strip.
                        // No change to signed-URL plumbing (PR 29
                        // SignatureDoesNotMatch fix lives there).
                        "min-w-[200px] w-[200px] sm:min-w-[220px] sm:w-[220px] aspect-[4/3] relative rounded-xl overflow-hidden border " +
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
        ) : null}


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

          {/* PEAKOPS_REVIEW_TIMELINE_HUMANIZED_V1 (PR 51)
              Default visible timeline reads as operational language —
              no raw enum types, no raw 28-char UIDs. The underlying
              event type is preserved on the row's `title` attribute
              so a power user can hover for the lookup. A click-to-
              expand technical-details disclosure is reserved for a
              later phase. */}
          <div className="mt-3 space-y-2">
            {timeline.slice(0, 12).map((t) => {
              const rawType = String(t.type || "");
              const human = prettyTimelineEventReview(rawType);
              const actorLabel = actorFallbackForEvent(rawType);
              const hoverDetails = [
                rawType ? `event: ${rawType}` : null,
                t.refId ? `ref: ${t.refId}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div
                  key={t.id}
                  className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 flex items-center justify-between gap-3"
                  title={hoverDetails || undefined}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-100 truncate">
                      {human}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {actorLabel}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 shrink-0">
                    {fmtAgo(t.occurredAt?._seconds)}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
