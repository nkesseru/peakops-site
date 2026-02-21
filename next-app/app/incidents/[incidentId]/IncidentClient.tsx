"use client";

import { useEffect, useMemo, useState } from "react";
import { outboxFlushSupervisorRequests } from "@/lib/offlineOutbox";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import AddEvidenceButton from "@/components/evidence/AddEvidenceButton";
import FilingCountdown from "@/components/incident/FilingCountdown";
import NextBestAction from "@/components/incident/NextBestAction";
import TimelinePanel from "@/components/incident/TimelinePanel";
import { getFunctionsBase } from "@/lib/functionsBase";
import { deriveDerivativePaths } from "@/lib/evidence/deriveDerivativePaths";

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
  title?: string;
  status?: JobStatus | string;
  assignedTo?: string | null;
  notes?: string | null;
  createdAt?: { _seconds: number };
  updatedAt?: { _seconds: number };
};

const JOB_STATUSES: JobStatus[] = ["open", "in_progress", "complete", "review", "approved", "rejected"];

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
  const derived = deriveDerivativePaths({
    storagePath: originalPath,
    originalName: String(f?.originalName || ""),
  });
  const previewPath =
    String(f?.previewPath || f?.derivatives?.preview?.storagePath || "").trim();
  const thumbPath =
    String(f?.thumbPath || f?.derivatives?.thumb?.storagePath || "").trim();
  const heic = isHeicEvidence(ev);
  if (heic) {
    return {
      thumbPath: thumbPath || previewPath || derived.thumbPath || "",
      previewPath: previewPath || thumbPath || derived.previewPath || "",
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
  if (status === "ready" || status === "source_missing" || status === "failed") return false;
  const hasPreview = !!String(f?.previewPath || "").trim();
  const hasThumb = !!String(f?.thumbPath || "").trim();
  if (hasThumb || hasPreview) return false;
  return status === "pending";
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

export default function IncidentClient({ incidentId }: { incidentId: string }) {
  const functionsBase = getFunctionsBase();

  useEffect(() => {
    try {
      localStorage.setItem("peakops_last_incident_id", String(incidentId || "").trim());
    } catch {}
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

  const goAddEvidence = async () => {
    // PEAKOPS_EVIDENCE_GO_V2: ensure session exists, then go to add-evidence
    try {
      if (String(incidentStatus).toLowerCase() === "closed") {
        toast("Incident is closed (read-only).", 2600);
        return;
      }
      if (!String(currentJobId || "").trim()) {
        toast("Select My job first before uploading evidence.", 2600);
        return;
      }
      setAddingEvidence(true);

      // If we already have a session, just go.
      let sid = String(activeSessionId || "").trim();
      if (!sid) {
        // Create session via Functions (emulator/prod depending on NEXT_PUBLIC_FUNCTIONS_BASE)
        const base = functionsBase;
        if (!base) throw new Error("Missing NEXT_PUBLIC_FUNCTIONS_BASE");

        const techUserId = (process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web").trim();

        const res = await fetch(`${base}/startFieldSessionV1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId: orgId, incidentId, createdBy: "ui", techUserId }),
        });

        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out?.ok || !out?.sessionId) {
          throw new Error(out?.error || `Could not start field session (${res.status})`);
        }

        sid = String(out.sessionId || "").trim();
        if (!sid) throw new Error("startFieldSessionV1 returned no sessionId");

        try { localStorage.setItem("peakops_active_session_" + String(incidentId || ""), sid); } catch {}
        try { setActiveSessionId(sid); } catch {}
      }

      router.push(`/incidents/${incidentId}/add-evidence?sid=${encodeURIComponent(sid)}&jobId=${encodeURIComponent(String(currentJobId || "").trim())}`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      try { toast("Add evidence failed: " + msg, 3500); } catch {}
      console.error(e);
    } finally {
      try { setAddingEvidence(false); } catch {}
    }
};


  // V6_SESSION_HELPERS__WIRE
async function markArrived() {
    // PEAKOPS_ARRIVE_RETRY_SESSION_V1
    // If sessionId is missing or stale, create a new field session and retry once.
    const techUserId = process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web";
    const base = functionsBase;
    const org = (typeof orgId !== "undefined" && orgId) ? String(orgId) : "spokane-valley";

    if (!base) return toast("Missing NEXT_PUBLIC_FUNCTIONS_BASE", 3000);
    if (String(incidentStatus).toLowerCase() === "closed") return toast("Incident is closed (read-only).", 2600);

    let sid = String(activeSessionId || "").trim();
    if (!sid) {
      // try last known session from storage (if any)
      try { sid = String(localStorage.getItem("peakops_active_session_" + String(incidentId || "")) || "").trim(); } catch {}
    }

    async function startSession(): Promise<string> {
      const res = await fetch(`${base}/startFieldSessionV1`, {
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
      const res = await fetch(`${base}/markArrivedV1`, {
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

    try {
      setArriving(true);

      // Optimistic UI event id (stable across try/catch)
      let __optId = "opt_arrived_" + Date.now();
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
    if (String(incidentStatus).toLowerCase() === "closed") return toast("Incident is closed (read-only).", 2600);
    const sid = String(activeSessionId || "").trim();
    if (!sid) return toast("No active session yet — add evidence first.", 3000);
    const ok = window.confirm("Submit this session? This locks the field visit for supervisor review.");
    if (!ok) return;
    try {
      setSubmitting(true);
      const out: any = await postJson(functionsBase + "/submitFieldSessionV1", { orgId: orgId,
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
  const orgId = "riverbend-electric";
  // Evidence + Timeline
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [jobsBusy, setJobsBusy] = useState(false);
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const [jobAssignedTo, setJobAssignedTo] = useState("");
  const [jobNotes, setJobNotes] = useState("");
  const [currentJobId, setCurrentJobId] = useState("");
  const currentJobStorageKey = `peakops_current_job_${String(incidentId || "").trim()}`;

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
      const out: any = await postJson(`${functionsBase}/markArrivedV1`, { orgId: orgId,
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
      const out: any = await postJson(`${functionsBase}/submitFieldSessionV1`, { orgId: orgId,
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

  // Thumbnails (evidenceId -> signed url)
  const [thumbUrl, setThumbUrl] = useState<Record<string, string>>({});

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

  // NOTE: match your actual bucket (this is the one you configured CORS for)
  const evidenceBucket = "peakops-evidence-peakops-pilot-20251028065848";

  const isClosed = String(incidentStatus || "").toLowerCase() === "closed";

  async function closeIncident() {
    if (isClosed) {
      toast("Incident already closed.", 1800);
      return;
    }
    const ok = window.confirm("Close this incident? This sets read-only mode.");
    if (!ok) return;
    try {
      setClosingIncident(true);
      const res = await fetch("/api/fn/closeIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, incidentId, closedBy: "field_ui" }),
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
    try {
      setJobsBusy(true);
      const out: any = await postJson(`${functionsBase}/createJobV1`, {
        orgId,
        incidentId,
        title,
        assignedTo: String(jobAssignedTo || "").trim(),
        notes: String(jobNotes || "").trim(),
      });
      if (!out?.ok) throw new Error(out?.error || "createJobV1 failed");
      setShowCreateJob(false);
      setJobTitle("");
      setJobAssignedTo("");
      setJobNotes("");
      await refresh();
      toast("Job created ✓", 1800);
    } catch (e: any) {
      toast("Create job failed: " + String(e?.message || e), 3200);
    } finally {
      setJobsBusy(false);
    }
  }

  async function setJobStatus(jobId: string, status: JobStatus) {
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
    try {
      setJobsBusy(true);
      const out: any = await postJson(`${functionsBase}/updateJobStatusV1`, {
        orgId,
        incidentId,
        jobId,
        status,
      });
      if (!out?.ok) throw new Error(out?.error || "updateJobStatusV1 failed");
      await refresh();
      toast("Job status updated ✓", 1500);
    } catch (e: any) {
      toast("Update status failed: " + String(e?.message || e), 3000);
    } finally {
      setJobsBusy(false);
    }
  }

  async function markCurrentJobComplete() {
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
    const jid = String(currentJobId || "").trim();
    if (!jid) return toast("Select My job first.", 2200);
    const ok = window.confirm("Mark current job complete?");
    if (!ok) return;
    await setJobStatus(jid, "complete");
  }

  async function assignEvidenceJob(evidenceId: string, jobIdRaw: string) {
    if (isClosed) return toast("Incident is closed (read-only).", 2600);
    try {
      setJobsBusy(true);
      const out: any = await postJson(`${functionsBase}/assignEvidenceToJobV1`, {
        orgId,
        incidentId,
        evidenceId,
        jobId: String(jobIdRaw || "").trim() || null,
      });
      if (!out?.ok) throw new Error(out?.error || "assignEvidenceToJobV1 failed");
      await refresh();
      toast("Evidence job assignment updated ✓", 1600);
    } catch (e: any) {
      toast("Assign evidence failed: " + String(e?.message || e), 3200);
    } finally {
      setJobsBusy(false);
    }
  }

  async function refresh() {
    if (!functionsBase) return;
    setLoading(true);

    try {
      const incUrl =
        `${functionsBase}/getIncidentV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const incRes = await fetch(incUrl);
      const incBody = await incRes.text();
      if (incRes.ok) {
        const inc = incBody ? JSON.parse(incBody) : {};
        const st = String(inc?.doc?.status || "open").toLowerCase();
        setIncidentStatus(st || "open");
      }

      const jobsUrl =
        `${functionsBase}/listJobsV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
      const jobsRes = await fetch(jobsUrl);
      const jobsBody = await jobsRes.text();
      if (jobsRes.ok) {
        const jb = jobsBody ? JSON.parse(jobsBody) : {};
        if (jb?.ok && Array.isArray(jb.docs)) {
          const docs = jb.docs;
          setJobs(docs);
          const currentId = String(currentJobId || "").trim();
          const exists = docs.some((j: any) => String(j?.id || j?.jobId || "") === currentId);
          const firstJobId = String(docs?.[0]?.id || docs?.[0]?.jobId || "").trim();
          let effectiveJobId = currentId;
          if (!currentId || !exists) {
            if (firstJobId) {
              setCurrentJobId(firstJobId);
              effectiveJobId = firstJobId;
            }
          }
          if (process.env.NODE_ENV !== "production") {
            console.debug("[jobs-refresh]", {
              jobsCount: docs.length,
              currentJobId: effectiveJobId || "",
              firstJobId: firstJobId || "",
            });
          }
        }
      }

      // Evidence (GET-only)
      const evUrl =
        `${functionsBase}/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
      const evRes = await fetch(evUrl);
      const evBody = await evRes.text();
      if (!evRes.ok) {
        throw new Error(`GET ${evUrl} -> ${evRes.status} ${evBody}`);
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
        `${functionsBase}/getTimelineEventsV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=50`;
      const tlRes = await fetch(tlUrl);
      const tlBody = await tlRes.text();
      if (!tlRes.ok) {
        throw new Error(`GET ${tlUrl} -> ${tlRes.status} ${tlBody}`);
      }
      const tl = tlBody ? JSON.parse(tlBody) : {};

      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs: TimelineDoc[] = tl.docs.slice();
        docs.sort((a, b) => (b.occurredAt?._seconds || 0) - (a.occurredAt?._seconds || 0));
        setTimeline(docs.filter((x) => x.type !== "DEBUG_EVENT"));
      }

      setDataStatus("live");
    } catch (e) {
      console.error("refresh failed", {
        functionsBase,
        incidentId,
        error: String((e as any)?.message || e),
      });
      setDataStatus("error");
    } finally {
      setLoading(false);
    }
  }

  // Prefetch signed thumbnail URLs for latest 12 evidence items
  async function prefetchThumbs(latest: EvidenceDoc[]) {
    if (!functionsBase) return;
    const want = latest.filter((x) => x.file?.storagePath);

    await Promise.all(
      want.map(async (ev) => {
        if (thumbUrl[ev.id]) return;

        try {
          const storagePath = pickEvidencePaths(ev).thumbPath;
          if (!storagePath) return;
          const resp = await postJson<{ ok: boolean; url?: string; error?: string }>(
            `${functionsBase}/createEvidenceReadUrlV1`,
            { orgId: orgId, incidentId, storagePath, bucket: (ev.file?.bucket || ev.bucket || evidenceBucket), expiresSec: 900 }
          );
          if (resp?.ok && resp.url) {
            setThumbUrl((m) => ({ ...m, [ev.id]: resp.url! }));
          
            setThumbErr((m) => ({ ...m, [ev.id]: false }));
}
        } catch (e) {
          console.warn("thumb prefetch failed", ev.id, e);
        
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
        const sp = String(pickEvidencePaths(ev as any).thumbPath || "");
        if (!id || !sp) continue;

        const hadErr = !!(thumbErr as any)?.[id];
        const hasUrl = !!(thumbUrl as any)?.[id];
        if (!hadErr && hasUrl) {
          continue;
        }

        try {
          const resp: any = await postJson(
            `${functionsBase}/createEvidenceReadUrlV1`,
            { orgId: orgId, incidentId, storagePath: sp, bucket: (ev.file?.bucket || ev.bucket || evidenceBucket), expiresSec: 900 }
          );

          if (resp?.ok && resp.url) {
            setThumbUrl((m: any) => ({ ...m, [id]: resp.url }));
            setThumbErr((m: any) => ({ ...m, [id]: false }));
          } else {
            setThumbErr((m: any) => ({ ...m, [id]: true }));
          }
        } catch {
          setThumbErr((m: any) => ({ ...m, [id]: true }));
        }
      }
    } catch {
      // ignore
    }
  }

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
    const base = functionsBase || process.env.NEXT_PUBLIC_API_BASE || "";
    if (!base) throw new Error("Missing NEXT_PUBLIC_FUNCTIONS_BASE / NEXT_PUBLIC_API_BASE");
    const url = `${base}/${path}`.replace(/\/+$/, "");
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
  }, [incidentId]);

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
      router.replace(`/incidents/${incidentId}`, { scroll: false } as any);
    } catch {}
  }, [sp, incidentId]);
useEffect(() => {
    const v = sp.get("hi");
    if (!v) return;
    setHi(v);
    toast("Evidence secured ✓");
    const t = setTimeout(() => toast(null), 2200);
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
        const sp = pickEvidencePaths(ev).previewPath;
        if (!sp) return;
        const resp = await postJson<{ ok: boolean; url?: string; error?: string }>(
          `${functionsBase}/createEvidenceReadUrlV1`,
          { orgId: orgId, incidentId, storagePath: sp, bucket: ((ev as any)?.file?.bucket || (ev as any)?.bucket || evidenceBucket), expiresSec: 900 }
        );
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
      const out: any = await postJson(`${functionsBase}/convertEvidenceHeicNowV1`, {
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
      const report: any = await postJson(`${functionsBase}/debugHeicConversionV1`, {
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
  const _hasApproved = Array.isArray(timeline) && timeline.some((t: any) => String(t?.type) === "FIELD_APPROVED");

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
    <main className="min-h-screen bg-black text-white">
      {process.env.NODE_ENV !== "production" ? (
        <div className="px-4 pt-2 text-[11px] text-gray-400">
          functionsBase={functionsBase || "(unset)"}
        </div>
      ) : null}
      {/* Top bar */}
      <div className="px-4 pt-4 pb-3 border-b border-white/10 sticky top-0 bg-black/80 backdrop-blur z-10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-400">Field Incident</div>
            <div className="text-xl font-semibold tracking-tight">{incidentId} • Riverbend Electric</div>
            <div className="mt-1 text-[11px]">
              <span className={"px-2 py-0.5 rounded-full border " + (isClosed ? "bg-red-500/15 border-red-400/30 text-red-100" : "bg-emerald-500/15 border-emerald-400/30 text-emerald-100")}>
                status: {incidentStatus || "open"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
        <button
              type="button"
              className="px-2 py-1 rounded-full text-xs bg-purple-600/20 border border-purple-400/20 text-purple-100 hover:bg-purple-600/30 transition"
              title="Supervisor review + approve/lock"
              onClick={() => {
  const id = String(incidentId || "");
  if (!id || id.includes("${")) return;
  router.push(`/incidents/${id}/review`);
}}>
              🛡 Review
            </button>
            <button
              type="button"
              className={"px-2 py-1 rounded-full text-xs border transition " + (isClosed ? "bg-white/8 border-white/15 text-gray-300 cursor-not-allowed" : "bg-red-600/20 border-red-400/30 text-red-100 hover:bg-red-600/30")}
              disabled={isClosed || closingIncident}
              onClick={() => { try { closeIncident(); } catch {} }}
              title={isClosed ? "Incident already closed" : "Set incident status to closed"}>
              {closingIncident ? "Closing..." : "Close Incident"}
            </button>
            <button
              type="button"
              className={"px-2 py-1 rounded-full text-xs border transition " + (isClosed ? "bg-white/8 border-white/15 text-gray-300 cursor-not-allowed" : "bg-cyan-600/20 border-cyan-400/30 text-cyan-100 hover:bg-cyan-600/30")}
              disabled={isClosed}
              onClick={() => { if (!isClosed) setShowCreateJob(true); }}
              title={isClosed ? "Incident is closed (read-only)" : "Create a job"}>
              + Create Job
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded-full text-xs bg-white/8 border border-white/15 text-gray-200 hover:bg-white/12 transition"
              onClick={() => { try { router.push(`/incidents/${incidentId}/summary`); } catch {} }}
              title="Open incident summary"
            >
              Summary
            </button>
          
      {/* PEAKOPS_UX_TOAST_RENDER_V1 */}
      {toastMsg ? (
        <div className="fixed left-1/2 -translate-x-1/2 top-20 z-50 px-3 py-2 rounded-xl bg-black/70 border border-white/10 text-sm text-gray-100 backdrop-blur shadow-[0_12px_40px_rgba(0,0,0,0.55)]">
          {toastMsg}
        </div>
      ) : null}

</div>
        </div>
      </div>

      <div className={"p-4 space-y-4 " + (contextLockId ? "opacity-[0.94] transition-opacity" : "")}>
        
              
{/* PEAKOPS: removed big Open Notes bar */}
{/* PEAKOPS_NEXTBESTACTION_V1_RENDER */}
		<NextBestAction
	  arrived={arrived}
	  hasSession={_hasSession}
	  hasEvidence={_hasEvidence}
	  hasNotes={_hasNotes}
	  hasApproved={_hasApproved}
	  onOpenNotes={() => router.push("/incidents/" + incidentId + "/notes")}
	  onAddEvidence={() => { if (!isClosed) goAddEvidence(); else toast("Incident is closed (read-only).", 2600); }}
  onMarkArrived={() => { if (!isClosed) { try { markArrived(); } catch {} } else toast("Incident is closed (read-only).", 2600); }}
  onSubmitSession={() => { if (!isClosed) { try { submitSession(); } catch {} } else toast("Incident is closed (read-only).", 2600); }}
/>

        {/* PHASE6_1_TIMERS_V1_RENDER */}
        {/* PHASE6_1_TIMERS_POLISH_V2 + PHASE6_2_ACTION_NEEDED_V1 */}
<div className="rounded-2xl bg-white/5 border border-white/10 p-4">
  <div className="flex items-center justify-between gap-3">
    <div className="text-[11px] uppercase tracking-wide text-gray-400">Timers</div>
    {_notesAgo === "—" ? (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-300/25 text-amber-100">
        Action needed: notes
      </span>
    ) : null}
  </div>

  <div className="mt-3 grid grid-cols-1 sm:grid-cols-5 gap-2">
    <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2 sm:col-span-1">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">Arrival</div>
      <div className="mt-1 text-base font-semibold text-gray-100">{_arrivalAgo}</div>
    </div>

    <div className="rounded-xl bg-black/30 border border-white/10 px-3 py-2 sm:col-span-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">Evidence</div>
      <div className="mt-1 text-base font-semibold text-gray-100">{_evidenceAgo}</div>
    </div>

    <div
      className={
        "rounded-xl border px-3 py-2 sm:col-span-2 " +
        (_notesAgo === "—"
          ? "bg-amber-500/10 border-amber-300/25"
          : "bg-black/30 border-white/10")
      }>
      <div className={"text-[10px] uppercase tracking-wide " + (_notesAgo === "—" ? "text-amber-200/80" : "text-gray-400")}>
        Notes
      </div>
      <div className={"mt-1 text-base font-semibold " + (_notesAgo === "—" ? "text-amber-50" : "text-gray-100")}>
        {_notesAgo}
      </div>
    </div>
  </div>
</div>


        
        {/* PHASE5A_REQUEST_UPDATE_BANNER_V1 */}
        {reqUpdateText ? (
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

{/* Quick actions */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
  <div className="flex items-center justify-between">
    <div className="text-xs uppercase tracking-wide text-gray-400" id="evidence">Evidence</div>
    <span className="text-xs text-gray-500">Latest {Math.min(12, evidence.length)}</span>
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
                    <img src={u} className="w-full h-full object-cover transition-transform duration-200 hover:scale-[1.04]" loading="lazy" />
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
                  </div>

                  <div className="absolute bottom-2 left-2 right-2 text-[10px] text-gray-200/90 truncate bg-black/40 px-2 py-1 rounded">
                    {(ev.file?.originalName || "evidence")}
                  </div>
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

        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-gray-400">My Job</div>
            <span className="text-xs text-gray-500">default for new evidence</span>
          </div>
          {(() => {
            const current = jobs.find((j: any) => String(j?.id || j?.jobId || "") === String(currentJobId || ""));
            return (
              <div className="mt-3 space-y-2">
                <select
                  className="w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
                  disabled={isClosed || jobsBusy || jobs.length === 0}
                  value={currentJobId}
                  onChange={(e) => setCurrentJobId(String(e.target.value || ""))}
                >
                  <option value="">{jobs.length ? "Select job" : "No jobs available"}</option>
                  {jobs.map((j: any) => (
                    <option key={String(j?.id || j?.jobId)} value={String(j?.id || j?.jobId)}>
                      {String(j?.title || j?.id || "job")} [{String(j?.status || "open")}]
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={"px-3 py-2 rounded-lg text-sm border " + (isClosed ? "bg-white/5 border-white/10 text-gray-500 cursor-not-allowed" : "bg-emerald-600/20 border-emerald-300/30 text-emerald-100 hover:bg-emerald-600/30")}
                    disabled={isClosed || jobsBusy || !currentJobId}
                    onClick={() => { try { markCurrentJobComplete(); } catch {} }}
                  >
                    Mark Complete
                  </button>
                  {current ? (
                    <span className={"text-[10px] px-2 py-0.5 rounded-full border " + jobStatusPill(String(current?.status || "open"))}>
                      {String(current?.status || "open")}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })()}
        </section>

        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-gray-400">Jobs</div>
            <span className="text-xs text-gray-500">{jobs.length} total</span>
          </div>
          <div className="mt-3 space-y-2">
            {jobs.length === 0 ? (
              <div className="text-sm text-gray-400">No jobs yet. Create one to organize evidence.</div>
            ) : jobs.map((j: any) => (
              <div
                key={String(j?.id || j?.jobId)}
                onClick={() => setCurrentJobId(String(j?.id || j?.jobId || ""))}
                className={
                  "w-full rounded-lg border px-3 py-2 flex items-center justify-between gap-2 text-left " +
                  (String(currentJobId || "") === String(j?.id || j?.jobId || "")
                    ? "border-cyan-300/35 bg-cyan-500/10"
                    : "border-white/10 bg-black/30")
                }
              >
                <div className="min-w-0">
                  <div className="text-sm text-gray-100 truncate">{String(j?.title || "(untitled)")}</div>
                  <div className="text-[11px] text-gray-400 truncate">
                    {(j?.assignedTo ? `assigned: ${j.assignedTo}` : "unassigned")}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={"text-[10px] px-2 py-0.5 rounded-full border " + jobStatusPill(String(j?.status || "open"))}>
                    {String(j?.status || "open")}
                  </span>
                  <select
                    className="text-xs bg-black/50 border border-white/15 rounded px-2 py-1"
                    disabled={isClosed || jobsBusy}
                    value={String(j?.status || "open")}
                    onChange={(e) => { try { setJobStatus(String(j?.id || j?.jobId || ""), e.target.value as JobStatus); } catch {} }}
                  >
                    {JOB_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-gray-400">Evidence to Job Mapping</div>
            <span className="text-xs text-gray-500">Set `evidence.jobId`</span>
          </div>
          <div className="mt-3 space-y-2">
            {(evidence || []).slice(0, 25).map((ev: any) => {
              const currentJobId = String(ev?.evidence?.jobId || ev?.jobId || "");
              return (
                <div key={String(ev?.id || "")} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-100 truncate">{String(ev?.file?.originalName || ev?.id || "evidence")}</div>
                    <div className="text-[11px] text-gray-400 truncate">evidenceId: {String(ev?.id || "")}</div>
                  </div>
                  <select
                    className="text-xs bg-black/50 border border-white/15 rounded px-2 py-1 min-w-[180px]"
                    disabled={isClosed || jobsBusy}
                    value={currentJobId}
                    onChange={(e) => { try { assignEvidenceJob(String(ev?.id || ""), String(e.target.value || "")); } catch {} }}
                  >
                    <option value="">(no job)</option>
                    {jobs.map((j: any) => (
                      <option key={String(j?.id || j?.jobId)} value={String(j?.id || j?.jobId)}>
                        {String(j?.title || j?.id || "job")} [{String(j?.status || "open")}]
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </section>

        {/* Timeline story */}
        
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

        {/* Notes section will remain below if you already inserted it elsewhere */}
        {/* Readiness Checklist */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Readiness</div>
            <span className="text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300">
              Live
            </span>
          </div>

          {(() => {
            const hasSession = timeline.some((t: any) => String(t.type) === "SESSION_STARTED" || String(t.type) === "FIELD_ARRIVED" || String(t.type) === "EVIDENCE_ADDED");
            const evidenceN = evidence.filter((ev: any) => !!ev.file?.storagePath && !String(ev.file?.storagePath||"").includes("demo_placeholder")).length;
            const hasEvidence = evidenceN >= 4;
            const hasNotes = notesSavedLocal || timeline.some((t: any) => String(t.type) === "NOTES_SAVED"); const hasApproved = timeline.some((t: any) => String(t.type) === "FIELD_APPROVED");

            const items = [
              ["Field session started", hasSession],
              ["Evidence captured (4+)", hasEvidence],
              ["Notes saved", hasNotes],
              ["Supervisor approved", hasApproved],
            ];

            const ready = hasSession && hasEvidence && hasNotes;

            return (
              <div className="mt-3 space-y-2 text-sm">
                <div className={"rounded-xl p-3 border " + (ready ? "bg-green-700/15 border-green-400/20" : "bg-amber-700/10 border-amber-400/20")}>
                  <div className="font-semibold">{ready ? "Ready for supervisor review" : "Not ready yet"}</div>
                  <div className="text-xs text-gray-400 mt-1">This is computed from live events + evidence.</div>
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

        <div className="h-20" />
      </div>

      {/* Bottom dock */}
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
            title={isClosed ? "Incident is closed (read-only)" : (_hasEvidence ? "Evidence captured (done)" : "Go to Evidence")}>
            Evidence
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
            onClick={() => { try { router.push("/incidents/" + incidentId + "/notes"); } catch {} }}
            title={_hasNotes ? "Notes saved (done)" : "Write notes"}>
            Notes
          </button>

          {/* Submit */}
          <button
            type="button"
            className={
              "w-full py-3 rounded-xl text-sm font-semibold border transition " +
              ((arrived && _hasEvidence && _hasNotes && !submitting && !isClosed)
                ? "bg-emerald-600/20 border-emerald-300/25 text-emerald-50 hover:bg-emerald-600/25"
                : "bg-white/5 border-white/10 text-gray-400 cursor-not-allowed")
            }
            disabled={submitting || !arrived || !_hasEvidence || !_hasNotes || isClosed}
            title={
              isClosed
                ? "Incident is closed (read-only)"
                : (arrived && _hasEvidence && _hasNotes)
                ? "Submit session for supervisor review"
                : "Complete Arrive + Evidence + Notes first"
            }
            onClick={(e) => {
              try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
              try { submitSession(); } catch {}
            }}>
            Submit
          </button>
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
                <img src={previewUrl} className="w-full h-full object-cover" />
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
        <div className="fixed top-4 right-4 z-50 rounded-xl bg-black/70 border border-white/10 px-4 py-3 text-sm text-gray-200 backdrop-blur">
          {toastMsg}
        </div>
      ) : null}

    </main>
  );
}
