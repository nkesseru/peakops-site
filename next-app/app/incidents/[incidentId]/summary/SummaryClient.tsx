"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
import { loadVendors } from "@/lib/orgVendors";
import { ensureDemoActor, getActorRole, getActorUid, isDemoIncident } from "@/lib/demoActor";
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";
import { normalizeIncidentStatusShared, incidentStatusLabel, incidentStatusPill } from "@/lib/incidents/incidentStatus";
import { buildJobUiState } from "@/lib/incidents/resolveJobDisplayState";
import { incidentPath } from "@/lib/navigation/incidentRoutes";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import { displayIncidentTitle } from "@/lib/incidents/displayIncidentTitle";
// PEAKOPS_REPORT_HEADER_VIEW_V1 (2026-05-08) — Slice Start Job 1.0.
// Industry-aware report eyebrow + filing-aware intro line. Read-only
// best-effort; falls back to "Job Report" when industry isn't set.
import {
  DEFAULT_ORG_ONBOARDING_VIEW,
  loadOrgOnboardingView,
  type OrgOnboardingView,
} from "@/lib/onboarding/orgOnboardingView";

type IncidentDoc = {
  id: string;
  status?: string;
  packetMeta?: {
    status?: string;
    exportedAt?: string;
    packetHash?: string;
    sizeBytes?: number;
    evidenceCount?: number;
    jobCount?: number;
  };
};

type JobDoc = {
  id: string;
  jobId?: string;
  title?: string;
  status?: string;
  // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
  vendorId?: string | null;
  vendorName?: string | null;
};

type EvidenceDoc = {
  id: string;
  file?: {
    originalName?: string;
    storagePath?: string;
    bucket?: string;
    thumbPath?: string;
    previewPath?: string;
  };
  evidence?: {
    jobId?: string | null;
  };
  jobId?: string | null;
  storedAt?: { _seconds?: number };
};

type TimelineDoc = {
  id: string;
  type?: string;
  actor?: string;
  refId?: string | null;
  occurredAt?: { _seconds?: number };
};

function getEvidenceJobId(ev: EvidenceDoc): string {
  const top = String((ev as any)?.jobId || (ev as any)?.["jobId"] || "").trim();
  if (top) return top;
  const nested = String((ev as any)?.evidence?.jobId || (ev as any)?.["evidence.jobId"] || "").trim();
  if (nested) return nested;
  const nestedJob = String((ev as any)?.job?.jobId || (ev as any)?.["job.jobId"] || "").trim();
  return nestedJob;
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

// PEAKOPS_REPORT_FULL_DATE_V1 (2026-05-05)
// Customer-facing absolute date (e.g. "May 5, 2026"). Used in the
// header subtitle + footer "Generated" line.
function fmtFullDate(sec?: number): string {
  if (!sec) return "";
  try {
    return new Date(sec * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
function fmtFullDateTime(sec?: number): string {
  if (!sec) return "";
  try {
    return new Date(sec * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// PEAKOPS_SUMMARY_TIMELINE_HUMANIZE_V1 (2026-04-29)
// Customer-facing labels for raw event types. Mirrors the mapping in
// src/components/incident/TimelinePanel.tsx and ReviewClient's
// prettyTimelineType so we never render an event token like
// "FIELD_SUBMITTED" or "JOB_REJECTED" to a customer.
function prettyTimelineType(t: string): string {
  const key = String(t || "").toLowerCase();
  const m: Record<string, string> = {
    notes_saved: "Notes saved",
    evidence_added: "Photos saved",
    field_arrived: "Field arrived",
    field_submitted: "Sent to supervisor",
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

// PEAKOPS_REPORT_LABELS_V1 (2026-05-01)
// REPORT_SUMMARY.html resolves UIDs to displayName/email server-side
// at export time. The Summary page doesn't have that lookup
// client-side, so anything that looks like a Firebase UID gets
// replaced with the contextual role label ("Supervisor" — only
// supervisors approve in this app). Emails pass through verbatim.
// The acceptance bar is "no 20+ char UID visible" — this guarantees
// it without an extra API roundtrip.
function actorLabel(raw: unknown): string {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.includes("@")) return v;
  // Firebase UIDs are 28 chars, alphanumeric. Anything that long
  // with no spaces is either a UID or already-opaque — either way,
  // not for human consumption. Render the role label instead.
  if (v.length >= 20 && /^[A-Za-z0-9]+$/.test(v)) return "Supervisor";
  return v;
}

// PEAKOPS_REPORT_ACTOR_FORMAT_V1 (2026-05-05)
// Customer-facing actor mapping for timeline / approval rows. Old
// auto-emit code wrote raw role/source slugs ("ui", "field",
// "field_ui", "supervisor", "system") into the actor field, which
// leaked into the report as "by ui" / "by field_ui". formatActor
// resolves those slugs to the human label and falls through to
// actorLabel for real uids/emails. Returns "" for system-authored
// events so the caller can hide the "by …" line entirely when the
// actor isn't meaningful to a customer.
function formatActor(actor?: unknown): string {
  const raw = String(actor || "").trim();
  if (!raw) return "";
  const slug = raw.toLowerCase();
  switch (slug) {
    case "ui":
    case "field":
    case "field_ui":
      return "Field crew";
    case "supervisor":
      return "Supervisor";
    case "admin":
      return "Admin";
    case "system":
    case "auto":
    case "server":
      return ""; // Hide system-authored attribution from customer copy.
    default:
      return actorLabel(raw);
  }
}

export default function SummaryClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const functionsBase = getFunctionsBase();
  useEffect(() => {
    warnFunctionsBaseIfSuspicious(functionsBase);
  }, [functionsBase]);
  // PEAKOPS_SUMMARY_ORGID_URL_V1
  // orgId is URL-sourced, matching IncidentClient/ReviewClient/NotesClient and
  // the single-source-of-truth rule for this app. No hardcoded fallback — if
  // the URL has no ?orgId=, every downstream fetch targets an empty orgId and
  // the backend surfaces a clear 400/409 instead of the old silent cross-org
  // mis-fetch against "riverbend-electric".
  const _summarySp = useSearchParams();
  const orgId = String(_summarySp?.get?.("orgId") || "").trim();
  // PEAKOPS_SUMMARY_DEV_MODE_V2 (2026-04-29)
  // Gate developer-only chrome (mismatch reasons, "Technical details"
  // disclosure, "Dev tools" / Refresh thumbnails / Force remint URLs /
  // Show thumb debug) STRICTLY on ?dev=1. Previous V1 also opened the
  // gate when NODE_ENV !== "production", which made local QA look
  // dev-leaky even when the tester didn't pass ?dev=1. Customer-
  // clean view is now the default in every environment; engineers
  // explicitly opt in by appending ?dev=1.
  const devMode = useMemo(() => {
    try {
      const v = String(_summarySp?.get?.("dev") || "").trim();
      return v === "1" || v.toLowerCase() === "true";
    } catch {
      return false;
    }
  }, [_summarySp]);
  const functionsBaseIsLocal = useMemo(() => {
    try {
      const host = String(new URL(String(functionsBase || "")).hostname || "").toLowerCase();
      return host === "127.0.0.1" || host === "localhost";
    } catch {
      return false;
    }
  }, [functionsBase]);

  // PEAKOPS_SUMMARY_NBA_V1 (2026-04-27)
  // Same Firebase Auth claims hook the field page uses, so the Next
  // Best Action card on Summary derives from the same identity source.
  const { claims: authClaims } = useAuth();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errUrl, setErrUrl] = useState("");
  const [errStatus, setErrStatus] = useState<number | null>(null);
  const [errBody, setErrBody] = useState("");
  // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
  const [incidentNotFound, setIncidentNotFound] = useState(false);
  const [incident, setIncident] = useState<IncidentDoc | null>(null);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
  // Set of currently-archived vendor IDs for the active org. Used
  // to render the "(archived)" suffix next to a task's vendor when
  // the vendor has since been archived. Empty set is the safe
  // default when load fails — readers fall back to "no suffix".
  const [archivedVendorIds, setArchivedVendorIds] = useState<Set<string>>(() => new Set<string>());
  // PEAKOPS_REPORT_HEADER_VIEW_V1 (2026-05-08) — Slice Start Job 1.0.
  // Industry-aware report eyebrow + filing-aware intro line. Loaded
  // once per orgId, best-effort — read failure stays silent and the
  // header falls back to its original "Job Report" copy.
  const [onboardingView, setOnboardingView] =
    useState<OrgOnboardingView>(DEFAULT_ORG_ONBOARDING_VIEW);
  useEffect(() => {
    if (!orgId) return;
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
  }, [orgId]);
  const [thumbUrl, setThumbUrl] = useState<Record<string, string>>({});
  const [thumbRetryById, setThumbRetryById] = useState<Record<string, number>>({});
  const [thumbErrById, setThumbErrById] = useState<Record<string, string>>({});
  const [thumbStatusById, setThumbStatusById] = useState<Record<string, number>>({});
  const [thumbMintErrorById, setThumbMintErrorById] = useState<Record<string, string>>({});
  const [thumbProbeStatusById, setThumbProbeStatusById] = useState<Record<string, number>>({});
  const [thumbProbeErrorById, setThumbProbeErrorById] = useState<Record<string, string>>({});
  const [thumbPathById, setThumbPathById] = useState<Record<string, string>>({});
  const [thumbBucketById, setThumbBucketById] = useState<Record<string, string>>({});
  const [thumbDebugOverlay, setThumbDebugOverlay] = useState(false);
  const thumbRefreshInflightRef = useRef<Record<string, boolean>>({});
  const thumbRefreshDebounceRef = useRef<any>(null);
  const [artifactBusy, setArtifactBusy] = useState(false);
  // PEAKOPS_REPORT_AUTHED_DOWNLOAD_V1 (2026-05-01)
  // Distinct loading state for the actual ZIP download (separate from
  // `artifactBusy` which covers report *generation*). Lets the
  // Download Report button read "Downloading…" while the authed fetch
  // is in flight.
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [fixUnassignedBusy, setFixUnassignedBusy] = useState(false);
  const [artifactHint, setArtifactHint] = useState("Report not generated yet.");
  const [artifactToast, setArtifactToast] = useState("");
  const [lastArtifactFilename, setLastArtifactFilename] = useState("");
  const [lastArtifactAt, setLastArtifactAt] = useState("");
  // PEAKOPS_SUMMARY_ARTIFACT_REUSE_V1 (2026-04-24)
  // Read states surface the "ready + URL" signal to handleArtifactDownload,
  // so the button can short-circuit to a direct download instead of
  // re-invoking exportIncidentPacketV1 when the packet already exists.
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactReady, setArtifactReady] = useState(false);
  // PEAKOPS_REPORT_AUTOGEN_V1 (2026-05-01)
  // One-shot guard for the freshly-closed-on-Summary auto-export.
  // Prevents the user from being stuck in a "two-click" flow:
  // they Close on Review, get routed to Summary, and the report
  // generates automatically without a second click. Re-mounts (tab
  // nav, refresh) all check the same `artifactDownloadable` signal
  // before firing, so once a report exists the auto-trigger no-ops.
  const autoGenTriggeredRef = useRef(false);
  // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
  // Inline confirm for the Regenerate flow. Single boolean — the
  // confirm panel is always for the same action so we don't need a
  // typed pendingConfirmAction shape (yet).
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);
  // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
  // Reason textarea content for the regenerate confirm panel.
  // Trimmed before going into the export payload; empty string =>
  // not sent (the function won't add it to the history entry).
  const [regenerateReason, setRegenerateReason] = useState("");

  // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
  // Notes block for the Summary/report. Fetched lazily so the
  // existing refresh path stays unchanged. notesStatus="bypassed"
  // means the field tech explicitly tapped "No note needed" instead
  // of typing a note — surface that on the report so the supervisor
  // sees an intentional choice, not a missing input.
  // PEAKOPS_REPORT_PREVIEW_V1 (2026-05-01)
  // Inline preview of REPORT_SUMMARY.html derived from already-loaded
  // page state — no ZIP read needed. Lets QA / customers verify the
  // report content before downloading.
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const [notesDoc, setNotesDoc] = useState<{
    incidentNotes?: string;
    siteNotes?: string;
    notesStatus?: string;
    notesBypassReason?: string;
  } | null>(null);
  // PEAKOPS_NOTES_CHECKPOINT_V2 (2026-04-29)
  // Sticky local mirror of the bypass flag (set by the field page when
  // the user taps "No note needed"). Used as a fallback so the
  // Summary's Field Note section still surfaces the bypass copy when
  // the backend Cloud Function hasn't been redeployed with the new
  // notesStatus field — the source-of-truth path is still Firestore,
  // but a same-device summary view can render correctly off the
  // local hint while the deploy catches up.
  const [notesBypassedLocal, setNotesBypassedLocal] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      try {
        const k = "peakops_notes_bypassed_" + String(incidentId);
        setNotesBypassedLocal(!!window.localStorage.getItem(k));
      } catch {
        setNotesBypassedLocal(false);
      }
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [incidentId]);
  const isDemoMode = isDemoIncident(incidentId);
  const [demoAuthBypassMsg, setDemoAuthBypassMsg] = useState("");
  const [activeOrgId, setActiveOrgId] = useState(orgId);

  // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
  // Load org vendors once per orgId. We only need the archived IDs
  // for rendering the "(archived)" suffix in the Tasks and Evidence
  // by Task sections — vendor names come from each task's
  // assignment-time snapshot. Failures are silent: if the load
  // errors, archived suffixes simply don't render — strictly an
  // additive UI signal, not load-bearing for correctness.
  useEffect(() => {
    let cancelled = false;
    const oid = String(activeOrgId || orgId || "").trim();
    if (!oid) return;
    (async () => {
      try {
        const vendors = await loadVendors(oid);
        if (cancelled) return;
        const ids = new Set<string>();
        for (const v of vendors) {
          if (v.status === "archived") ids.add(v.id);
        }
        setArchivedVendorIds(ids);
      } catch (e: any) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[summary-vendors-load]", {
            orgId: oid,
            code: e?.code || null,
            message: String(e?.message || e),
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeOrgId, orgId]);

  const demoHeaders = useMemo(() => {
    try {
      const demoMode = String(localStorage.getItem("peakops_demo_mode") || "") === "1";
      const looksDemoIncident = /^inc_/i.test(String(incidentId || ""));
      if (functionsBaseIsLocal && (demoMode || looksDemoIncident)) return { "x-peakops-demo": "1" };
    } catch {}
    return {} as Record<string, string>;
  }, [functionsBaseIsLocal, incidentId]);

  const incidentStatus = normalizeIncidentStatusShared(incident?.status);
  const packetEvidenceCount = evidence.length;
  const packetJobCount = jobs.length;

  // PEAKOPS_UI_STATE_ORCHESTRATION_V2 (2026-05-05)
  // Page-level UI state for the Job Report. The header pill, the
  // summary strip stat tones, the Generate Report CTA enable gate,
  // and the certification banner all read off this object.
  //
  // Critical rule (per spec): if the canonical resolver lifts the
  // state to Approved or Closed but the timeline lacks the matching
  // event (job_approved / incident_closed / field_approved), we
  // DOWNGRADE the displayState to whatever the timeline actually
  // supports. This prevents the cosmetic "Approved" pill from
  // showing on a record that hasn't actually been signed off — a
  // buyer-trust failure mode where the report claims approval the
  // audit trail can't substantiate.
  const reportUiState = useMemo(() => {
    // PEAKOPS_VIEW_MODEL_DEFENSIVE_V1 (2026-05-05)
    // Defensive Array.isArray guards on every input — view-model
    // builders must never throw during a cold-start render where a
    // backend fetch hasn't returned yet (or returned a 500). Falling
    // through with safe defaults gives the page a chance to render
    // its loading skeleton instead of crashing the route.
    const safeJobs = Array.isArray(jobs) ? jobs : [];
    const safeTimeline = Array.isArray(timeline) ? timeline : [];
    const safeEvidence = Array.isArray(evidence) ? evidence : [];
    const tasksApproved = safeJobs.filter((j: any) => {
      const rs = String(j?.reviewStatus || "").trim().toLowerCase();
      const st = String(j?.status || "").trim().toLowerCase();
      return rs === "approved" || st === "approved";
    }).length;
    const anyRejected = safeJobs.some((j: any) => {
      const rs = String(j?.reviewStatus || "").trim().toLowerCase();
      const st = String(j?.status || "").trim().toLowerCase();
      return rs === "rejected" || rs === "revision_requested" || st === "rejected";
    });
    const tlTypes = new Set(
      safeTimeline.map((t: any) => String(t?.type || "").toLowerCase()),
    );
    const hasSubmitted = tlTypes.has("field_submitted");
    const hasApprovedEvent = tlTypes.has("job_approved") || tlTypes.has("field_approved") || tlTypes.has("task_approved");
    const hasClosedEvent = tlTypes.has("incident_closed") || tlTypes.has("job_closed");
    // PEAKOPS_REPORT_PILL_PARITY_V1 (2026-05-08) — Slice Start Job 1.2.
    // The Summary pill was getting stuck on "Open" after Arrival
    // because the resolver inputs here didn't include hasArrival /
    // hasNotes — the same two signals IncidentClient passes to its
    // buildJobUiState call (next-app/app/incidents/[incidentId]/
    // IncidentClient.tsx:2992-3007). Without them, the resolver
    // can't flip from Open -> In Progress on a doc whose `status`
    // is still "open" even though the timeline records arrival.
    // Read both from the timeline event types written by the
    // canonical callables: markArrivedV1 emits FIELD_ARRIVED;
    // saveIncidentNotesV1 emits NOTES_SAVED.
    const hasArrival = tlTypes.has("field_arrived");
    const hasNotes =
      tlTypes.has("notes_saved") ||
      tlTypes.has("notes_added") ||
      tlTypes.has("field_notes_added");

    const raw = buildJobUiState({
      status: incidentStatus,
      allTasksApproved: safeJobs.length > 0 && tasksApproved === safeJobs.length,
      anyRejected,
      hasSubmitted,
      evidenceCount: safeEvidence.length,
      hasArrival,
      hasNotes,
    });

    // Downgrade path. The resolver itself is correct — it derives
    // from raw lifecycle truth — but the report needs a higher bar:
    // an Approved/Closed claim is only valid if the audit trail
    // can prove it.
    if (raw.displayState === "Closed" && !hasClosedEvent) {
      return buildJobUiState({
        status: hasApprovedEvent ? "approved" : (hasSubmitted ? "submitted" : "in_progress"),
        allTasksApproved: safeJobs.length > 0 && tasksApproved === safeJobs.length,
        anyRejected,
        hasSubmitted,
        evidenceCount: safeEvidence.length,
        hasArrival,
        hasNotes,
      });
    }
    if (raw.displayState === "Approved" && !hasApprovedEvent) {
      return buildJobUiState({
        status: hasSubmitted ? "submitted" : "in_progress",
        allTasksApproved: false,
        anyRejected,
        hasSubmitted,
        evidenceCount: safeEvidence.length,
        hasArrival,
        hasNotes,
      });
    }
    return raw;
  }, [incidentStatus, jobs, timeline, evidence]);


  const statusCounts = useMemo(() => {
    const out: Record<string, number> = {
      open: 0,
      in_progress: 0,
      complete: 0,
      review: 0,
      approved: 0,
      rejected: 0,
    };
    for (const j of jobs) {
      const s = String(j?.status || "open").toLowerCase();
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  }, [jobs]);

  const evidenceByJob = useMemo(() => {
    const map: Record<string, EvidenceDoc[]> = {};
    for (const ev of evidence) {
      const jid = String(getEvidenceJobId(ev) || "unassigned");
      if (!map[jid]) map[jid] = [];
      map[jid].push(ev);
    }
    return map;
  }, [evidence]);
  const unassignedEvidenceCount = useMemo(
    () => (evidence || []).filter((ev) => !getEvidenceJobId(ev)).length,
    [evidence]
  );

  const liveEvidenceCount = Array.isArray(evidence) ? evidence.length : 0;
  const liveJobsCount = Array.isArray(jobs) ? jobs.length : 0;

  const timelineHighlights = useMemo(() => {
    const interesting = new Set(["job_completed", "job_approved", "job_rejected", "incident_closed", "field_submitted", "evidence_added"]);
    return (timeline || [])
      .filter((t) => {
        const ty = String(t.type || "").toLowerCase();
        return interesting.has(ty);
      })
      .slice(0, 50);
  }, [timeline]);

  async function refresh(retryAttempt = 0, baseOverride?: string, fallbackUsed = false) {
    const base = String(baseOverride || functionsBase || "").trim();
    if (!base) return;
    setLoading(true);
    setErr("");
    setErrUrl("");
    setErrStatus(null);
    setErrBody("");
    setIncidentNotFound(false);
    setDemoAuthBypassMsg("");
    try {
      let requestOrgId = String(activeOrgId || orgId || "").trim() || orgId;
      if (isDemoMode || functionsBaseIsLocal) {
        ensureDemoActor(incidentId);
      }
      const throwHttp = (name: string, url: string, status: number, body: string) => {
        const e: any = new Error(`${name} failed (${status})`);
        e.endpoint = url;
        e.status = status;
        e.body = String(body || "").slice(0, 500);
        throw e;
      };
      const incUrl = `/api/fn/getIncidentV1?orgId=${encodeURIComponent(requestOrgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      setErrUrl(incUrl);
      const incRes = await authedFetch(incUrl, { headers: demoHeaders });
      const incTxt = await incRes.text();
      if (!incRes.ok) {
        throwHttp("getIncidentV1", incUrl, incRes.status, incTxt);
      }
      const inc = incTxt ? JSON.parse(incTxt) : {};
      if (inc?.ok && inc.doc) {
        setIncident(inc.doc);
        const nextOrg = String(inc?.doc?.orgId || "").trim();
        if (nextOrg) {
          requestOrgId = nextOrg;
          setActiveOrgId(nextOrg);
        }
      }

      const jobsUrl =
        `/api/fn/listJobsV1?orgId=${encodeURIComponent(requestOrgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=100` +
        `&actorUid=${encodeURIComponent(getActorUid())}` +
        `&actorRole=${encodeURIComponent(getActorRole())}`;
      setErrUrl(jobsUrl);
      const jobsRes = await authedFetch(jobsUrl, { headers: demoHeaders });
      const jobsTxt = await jobsRes.text();
      if (!jobsRes.ok) {
        if ((isDemoMode || functionsBaseIsLocal) && jobsRes.status === 403 && jobsTxt.includes("auth_required")) {
          setDemoAuthBypassMsg("Demo auth bypass failed for listJobsV1. Ensure demo actor is set (peakops_uid/peakops_role) and refresh.");
        }
        throwHttp("listJobsV1", jobsUrl, jobsRes.status, jobsTxt);
      }
      const jb = jobsTxt ? JSON.parse(jobsTxt) : {};
      if (jb?.ok && Array.isArray(jb.docs)) setJobs(jb.docs);

      const evUrl = `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(requestOrgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      setErrUrl(evUrl);
      const evRes = await authedFetch(evUrl, { headers: demoHeaders });
      const evTxt = await evRes.text();
      if (!evRes.ok) {
        throwHttp("listEvidenceLocker", evUrl, evRes.status, evTxt);
      }
      const ev = evTxt ? JSON.parse(evTxt) : {};
      if (ev?.ok && Array.isArray(ev.docs)) setEvidence(ev.docs);

      const tlUrl = `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(requestOrgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      setErrUrl(tlUrl);
      const tlRes = await authedFetch(tlUrl, { headers: demoHeaders });
      const tlTxt = await tlRes.text();
      if (!tlRes.ok) {
        throwHttp("getTimelineEventsV1", tlUrl, tlRes.status, tlTxt);
      }
      const tl = tlTxt ? JSON.parse(tlTxt) : {};
      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs = tl.docs.slice().sort((a: any, b: any) => (b?.occurredAt?._seconds || 0) - (a?.occurredAt?._seconds || 0));
        setTimeline(docs);
      }

      const packetMeta: any = inc?.doc?.packetMeta || {};
      const packetStatus = String(packetMeta?.status || "").toLowerCase();
      const packetBucket = String(packetMeta?.bucket || packetMeta?.packetBucket || "").trim();
      const packetStoragePath = String(packetMeta?.storagePath || packetMeta?.packetStoragePath || "").trim();
      const packetDownloadUrl = String(packetMeta?.downloadUrl || "").trim();

      // PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
      // Build the customer-safe opaque download URL whenever the
      // incident has any signal of a generated report. Bucket and
      // storagePath are still on packetMeta server-side, but the
      // frontend never builds /api/media URLs for reports — that
      // proxy is gone outside the emulator and leaks internals.
      const reportReady =
        packetStatus === "ready" ||
        !!packetDownloadUrl ||
        (!!packetBucket && !!packetStoragePath);
      const maybeArtifact = reportReady
        ? `/api/reports/${encodeURIComponent(incidentId)}/download?orgId=${encodeURIComponent(requestOrgId)}`
        : "";

      if (packetStatus === "ready" && maybeArtifact) {
        setArtifactUrl(maybeArtifact);
        setArtifactHint("Report ready to download.");
        setArtifactReady(true);
      } else if (packetStatus === "building") {
        setArtifactUrl("");
        setArtifactHint("Report is building. Try again shortly.");
        setArtifactReady(false);
      } else {
        setArtifactUrl("");
        setArtifactHint("No report yet. Click Generate Report.");
        setArtifactReady(false);
      }
      setErrUrl("");
    } catch (e: any) {
      const msg = String(e?.message || e || "refresh_failed");
      const status = Number(e?.status || 0) || null;
      const endpoint = String(e?.endpoint || errUrl || "");
      const body = String(e?.body || "").slice(0, 500);
      const isNetworkFailure = isLikelyFetchNetworkError(e, status || undefined);
      if (isNetworkFailure && retryAttempt < 1) {
        const fallbackBase = getFunctionsBaseFallback(base);
        if (fallbackBase) void rememberFunctionsBase(fallbackBase);
        if (fallbackBase) {
          probeAndRestoreEnvFunctionsBase(fallbackBase);
        }
        if (process.env.NODE_ENV !== "production") {
          console.debug("[summary-refresh] transient network failure, retrying once", {
            incidentId,
            endpoint,
            message: msg,
            attempt: retryAttempt + 1,
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
      if ((isDemoMode || functionsBaseIsLocal) && msg.includes("auth_required")) {
        setErr("");
      } else {
        setErr(msg);
      }
      setErrUrl(endpoint || base);
      setErrStatus(status);
      setErrBody(body || `functionsBase=${base}${fallbackUsed ? " fallback=applied" : ""}`);
      // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
      if (
        Number(status) === 404 ||
        /incident_not_found/i.test(String(body || "")) ||
        /incident not found/i.test(msg)
      ) {
        setIncidentNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }
  // PEAKOPS_REPORT_FILENAME_V1 (2026-04-28)
  // Friendly download filename: "<title-or-task>_<MMMdd>.zip" instead of
  // "20260428T153016Z__packet.zip". Falls back through incident title →
  // first task title → "incident-<short-id>". Used by every download
  // path on this page.
  function humanizeReportFilename(): string {
    const ext = "zip";
    const incTitle = String((incident as any)?.title || "").trim();
    const firstTaskTitle = String((jobs?.[0] as any)?.title || "").trim();
    const baseRaw = incTitle || firstTaskTitle || `incident-${String(incidentId || "").slice(-6)}`;
    const safeBase = baseRaw
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60);
    const d = new Date();
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const stamp = `${months[d.getMonth()]}${String(d.getDate()).padStart(2, "0")}`;
    return `${safeBase}_${stamp}.${ext}`;
  }

  // PEAKOPS_SUMMARY_ARTIFACT_REUSE_V2 (2026-04-24)
  // Single source of truth for "is there an existing packet" — read from
  // incident.packetMeta directly, not from the derived artifactReady /
  // artifactUrl state. The derived flags only get populated when
  // refresh() sees a literal `status === "ready"`, but a packet can also
  // be implied by the presence of bucket+storagePath, downloadUrl, or
  // packetHash (older shapes). This helper is what decides whether to
  // download or to POST exportIncidentPacketV1 — no other place should
  // hand-roll that test.
  function buildExistingPacketHref(): { href: string; filename: string } | null {
    // PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
    // Determine "is a report ready" from the same signals as before
    // (status=="ready", a download URL or storage marker on
    // packetMeta, the in-flight ready flag) — but the URL we hand
    // back is now the opaque /api/reports/<id>/download route. The
    // bucket / storagePath from packetMeta are server-side only.
    const pm: any = (incident as any)?.packetMeta || {};
    const pmStatus = String(pm?.status || "").toLowerCase();
    const pmDownloadUrl = String(pm?.downloadUrl || "").trim();
    const pmBucket = String(pm?.bucket || pm?.packetBucket || "").trim();
    const pmStoragePath = String(pm?.storagePath || pm?.packetStoragePath || "").trim();
    const pmHash = String(pm?.packetHash || pm?.zipSha256 || "").trim();

    const hasPacket =
      pmStatus === "ready" ||
      !!pmDownloadUrl ||
      (!!pmBucket && !!pmStoragePath) ||
      !!pmHash ||
      (artifactReady && !!artifactUrl);
    if (!hasPacket) return null;

    const oid = String(activeOrgId || orgId || "").trim();
    const href = `/api/reports/${encodeURIComponent(incidentId)}/download${oid ? `?orgId=${encodeURIComponent(oid)}` : ""}`;

    // Always prefer the friendly humanized name; fall back to a stored
    // friendly name only if it doesn't look like the legacy ISO-stamped
    // packet name.
    const stored = String(lastArtifactFilename || "").trim();
    const looksLegacy = /__packet\.zip$|^[0-9TZ_]+packet\.zip$/i.test(stored);
    const filename = !stored || looksLegacy ? humanizeReportFilename() : stored;
    return { href, filename };
  }

  // PEAKOPS_REPORT_AUTHED_DOWNLOAD_V1 (2026-05-01)
  // Authenticated ZIP download. The opaque /api/reports/<id>/download
  // route requires a Firebase ID token, which a plain anchor `href`
  // navigation does NOT include — Chrome surfaces that as
  // "Try to sign in to the site." This helper:
  //   1. Fetches the route via authedFetch (Bearer token attached)
  //   2. Follows a 302 redirect transparently (production signed-URL
  //      path) or reads the streamed bytes (emulator path)
  //   3. Saves the response as a Blob, triggers a `<a download>`
  //      against an object URL, then revokes the URL.
  //   4. Surfaces a customer-clean error if anything fails — no auth /
  //      internal messages.
  // Filename precedence: caller-provided > Content-Disposition >
  // humanizeReportFilename() fallback.
  async function downloadAuthedZip(href: string, preferredFilename: string): Promise<boolean> {
    setDownloadBusy(true);
    try {
      const res = await authedFetch(href, { cache: "no-store" });
      if (!res.ok) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[summary-download] non-OK", res.status, await res.text().catch(() => ""));
        }
        setArtifactToast("We couldn't download the report. Refresh and try again.");
        window.setTimeout(() => setArtifactToast(""), 3200);
        return false;
      }
      const blob = await res.blob();
      // Filename: caller-provided wins; fall back to Content-Disposition
      // if the route exposes it; otherwise the humanized name.
      let name = String(preferredFilename || "").trim();
      if (!name) {
        const cd = res.headers.get("content-disposition") || "";
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        if (m && m[1]) {
          try { name = decodeURIComponent(m[1]); } catch { name = m[1]; }
        }
      }
      if (!name) name = humanizeReportFilename();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        // Revoke after a short delay so the browser has time to start
        // the save dialog before we tear down the URL.
        window.setTimeout(() => {
          try { URL.revokeObjectURL(objectUrl); } catch {}
        }, 1500);
      }
      return true;
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[summary-download] failed", e);
      }
      setArtifactToast("We couldn't download the report. Refresh and try again.");
      window.setTimeout(() => setArtifactToast(""), 3200);
      return false;
    } finally {
      setDownloadBusy(false);
    }
  }

  // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
  // Role-gated regenerate. Field users get the cached download path
  // by default and can never trigger a fresh export — prevents an
  // off-policy operator from rebuilding an audit artifact mid-flight
  // and from racking up Cloud Run cost. Admin/supervisor only.
  const _myRoleForRegen = String(authClaims?.role || "").toLowerCase();
  const canRegenerateReport =
    _myRoleForRegen === "admin" || _myRoleForRegen === "supervisor";

  async function handleArtifactDownload(opts: { forceRegenerate?: boolean; reason?: string } = {}) {
    if (!activeOrgId || !incidentId) {
      setErr("Cannot generate report: missing org or incident context.");
      return;
    }
    // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
    // Defense in depth: even if the Regenerate UI somehow leaks to
    // a field user (forged attribute, console call, future bug),
    // the handler refuses to fire the export. The cache-fast-path
    // download stays available for everyone.
    if (opts.forceRegenerate && !canRegenerateReport) {
      setArtifactToast("Only admins or supervisors can regenerate reports.");
      window.setTimeout(() => setArtifactToast(""), 3500);
      return;
    }

    // PEAKOPS_VENDOR_ASSIGNMENT_V1_2 (2026-05-04)
    // forceRegenerate=true skips the existing-packet fast path and
    // always POSTs to exportIncidentPacketV1. This is what the
    // Regenerate report button calls — it forces a fresh capture of
    // the world (vendor archived state, approver labels, photos)
    // when something the operator cares about has changed since the
    // last export. Default behavior (no flag) still short-circuits
    // to the cached ZIP for the common "I just want to download
    // again" case.
    if (!opts.forceRegenerate) {
      const existing = buildExistingPacketHref();
      if (existing) {
        const ok = await downloadAuthedZip(existing.href, existing.filename);
        if (!ok) return;
        setArtifactUrl(existing.href);
        setArtifactReady(true);
        setLastArtifactFilename(existing.filename);
        setArtifactHint("Report ready to download.");
        setArtifactToast(`Report ready — downloaded ${existing.filename}.`);
        window.setTimeout(() => setArtifactToast(""), 2500);
        return;
      }
    }

    setArtifactBusy(true);
    setArtifactToast("");
    setErr("");

    try {
      const exportRes = await authedFetch("/api/fn/exportIncidentPacketV1", {
        method: "POST",
        headers: { "content-type": "application/json", ...demoHeaders },
        body: JSON.stringify({
          orgId: activeOrgId,
          incidentId,
          requestedBy: getActorUid?.() || "summary_ui",
          actorUid: getActorUid?.() || "summary_ui",
          actorRole: getActorRole?.() || "admin",
          // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
          // Optional reason for this regenerate. Goes into the
          // history entry server-side. Empty string is fine — the
          // helper there drops the field rather than persisting "".
          ...(opts.reason ? { reason: String(opts.reason).trim() } : {}),
        }),
      });

      const exportTxt = await exportRes.text();
      const out = exportTxt ? JSON.parse(exportTxt) : {};

      // PEAKOPS_SUMMARY_ARTIFACT_409_V2 (2026-04-24)
      // 409 fallback only — should rarely fire now that the pre-POST
      // gate above catches existing packets. But if a packet was
      // created between page load and click (race) we still want to
      // surface a benign success and download what's there. After a
      // refresh, buildExistingPacketHref() will pick up the URL.
      if (exportRes.status === 409) {
        setTimeout(() => {
          void refresh().then(async () => {
            const existing2 = buildExistingPacketHref();
            if (existing2) {
              const ok = await downloadAuthedZip(existing2.href, existing2.filename);
              if (ok) {
                setArtifactToast(`Report already generated — downloaded ${existing2.filename}.`);
                window.setTimeout(() => setArtifactToast(""), 2500);
              }
            } else {
              setArtifactToast("Report already generated.");
              window.setTimeout(() => setArtifactToast(""), 2500);
            }
          }).catch(() => {});
        }, 300);
        return;
      }

      if (!exportRes.ok || !out?.ok) {
        throw new Error(out?.error || `exportIncidentPacketV1 failed (${exportRes.status})`);
      }

      // PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
      // The export response now returns only the opaque downloadUrl
      // (relative `/api/reports/<id>/download?orgId=<org>`) plus
      // filename. No bucket/storagePath leak through. If a stale
      // server still emits the older shape, fall back to constructing
      // the same opaque path from incidentId + orgId.
      const responseUrl = String(out?.downloadUrl || "").trim();
      const oid = String(activeOrgId || orgId || "").trim();
      const href = responseUrl ||
        `/api/reports/${encodeURIComponent(incidentId)}/download${oid ? `?orgId=${encodeURIComponent(oid)}` : ""}`;

      // Use the friendly filename instead of the upstream ISO-timestamped
      // packet.zip name.
      const filename = String(out?.filename || "").trim() || humanizeReportFilename();

      const ok = await downloadAuthedZip(href, filename);
      if (!ok) return;

      setArtifactUrl(href);
      setArtifactReady(true);
      setLastArtifactFilename(filename);
      setLastArtifactAt(new Date().toLocaleString());
      setArtifactHint("Report ready to download.");
      setArtifactToast(`Report downloaded: ${filename}`);

      setTimeout(() => {
        void refresh().catch(() => {});
      }, 600);
    } catch (e: any) {
      // PEAKOPS_REPORT_FRIENDLY_FAIL_V1 (2026-05-05)
      // Show the spec'd customer-facing copy on the artifact toast
      // instead of the raw exception string. Engineering still sees
      // the underlying message via the dev toast + server logs.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[summary] artifact download failed", String(e?.message || e));
      }
      setArtifactToast("We couldn't generate the report. Please try again.");
      window.setTimeout(() => setArtifactToast(""), 3500);
    } finally {
      setArtifactBusy(false);
    }
  }

  async function ensureArtifact() {
    const requestOrgId = String(orgId || "").trim();
    if (!requestOrgId || !incidentId || err) return;
    try {
      setArtifactBusy(true);
      const res = await authedFetch("/api/fn/exportIncidentArtifactV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: requestOrgId, incidentId }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok) throw new Error(out?.error || `exportIncidentArtifactV1 failed (${res.status})`);
      const filename = humanizeReportFilename();
      const base64Zip = String(out?.base64Zip || "");
      if (!base64Zip) throw new Error("base64_zip_missing");
      const bin = atob(base64Zip);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLastArtifactFilename(filename);
      setLastArtifactAt(new Date().toISOString());
      setArtifactToast(`Report downloaded: ${filename}`);
      window.setTimeout(() => setArtifactToast(""), 2500);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setArtifactBusy(false);
    }
  }

  async function fixUnassignedEvidence() {
    if (!(isDemoMode || process.env.NODE_ENV !== "production")) return;
    try {
      setFixUnassignedBusy(true);
      const unresolved = (evidence || []).filter((ev) => !getEvidenceJobId(ev));
      if (unresolved.length < 1) {
        setArtifactToast("No unassigned evidence found.");
        window.setTimeout(() => setArtifactToast(""), 2000);
        return;
      }
      let fixed = 0;
      for (const ev of unresolved) {
        const evidenceId = String((ev as any)?.id || "").trim();
        if (!evidenceId) continue;
        const nested = String((ev as any)?.evidence?.jobId || (ev as any)?.["evidence.jobId"] || "").trim();
        const targetJobId = nested || "job_demo_002";
        const res = await authedFetch("/api/fn/assignEvidenceToJobV1", {
          method: "POST",
          headers: { "content-type": "application/json", ...demoHeaders },
          body: JSON.stringify({
            orgId: activeOrgId || orgId,
            incidentId,
            evidenceId,
            jobId: targetJobId,
          }),
        });
        const out: any = await res.json().catch(() => ({}));
        if (!res.ok || !out?.ok) {
          throw new Error(String(out?.error || `assignEvidenceToJobV1 failed (${res.status})`));
        }
        fixed += 1;
      }
      setArtifactToast(`Fixed ${fixed} unassigned evidence item${fixed === 1 ? "" : "s"}.`);
      window.setTimeout(() => setArtifactToast(""), 2500);
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setFixUnassignedBusy(false);
    }
  }

  async function prefetchThumb(ev: EvidenceDoc) {
    const id = String(ev?.id || "");
    if (!id || thumbUrl[id]) return;
    const ref = getBestEvidencePreviewRef(ev);
    if (!ref?.storagePath || !ref?.bucket) return;
    try {
      const out = await mintEvidenceReadUrl({
        orgId: activeOrgId || orgId,
        incidentId,
        storagePath: ref.storagePath,
        bucket: ref.bucket,
        expiresSec: getThumbExpiresSec(),
      }, demoHeaders);
      if (out?.ok && out?.url) {
        setThumbUrl((m) => ({ ...m, [id]: String(out.url) }));
        setThumbPathById((m) => ({ ...m, [id]: String(ref.storagePath) }));
        setThumbBucketById((m) => ({ ...m, [id]: String(ref.bucket) }));
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbErrById((m) => {
          if (!m[id]) return m;
          const n = { ...m };
          delete n[id];
          return n;
        });
        setThumbStatusById((m) => ({ ...m, [id]: Number(out.status || 200) }));
        setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
        setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
        setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
      }
    } catch (e: any) {
      setThumbErrById((m) => ({ ...m, [id]: String(e?.message || e || "thumb_prefetch_failed") }));
      setThumbStatusById((m) => ({ ...m, [id]: 0 }));
      setThumbMintErrorById((m) => ({ ...m, [id]: String(e?.message || e || "thumb_prefetch_failed") }));
    }
  }

  async function renewThumbOnce(ev: EvidenceDoc, currentSrc: string) {
    const id = String(ev?.id || "");
    if (!id) return;
    if (functionsBaseIsLocal) {
      // Emulator mode: disable auto-renew/retry to avoid flicker loops.
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      return;
    }
    const retryN = Number(thumbRetryById[id] || 0);
    if (retryN >= 1) {
      setThumbErrById((m) => ({ ...m, [id]: m[id] || "read_url_failed" }));
      return;
    }
    const ref = getBestEvidencePreviewRef(ev);
    if (!ref?.storagePath || !ref?.bucket) {
      setThumbErrById((m) => ({ ...m, [id]: "missing_bucket_or_storagePath" }));
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
      orgId: activeOrgId || orgId,
      incidentId,
      storagePath: ref.storagePath,
      bucket: ref.bucket,
      expiresSec: getThumbExpiresSec(),
    }, demoHeaders);
    if (out?.ok && out.url) {
      const sep = out.url.includes("?") ? "&" : "?";
      const fresh = `${out.url}${sep}v=${Date.now()}`;
      setThumbUrl((m) => ({ ...m, [id]: fresh }));
      setThumbPathById((m) => ({ ...m, [id]: String(ref.storagePath) }));
      setThumbBucketById((m) => ({ ...m, [id]: String(ref.bucket) }));
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      setThumbErrById((m) => {
        if (!m[id]) return m;
        const n = { ...m };
        delete n[id];
        return n;
      });
      setThumbStatusById((m) => ({ ...m, [id]: Number(out.status || 200) }));
      setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
      setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
      setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
      if (!functionsBaseIsLocal) {
        void probeMintedThumbUrl(fresh).then((probe) => {
          const pmsg = probe.ok ? "" : (probe.status > 0 ? `probe_http_${probe.status}` : String(probe.error || "probe_failed"));
          setThumbProbeStatusById((m) => ({ ...m, [id]: Number(probe.status || 0) }));
          setThumbProbeErrorById((m) => ({ ...m, [id]: pmsg || "-" }));
        });
      }
      logThumbEvent("retry_ok", { evidenceId: id, kind: ref.kind, storagePath: ref.storagePath });
      return;
    }
    const mintErr = String(out?.error || "read_url_failed");
    const mintDetails = out?.details ? String(JSON.stringify(out.details)).slice(0, 180) : "";
    const mintStatus = Number(out?.mintHttp || out?.status || 0) || 0;
    const showFail = retryN >= 1;
    setThumbErrById((m) => ({
      ...m,
      [id]: `${showFail ? "" : "retrying:"}mint_http=${mintStatus} mint_error=${mintErr}${mintDetails ? `:${mintDetails}` : ""} probe_http=- probe_error=-`,
    }));
    setThumbStatusById((m) => ({ ...m, [id]: Number(out?.status || 0) }));
    setThumbMintErrorById((m) => ({ ...m, [id]: `${mintErr}${mintDetails ? `:${mintDetails}` : ""}` }));
    setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
    setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
    logThumbEvent("retry_fail", {
      evidenceId: id,
      kind: ref.kind,
      storagePath: ref.storagePath,
      status: Number(out?.status || 0),
      error: String(out?.error || "read_url_failed"),
    });
  }

  useEffect(() => {
    ensureDemoActor(incidentId);
  }, [incidentId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, functionsBase]);

  // PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
  // Lazy notes fetch. Best-effort — a 4xx/5xx leaves notesDoc null,
  // which renders as "no notes" copy. Repeats on every refresh tick
  // (60s) so a supervisor-side change to notes shows up without a
  // manual reload.
  useEffect(() => {
    let cancelled = false;
    const oid = String(orgId || "").trim();
    const iid = String(incidentId || "").trim();
    if (!oid || !iid) return;
    async function loadNotes() {
      try {
        const res = await authedFetch(
          `/api/fn/getIncidentNotesV1?orgId=${encodeURIComponent(oid)}&incidentId=${encodeURIComponent(iid)}`,
          { cache: "no-store" },
        );
        const txt = await res.text().catch(() => "");
        let out: any = {};
        try { out = txt ? JSON.parse(txt) : {}; } catch {}
        if (cancelled) return;
        if (out?.ok && out.notes && typeof out.notes === "object") {
          setNotesDoc(out.notes);
        }
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[summary-notes] load failed", e);
        }
      }
    }
    void loadNotes();
    const t = setInterval(loadNotes, 60000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  useEffect(() => {
    (evidence || []).slice(0, 40).forEach((ev) => { prefetchThumb(ev); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidence]);

  function refreshVisibleThumbsDebounced() {
    if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    thumbRefreshDebounceRef.current = setTimeout(() => {
      const ids = new Set<string>();
      Object.values(evidenceByJob).forEach((list) => list.slice(0, 8).forEach((ev) => ids.add(String(ev?.id || ""))));
      for (const id of ids) {
        if (!id || thumbRefreshInflightRef.current[id]) continue;
        const ev = (evidence || []).find((x: any) => String(x?.id || "") === id);
        if (!ev) continue;
        thumbRefreshInflightRef.current[id] = true;
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbErrById((m) => ({ ...m, [id]: "" }));
        const current = String(thumbUrl[id] || "");
        void renewThumbOnce(ev, current).finally(() => {
          thumbRefreshInflightRef.current[id] = false;
        });
      }
    }, 120);
  }

  function forceRemintVisibleThumbs() {
    setThumbUrl({});
    setThumbRetryById({});
    setThumbErrById({});
    setThumbStatusById({});
    setThumbMintErrorById({});
    setThumbProbeStatusById({});
    setThumbProbeErrorById({});
    setThumbPathById({});
    setThumbBucketById({});
    refreshVisibleThumbsDebounced();
  }

  useEffect(() => {
    return () => {
      if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    };
  }, []);


  const truthMismatchReasons = useMemo(() => {
    const reasons: string[] = [];

    const packetMeta: any = (incident as any)?.packetMeta || {};
    const packetJobCount = Number(packetMeta?.jobCount || 0);
    const packetEvidenceCount = Number(packetMeta?.evidenceCount || 0);

    const approvedJobs = (Array.isArray(jobs) ? jobs : []).filter((j: any) => {
      const rs = String(j?.reviewStatus || "").toLowerCase();
      const st = String(j?.status || "").toLowerCase();
      return rs === "approved" || st === "approved";
    });

    const timelineCounts = (Array.isArray(timeline) ? timeline : []).reduce((acc: Record<string, number>, ev: any) => {
      const ty = String(ev?.type || "").toLowerCase();
      if (!ty) return acc;
      acc[ty] = (acc[ty] || 0) + 1;
      return acc;
    }, {});

    if (packetJobCount !== approvedJobs.length) {
      reasons.push(`packet jobCount ${packetJobCount} != approved jobs ${approvedJobs.length}`);
    }

    if (packetEvidenceCount !== (Array.isArray(evidence) ? evidence.length : 0)) {
      reasons.push(`packet evidenceCount ${packetEvidenceCount} != evidence rows ${(Array.isArray(evidence) ? evidence.length : 0)}`);
    }

    if ((timelineCounts["field_submitted"] || 0) < 1) {
      reasons.push("missing field_submitted event");
    }
    if ((timelineCounts["incident_closed"] || 0) < 1) {
      reasons.push("missing incident_closed event");
    }

    const expectedApprovedCount = Array.isArray(jobs) ? jobs.length : 0;

    if ((timelineCounts["job_approved"] || 0) < expectedApprovedCount) {
      reasons.push(`expected at least ${expectedApprovedCount} job_approved events`);
    }

    return reasons;
  }, [incident, jobs, evidence, timeline]);

  const hasFieldIssues = truthMismatchReasons.some(r =>
    r.includes("field_submitted") || r.includes("incident_closed")
  );

  const hasOnlyPacketIssues =
    truthMismatchReasons.length > 0 &&
    !hasFieldIssues;

  const truthError = truthMismatchReasons.length > 0
    ? truthMismatchReasons.join(" • ")
    : "";
  const incidentClosed = String(incidentStatus || "").trim().toLowerCase() === "closed";
  const artifactDownloadable = String(artifactHint || "").toLowerCase().includes("ready") || !!lastArtifactFilename;

  // PEAKOPS_REPORT_AUTOGEN_V1 (2026-05-01)
  // One-click Generate Report on Close-then-Summary. When the user
  // closes the incident on Review and lands here, the report is the
  // only thing left to do — auto-fire handleArtifactDownload once
  // when (a) the incident is closed, (b) no report exists yet, and
  // (c) we have orgId / incidentId / no in-flight export. The ref
  // guard prevents re-firing on tab nav or React StrictMode double
  // effects. Skip when there are field-issues that would cause a
  // 409 truth-mismatch on export — better to surface those to the
  // user than to fire-and-fail silently.
  useEffect(() => {
    if (autoGenTriggeredRef.current) return;
    if (loading) return; // wait for incident/jobs/timeline fetch
    if (!incidentClosed) return;
    if (artifactDownloadable) return;
    if (artifactBusy || downloadBusy) return;
    if (!orgId || !incidentId) return;
    // Don't auto-fire when there are real field issues — they'd
    // cause a 409 truth_mismatch and the user should see them
    // before clicking anything.
    if (Array.isArray(truthMismatchReasons) && truthMismatchReasons.length > 0) return;
    autoGenTriggeredRef.current = true;
    void handleArtifactDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, incidentClosed, artifactDownloadable, artifactBusy, downloadBusy, orgId, incidentId, truthMismatchReasons]);

  // PEAKOPS_SLICE12_2_APPROVAL_GATE_V1 (2026-05-07)
  // Slice 12.1 QA caught the closed-but-no-report fixture
  // (inc_20260429_071222_n3ss11) showing "Awaiting supervisor
  // approval" with a disabled Generate Report button — even though
  // the lifecycle was Approved/Closed and the supervisor sign-off
  // was already on the audit trail. Root cause: the prior bannerKind
  // computed `hasFieldIssues` first (timeline fixtures can be
  // missing one of field_submitted / incident_closed events), which
  // routed Approved/Closed jobs into the "error" branch and the
  // accompanying supervisorOnlyMissing logic claimed approval was
  // pending. Fix: detect "supervisor approved" from displayState
  // (which is already downgraded by the resolver if the audit event
  // is missing — see the Approved/Closed downgrade at line ~441), and
  // when supervisor approval is complete but the report hasn't been
  // generated yet, take the "info" branch ahead of hasFieldIssues.
  // Approval state and report-generation state are separate concerns
  // per the Slice 12.2 spec.
  const supervisorApproved = useMemo(() => {
    const ds = reportUiState.displayState;
    return ds === "Approved" || ds === "Closed";
  }, [reportUiState.displayState]);

  const bannerKind =
    supervisorApproved && !artifactDownloadable
      ? "info"
      : hasFieldIssues
      ? "error"
      : incidentClosed && !artifactDownloadable
      ? "info"
      : artifactDownloadable
      ? "success"
      : "";
  // PEAKOPS_SUMMARY_HUMAN_COPY_V1 (2026-04-24)
  // Translate raw backend/internal mismatch reasons into short, operational
  // copy a city/utility ops user can act on. The raw strings stay available
  // in the "Technical details" collapsible so we don't lose debug fidelity.
  const humanizedReasons = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of truthMismatchReasons) {
      const x = String(r || "").toLowerCase();
      let s = "";
      if (x.includes("unassigned")) s = "Some evidence is not attached to a task";
      else if (x.includes("field_submitted")) s = "Field report has not been submitted";
      else if (x.includes("incident_closed")) s = "Incident has not been closed";
      else if (x.includes("job_approved")) s = "Some tasks are still waiting for approval";
      else if (x.includes("evidencecount")) s = "Report evidence count is out of date — regenerate to refresh";
      else if (x.includes("jobcount")) s = "Report task count is out of date — regenerate to refresh";
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }, [truthMismatchReasons]);
  // PEAKOPS_SUMMARY_BANNER_V3 (2026-05-05)
  // Distinct banner for "field documentation complete, supervisor
  // approval pending". Detected from real lifecycle state, not from
  // truthMismatchReasons: when the canonical reportUiState says
  // Awaiting Supervisor Review (or downgraded to that from Approved
  // because the timeline lacks the audit event), the visible
  // checklist below is already complete and the missing step is
  // genuinely the supervisor's. Tells the buyer exactly what's
  // blocking the report instead of pointing them at "items below"
  // that are already green.
  // PEAKOPS_SLICE12_2_APPROVAL_GATE_V1 (2026-05-07)
  // After Slice 12.2: "supervisorOnlyMissing" now ONLY captures the
  // genuinely-pending approval states. Approved/Closed are handled
  // by the supervisorApproved branch above.
  const supervisorOnlyMissing = useMemo(() => {
    const ds = reportUiState.displayState;
    return ds === "Awaiting Supervisor Review" || ds === "Sent Back";
  }, [reportUiState.displayState]);
  const bannerIcon = bannerKind === "success" ? "✓" : bannerKind === "error" ? (supervisorOnlyMissing ? "ℹ" : "⚠") : bannerKind === "info" ? "ℹ" : "";
  const bannerTitle =
    bannerKind === "error"
      ? (supervisorOnlyMissing ? "Awaiting supervisor approval" : "A few steps left before export")
      : bannerKind === "info"
      ? (supervisorApproved
          ? "Ready to generate report"
          : "Ready to finalize the report")
      : "Job complete";
  const bannerBody =
    bannerKind === "error"
      ? (supervisorOnlyMissing
          ? "Field documentation is complete. The report can be generated after supervisor approval."
          : "Finish the items below, then return here to generate the report.")
      : bannerKind === "info"
      ? (supervisorApproved
          ? "Supervisor approval is complete. Generate the report to create the audit-ready record."
          : "All field steps are complete. Generate the report to finalize this job.")
      : lastArtifactFilename
      ? `Report ready: ${lastArtifactFilename}.`
      : "Your job report is ready. Use Download Report to save or share it.";

  // PEAKOPS_SUMMARY_POLISH_V1 (2026-04-24)
  // Purely visual pass: aligns Summary with the field/review dark+gold tokens,
  // tightens card spacing, promotes Generate Artifact to the same
  // gold-gradient primary used by NextBestAction/Mark arrived, hides dev
  // tools behind a <details> so prod UI is clean, and preserves orgId on
  // the Back button. No data, backend calls, or state logic touched.
  const bannerPalette =
    bannerKind === "error"
      ? { border: "1px solid rgba(220,60,60,0.35)", background: "rgba(220,60,60,0.08)", color: "#fca5a5" }
      : bannerKind === "info"
      ? { border: "1px solid rgba(200,168,78,0.3)", background: "rgba(200,168,78,0.08)", color: "#C8A84E" }
      : { border: "1px solid rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.08)", color: "#86efac" };
  // PEAKOPS_REPORT_AUTHED_DOWNLOAD_V1 (2026-05-01)
  // Disable the button while either the export is in flight
  // (`artifactBusy`) or the authed ZIP fetch is streaming
  // (`downloadBusy`). Distinct labels: "Downloading…" beats
  // "Preparing report…" when both flags are momentarily true.
  const artifactDisabled = artifactBusy || downloadBusy || !orgId || !incidentId;
  const artifactLabel = downloadBusy
    ? "Downloading…"
    : artifactBusy
    ? "Preparing report…"
    : artifactHint.toLowerCase().includes("ready")
    ? "Download Report"
    : artifactHint.toLowerCase().includes("building")
    ? "Report building…"
    : "Generate Report";

  // PEAKOPS_INCIDENT_NOT_FOUND_V1 (2026-04-28)
  // Clean customer-facing empty state when getIncidentV1 returns 404.
  if (incidentNotFound) {
    return (
      <main
        className="min-h-screen p-4"
        style={{
          background: "#050505",
          color: "#f5f5f5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <div style={{ maxWidth: 440, width: "100%", border: "1px solid #1c1c1c", background: "#0b0b0b", borderRadius: 12, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#6f6f6f", textTransform: "uppercase" as const }}>Not found</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginTop: 6 }}>Job not found</div>
          <div style={{ fontSize: 13, color: "#b3b3b3", marginTop: 6, lineHeight: 1.5 }}>
            This job may have been deleted, moved, or you may not have access.
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
            Back to jobs
          </button>
          {/* PEAKOPS_NOT_FOUND_DEV_GATE_V1 (2026-04-30) */}
          {devMode ? (
            <details style={{ marginTop: 18, fontSize: 10, color: "#6f6f6f", textAlign: "left" }}>
              <summary style={{ cursor: "pointer" }}>Technical details (dev only)</summary>
              <div style={{ marginTop: 6, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                <div>incidentId: {incidentId}</div>
                <div>orgId: {orgId || "(none)"}</div>
                {errUrl ? <div>endpoint: {errUrl}</div> : null}
                {errStatus ? <div>status: {errStatus}</div> : null}
                {errBody ? <div>body: {String(errBody).slice(0, 240)}</div> : null}
              </div>
            </details>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <>
      <main
        className="min-h-screen p-4 peakops-report-root"
        style={{
          background: "#050505",
          color: "#f5f5f5",
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        {/* PEAKOPS_REPORT_PRINT_V1 (2026-05-05)
            Print/share readiness. .peakops-no-print elements (back
            link, action cluster, internal-status disclosure, dev
            tools) drop out of the printed page. The dark theme
            inverts to white-bg / dark-text so screenshots and PDFs
            look like a real document. Cards keep their borders but
            shed background tint for paper. */}
        <style jsx global>{`
          @media print {
            .peakops-no-print { display: none !important; }
            .peakops-report-root,
            .peakops-report-root * {
              background: #ffffff !important;
              color: #050505 !important;
              box-shadow: none !important;
            }
            .peakops-report-root section,
            .peakops-report-root footer {
              border-color: #d4d4d8 !important;
              break-inside: avoid;
            }
            .peakops-report-root img {
              max-width: 100%;
              height: auto;
              border-color: #d4d4d8 !important;
            }
          }
        `}</style>
        <div className="max-w-6xl mx-auto space-y-3">
          {/* PEAKOPS_REPORT_HEADER_V2 (2026-05-05)
              Customer-facing report header. Replaces the older
              "Incident Summary" stack. Pulls site/location and the
              opened/closed dates straight off the incident doc; the
              status pill is sourced from the same shared
              incidentStatus helper used by Mission Control + the
              field page so all surfaces agree. The Download Report
              button is the canonical primary CTA — it routes through
              handleArtifactDownload(), which serves the cached ZIP
              when present and triggers generation otherwise. The
              Email Report button is a placeholder gated on a
              "Coming soon" tooltip; it never fires today. */}
          <section
            style={{
              borderRadius: 12,
              border: "1px solid #1c1c1c",
              background: "#0b0b0b",
              padding: "20px 22px",
            }}
          >
            <button
              type="button"
              className="peakops-no-print"
              onClick={() => router.push(`/incidents${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`)}
              title="Back to Jobs"
              style={{
                padding: "5px 10px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                border: "1px solid #1c1c1c",
                background: "#0b0b0b",
                color: "#b3b3b3",
              }}
            >
              ← Jobs
            </button>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
              <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.14em",
                    color: "#6f6f6f",
                    textTransform: "uppercase" as const,
                  }}
                >
                  {/* PEAKOPS_REPORT_HEADER_VIEW_V1 (2026-05-08) —
                      industry-aware eyebrow. Falls back to
                      "Job Report" when industry isn't set, which
                      preserves the prior look for orgs that haven't
                      completed onboarding. */}
                  {onboardingView.reportEyebrow}
                </div>
                <h1
                  style={{
                    margin: 0,
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 700,
                    color: "#f5f5f5",
                    lineHeight: 1.25,
                  }}
                  title={incidentId}
                >
                  {displayIncidentTitle(incidentId, incident as any, jobs as any)}
                </h1>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexWrap: "wrap",
                    rowGap: 4,
                    columnGap: 14,
                    fontSize: 12,
                    color: "#b3b3b3",
                    alignItems: "center",
                  }}
                >
                  {(() => {
                    const loc = String((incident as any)?.location || "").trim();
                    return loc ? <span>{loc}</span> : null;
                  })()}
                  {(() => {
                    const openedSec =
                      Number((incident as any)?.createdAt?._seconds || 0) ||
                      Number((incident as any)?.openedAt?._seconds || 0);
                    return openedSec ? <span>Opened {fmtFullDate(openedSec)}</span> : null;
                  })()}
                  {(() => {
                    const closedSec = Number((incident as any)?.closedAt?._seconds || 0);
                    return closedSec ? <span>Closed {fmtFullDate(closedSec)}</span> : null;
                  })()}
                  {/* PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
                      Header pill reads off reportUiState so it can
                      never disagree with the Generate Report enable
                      gate or the summary-strip stat tones below. */}
                  <span
                    className={"text-[10px] px-2 py-0.5 rounded-full border " + incidentStatusPill(reportUiState.displayState)}
                    style={{ fontWeight: 700, letterSpacing: "0.04em" }}
                  >
                    {reportUiState.displayState === "Awaiting Supervisor Review" ? "Awaiting Review" : reportUiState.displayState}
                  </span>
                </div>
                {/* PEAKOPS_REPORT_HEADER_VIEW_V1 (2026-05-08) —
                    Slice Start Job 1.0. Industry-aware intro
                    paragraph rendered below the meta line. Telecom +
                    municipality carry the filing-aware qualifier
                    "final filings remain your responsibility" so the
                    surface never implies auto-submission. Other
                    industries render nothing here. */}
                {onboardingView.reportIntroLine ? (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      lineHeight: 1.55,
                      color: "#9a9a9a",
                      fontStyle: "italic",
                      maxWidth: 680,
                    }}
                  >
                    {onboardingView.reportIntroLine}
                  </div>
                ) : null}
                {devMode && orgId ? (
                  <div style={{ fontSize: 10, color: "#6f6f6f", marginTop: 6 }}>
                    Org: <span style={{ color: "#b3b3b3", fontFamily: "ui-monospace, monospace" }}>{orgId}</span>
                  </div>
                ) : null}
              </div>
              <div className="peakops-no-print" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 }}>
                {(() => {
                  // PEAKOPS_REPORT_GATE_V2 (2026-05-05)
                  // Generate Report is disabled when the report is
                  // not actually ready (truth-mismatch reasons exist
                  // and the artifact hasn't been generated). The
                  // earlier gate only checked artifactBusy / downloadBusy
                  // so a buyer could see "warnings + Generate Report
                  // enabled" — a trust failure. A finished packet
                  // (artifactDownloadable) always wins: download
                  // stays available regardless.
                  const hasBlockingWarnings = bannerKind === "error" && !artifactDownloadable;
                  const downloadDisabled = artifactBusy || downloadBusy || hasBlockingWarnings;
                  const title = hasBlockingWarnings
                    ? "Resolve the warnings above to generate the report"
                    : artifactDownloadable
                      ? "Download report"
                      : "Generate the report — opens or downloads when ready";
                  return (
                    <button
                      type="button"
                      onClick={() => { if (!downloadDisabled) void handleArtifactDownload(); }}
                      disabled={downloadDisabled}
                      title={title}
                      style={{
                        padding: "11px 20px",
                        borderRadius: 8,
                        fontSize: 13,
                        fontWeight: 800,
                        letterSpacing: "0.02em",
                        cursor: downloadDisabled ? "not-allowed" : "pointer",
                        border: downloadDisabled ? "1px solid #1c1c1c" : "none",
                        background: downloadDisabled
                          ? "#101010"
                          : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
                        color: downloadDisabled ? "#6f6f6f" : "#050505",
                        boxShadow: downloadDisabled ? "none" : "0 2px 12px rgba(200,168,78,0.20)",
                      }}
                    >
                      {artifactBusy
                        ? "Preparing…"
                        : artifactDownloadable
                          ? "Download Report"
                          : "Generate Report"}
                    </button>
                  );
                })()}
                {/* PEAKOPS_EMAIL_REPORT_HIDDEN_V1 (2026-05-05)
                    The disabled "Email Report — Coming soon" button
                    used to live here. It looked like a broken
                    affordance to clients on the report page, so it's
                    hidden until the send pipeline ships. Re-introduce
                    once a feature flag (e.g. emailReportEnabled on
                    the org doc) is wired and the API endpoint is
                    real. */}
                {/* PEAKOPS_REGENERATE_GATE_V1 (2026-05-04) — admin/supervisor only */}
                {artifactDownloadable && canRegenerateReport && (
                  <button
                    type="button"
                    data-admin-only="regenerate-report"
                    disabled={artifactBusy || downloadBusy || regenerateConfirmOpen}
                    onClick={() => setRegenerateConfirmOpen(true)}
                    title="Re-export with the latest vendor and approval state"
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: artifactBusy || downloadBusy || regenerateConfirmOpen ? "not-allowed" : "pointer",
                      border: "1px solid #1c1c1c",
                      background: "transparent",
                      color: artifactBusy || downloadBusy || regenerateConfirmOpen ? "#6f6f6f" : "#b3b3b3",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {artifactBusy ? "Regenerating…" : "Regenerate"}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
              Regenerate confirm panel — relocated to top-level so it
              can sit just under the header rather than inside the
              old NBA card. Same handler, same body copy, same admin
              gate. */}
          {regenerateConfirmOpen && (
            <section
              style={{
                borderRadius: 10,
                padding: "14px 16px",
                border: "1px solid #1c1c1c",
                background: "#0b0b0b",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: "#f5f5f5" }}>
                Regenerate report?
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: "#b3b3b3", lineHeight: 1.5 }}>
                This rebuilds the report using the latest vendor/status metadata. Previous downloads will not change.
              </div>
              <div style={{ marginTop: 10 }}>
                <label
                  htmlFor="regenerate-reason"
                  style={{ display: "block", fontSize: 11, color: "#6f6f6f", letterSpacing: "0.04em", marginBottom: 4 }}
                >
                  Reason for regenerating (optional)
                </label>
                <textarea
                  id="regenerate-reason"
                  value={regenerateReason}
                  onChange={(e) => setRegenerateReason(e.target.value)}
                  placeholder="e.g. Vendor archived; updating bundle"
                  maxLength={280}
                  rows={2}
                  disabled={artifactBusy}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    fontSize: 12,
                    background: "#050505",
                    color: "#f5f5f5",
                    border: "1px solid #1c1c1c",
                    borderRadius: 6,
                    resize: "vertical",
                    fontFamily: "inherit",
                    outline: "none",
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => {
                    setRegenerateConfirmOpen(false);
                    setRegenerateReason("");
                  }}
                  disabled={artifactBusy}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    background: "transparent",
                    color: "#b3b3b3",
                    border: "1px solid #1c1c1c",
                    cursor: artifactBusy ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-admin-only="regenerate-report"
                  disabled={artifactBusy || downloadBusy}
                  onClick={() => {
                    const reasonToSend = regenerateReason.trim();
                    setRegenerateConfirmOpen(false);
                    setRegenerateReason("");
                    void handleArtifactDownload({ forceRegenerate: true, reason: reasonToSend });
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    color: artifactBusy || downloadBusy ? "#6f6f6f" : "#050505",
                    background: artifactBusy || downloadBusy ? "#1c1c1c" : "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)",
                    border: 0,
                    cursor: artifactBusy || downloadBusy ? "not-allowed" : "pointer",
                    boxShadow: artifactBusy || downloadBusy ? "none" : "0 2px 12px rgba(200,168,78,0.20)",
                  }}
                >
                  {artifactBusy ? "Regenerating…" : "Regenerate Report"}
                </button>
              </div>
            </section>
          )}

          {/* PEAKOPS_SUMMARY_NBA_REMOVED_V2 (2026-05-05)
              Old NBA card removed in the audit-ready report rebuild.
              The header card above owns the primary CTA (Download
              Report). For non-closed states the user sees the same
              status pill in the header subtitle; field actions live
              on the Field Job page itself, not on the report. */}

          {/* PEAKOPS_SUMMARY_BANNER_INSIDE_V1 (2026-04-24)
              Status banner moved inside <main> so it shares the page's
              max-width, padding, and rhythm. Uses an icon + bulleted
              humanized reasons; raw `truthError` stays in a collapsible
              for debugging. */}
          {bannerKind ? (
            <section
              style={{
                borderRadius: 10,
                padding: "14px 16px",
                ...bannerPalette,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                {bannerIcon ? (
                  <div
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 28,
                      height: 28,
                      borderRadius: 999,
                      background:
                        bannerKind === "success"
                          ? "rgba(34,197,94,0.18)"
                          : bannerKind === "error"
                          ? "rgba(220,60,60,0.18)"
                          : "rgba(200,168,78,0.18)",
                      color:
                        bannerKind === "success"
                          ? "#86efac"
                          : bannerKind === "error"
                          ? "#fca5a5"
                          : "#C8A84E",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      fontWeight: 800,
                      lineHeight: 1,
                    }}
                  >
                    {bannerIcon}
                  </div>
                ) : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{bannerTitle}</div>
                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, opacity: 0.9 }}>
                    {bannerBody}
                  </div>
                  {/* PEAKOPS_SUMMARY_HIDE_TECH_MISMATCH_V1 (2026-04-29)
                      Customer-facing copy is now a single sentence. The
                      bullet list of humanized mismatch reasons and the
                      raw "Technical details" disclosure are gated to
                      ?dev=1 (or NODE_ENV !== "production") so engineers
                      can still inspect them in QA. */}
                  {bannerKind === "error" && !devMode ? (
                    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5, opacity: 0.9 }}>
                      Report has not been generated yet.
                    </div>
                  ) : null}
                  {bannerKind === "error" && devMode && humanizedReasons.length > 0 ? (
                    <ul
                      style={{
                        marginTop: 8,
                        paddingLeft: 16,
                        fontSize: 12,
                        lineHeight: 1.6,
                        listStyle: "disc",
                      }}
                    >
                      {humanizedReasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  ) : null}
                  {bannerKind === "success" && (lastArtifactFilename || lastArtifactAt) ? (
                    <div style={{ marginTop: 6, fontSize: 11, opacity: 0.85 }}>
                      {lastArtifactFilename ? (
                        <span style={{ fontFamily: "ui-monospace, monospace" }}>
                          {lastArtifactFilename}
                        </span>
                      ) : null}
                      {lastArtifactFilename && lastArtifactAt ? " • " : ""}
                      {lastArtifactAt || ""}
                    </div>
                  ) : null}
                  {devMode && truthError ? (
                    <details style={{ marginTop: 10, fontSize: 10, color: "#6f6f6f" }}>
                      <summary style={{ cursor: "pointer" }}>Technical details (dev only)</summary>
                      <div
                        style={{
                          marginTop: 6,
                          fontFamily: "ui-monospace, monospace",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {truthError}
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {/* PEAKOPS_SUMMARY_UNASSIGNED_WARNING_V1 (2026-04-24)
              Customer-facing warning when evidence still needs to be
              assigned. The dev-only "Fix unassigned" affordance still
              lives inside the Evidence by Job section. This banner gives
              an ops user one obvious next action without exposing
              backend wording. */}
          {unassignedEvidenceCount > 0 ? (
            <section
              style={{
                borderRadius: 10,
                padding: "12px 16px",
                border: "1px solid rgba(200,168,78,0.35)",
                background: "rgba(200,168,78,0.08)",
                color: "#C8A84E",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: "rgba(200,168,78,0.18)",
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
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {unassignedEvidenceCount} evidence item
                  {unassignedEvidenceCount === 1 ? "" : "s"} need
                  {unassignedEvidenceCount === 1 ? "s" : ""} to be assigned before export.
                </div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                  Open the incident&rsquo;s Evidence tab to attach each item to a job.
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  router.push(incidentPath(incidentId, orgId, { hash: "evidence" }))
                }
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  border: "1px solid rgba(200,168,78,0.4)",
                  background: "rgba(200,168,78,0.15)",
                  color: "#C8A84E",
                  flexShrink: 0,
                }}
              >
                Assign Evidence →
              </button>
            </section>
          ) : null}

          {/* Transient banners */}
          {!err && demoAuthBypassMsg ? (
            <div
              style={{
                fontSize: 12,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(200,168,78,0.3)",
                background: "rgba(200,168,78,0.08)",
                color: "#C8A84E",
              }}
            >
              {demoAuthBypassMsg}
            </div>
          ) : null}
          {!err && artifactToast ? (
            <div
              style={{
                fontSize: 12,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(34,197,94,0.3)",
                background: "rgba(34,197,94,0.08)",
                color: "#86efac",
              }}
            >
              {artifactToast}
            </div>
          ) : null}

          {/* PEAKOPS_REPORT_SUMMARY_STRIP_V1 (2026-05-05)
              The audit-ready summary strip — replaces the older
              "Incident Status" detail card AND the collapsible
              Preview Report panel. Four read-at-a-glance metrics:
              Photos, Notes, Tasks Approved, Supervisor Approval.
              Counts are derived live from the same evidence/jobs/
              notes data the rest of the page reads from. */}
          {(() => {
            const tasksTotal = jobs.length;
            const tasksApproved = jobs.filter((j: any) => {
              const rs = String(j?.reviewStatus || "").trim().toLowerCase();
              const st = String(j?.status || "").trim().toLowerCase();
              return rs === "approved" || st === "approved";
            }).length;
            // PEAKOPS_REPORT_TASKS_COMPLETED_V2 (2026-05-05)
            // "Tasks Completed" counts both approved AND complete
            // task statuses. The earlier counter only counted
            // approved, which contradicted the per-task panel below
            // (which shows "Complete" for status === "complete").
            // Complete-but-not-yet-approved is still done work — it
            // belongs in this counter; the Supervisor Approval tile
            // tracks the stronger approval signal separately.
            const tasksCompleted = jobs.filter((j: any) => {
              const rs = String(j?.reviewStatus || "").trim().toLowerCase();
              const st = String(j?.status || "").trim().toLowerCase();
              return rs === "approved" || st === "approved" || st === "complete" || st === "review";
            }).length;
            const photosTotal = evidence.length;
            const noteText = String(notesDoc?.incidentNotes || "").trim();
            const noteSite = String(notesDoc?.siteNotes || "").trim();
            const hasNote = !!(noteText || noteSite);
            const allApproved = tasksTotal > 0 && tasksApproved === tasksTotal;
            const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "green" | "amber" | "neutral" }) => (
              <div
                style={{
                  borderRadius: 8,
                  border:
                    tone === "green" ? "1px solid rgba(34,197,94,0.30)"
                    : tone === "amber" ? "1px solid rgba(200,168,78,0.30)"
                    : "1px solid #1c1c1c",
                  background:
                    tone === "green" ? "rgba(34,197,94,0.06)"
                    : tone === "amber" ? "rgba(200,168,78,0.06)"
                    : "#0b0b0b",
                  padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.10em",
                    color: "#6f6f6f",
                    textTransform: "uppercase" as const,
                  }}
                >
                  {label}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 700,
                    color:
                      tone === "green" ? "#86efac"
                      : tone === "amber" ? "#C8A84E"
                      : "#f5f5f5",
                  }}
                >
                  {value}
                </div>
              </div>
            );
            return (
              <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                <Stat label="Photos" value={String(photosTotal)} />
                <Stat label="Notes" value={hasNote ? "Recorded" : "—"} />
                <Stat
                  label="Tasks Completed"
                  value={tasksTotal > 0 ? `${tasksCompleted} / ${tasksTotal}` : "—"}
                  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05) /
                  // PEAKOPS_REPORT_TASKS_COMPLETED_V2 (2026-05-05)
                  // Counter shows complete-or-approved tasks so it
                  // can never disagree with the per-task panel
                  // below (which renders "Complete" when status is
                  // complete). Tone snaps to green when the
                  // canonical state is Closed/Approved.
                  tone={
                    reportUiState.displayState === "Closed" || reportUiState.displayState === "Approved"
                      ? "green"
                      : tasksCompleted > 0 ? "amber" : "neutral"
                  }
                />
                <Stat
                  label="Supervisor Approval"
                  // PEAKOPS_UI_STATE_ORCHESTRATION_V1 (2026-05-05)
                  // Sourced from reportUiState — guarantees the
                  // Approved-or-better banner above never coexists
                  // with a "Pending" stat tile here. When the
                  // canonical state is Closed/Approved, this stat
                  // reads "Approved" with green tone; lower states
                  // fall through to the local task-count math.
                  value={
                    reportUiState.displayState === "Closed" || reportUiState.displayState === "Approved"
                      ? "Approved"
                      : tasksApproved > 0
                        ? "Partial"
                        : "Pending"
                  }
                  tone={
                    reportUiState.displayState === "Closed" || reportUiState.displayState === "Approved"
                      ? "green"
                      : tasksApproved > 0
                        ? "amber"
                        : "neutral"
                  }
                />
              </section>
            );
          })()}

          {/* PEAKOPS_REPORT_PREVIEW_REMOVED_V2 (2026-05-05)
              The Preview Report collapsible panel was removed in this
              rebuild. Everything it showed (status, stat strip, field
              note, tasks, timeline) now lives directly on the page as
              its own report sections — no toggle, no double-click to
              see the proof of work. */}
          {/* PEAKOPS_REPORT_TIMELINE_V2 (2026-05-05)
              Vertical timeline. Replaces the older "Timeline
              Highlights" filtered list — the report shows the full
              chronology. Events are sorted ascending so the reader
              can follow the narrative top to bottom. Labels come
              from prettyTimelineType (single source of truth across
              IncidentClient/ReviewClient/SummaryClient). */}
          {(() => {
            const sorted = (Array.isArray(timeline) ? [...timeline] : []).sort((a: any, b: any) => {
              const ax = Number(a?.occurredAt?._seconds || 0);
              const bx = Number(b?.occurredAt?._seconds || 0);
              return ax - bx;
            });
            return (
              <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "16px 18px" }}>
                <h2 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.10em", color: "#6f6f6f", textTransform: "uppercase" as const }}>
                  Timeline
                </h2>
                {sorted.length === 0 ? (
                  <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>
                    No events recorded for this job yet.
                  </div>
                ) : (
                  <ol style={{ listStyle: "none", margin: "12px 0 0", padding: 0, position: "relative" }}>
                    {sorted.map((t: any, i: number) => {
                      const ty = String(t.type || "").toLowerCase();
                      const tone =
                        ty === "incident_closed" || ty === "job_approved" || ty === "field_approved"
                          ? "#22c55e"
                          : ty === "field_submitted" || ty === "job_completed"
                            ? "#C8A84E"
                            : ty === "job_rejected"
                              ? "#fca5a5"
                              : "#6f6f6f";
                      const isLast = i === sorted.length - 1;
                      return (
                        <li
                          key={String(t.id || `${ty}_${i}`)}
                          style={{
                            position: "relative",
                            paddingLeft: 22,
                            paddingBottom: isLast ? 0 : 14,
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              position: "absolute",
                              left: 4,
                              top: 5,
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              background: tone,
                              boxShadow: "0 0 0 2px #0b0b0b",
                            }}
                          />
                          {!isLast ? (
                            <span
                              aria-hidden
                              style={{
                                position: "absolute",
                                left: 7,
                                top: 14,
                                bottom: 0,
                                width: 1,
                                background: "#1c1c1c",
                              }}
                            />
                          ) : null}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                            <div style={{ fontSize: 13, color: "#f5f5f5", fontWeight: 600 }}>
                              {prettyTimelineType(String(t.type || ""))}
                            </div>
                            <div style={{ fontSize: 11, color: "#6f6f6f", whiteSpace: "nowrap" }}>
                              {fmtFullDateTime(t?.occurredAt?._seconds) || fmtAgo(t?.occurredAt?._seconds)}
                            </div>
                          </div>
                          {(() => {
                            const who = formatActor(t?.actor);
                            if (!who) return null;
                            return (
                              <div style={{ marginTop: 2, fontSize: 11, color: "#6f6f6f" }}>
                                by {who}
                              </div>
                            );
                          })()}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            );
          })()}

          {/* PEAKOPS_REPORT_PHOTOS_V1 (2026-05-05)
              Photos grid. Single uniform grid of every photo on the
              job, click-to-enlarge in a new tab using the existing
              minted thumb URL. Replaces the per-task evidence
              accordion that used to live here — per-task photos are
              still surfaced inside the Tasks section below for
              proof-of-work association. */}
          <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.10em", color: "#6f6f6f", textTransform: "uppercase" as const }}>
                Photos
              </h2>
              <span style={{ fontSize: 11, color: "#6f6f6f" }}>
                {evidence.length} {evidence.length === 1 ? "photo" : "photos"}
              </span>
            </div>
            {evidence.length === 0 ? (
              <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>
                Add photos to show what happened on site.
              </div>
            ) : (
              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                  gap: 8,
                }}
              >
                {evidence.map((ev) => {
                  const id = String(ev.id || "");
                  const u = thumbUrl[id];
                  const fileName = String(ev?.file?.originalName || "").trim();
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { if (u) window.open(u, "_blank", "noreferrer"); }}
                      title={fileName || "View photo"}
                      style={{
                        position: "relative",
                        aspectRatio: "4 / 3",
                        borderRadius: 8,
                        overflow: "hidden",
                        border: "1px solid #1a1a1a",
                        background: "#000",
                        padding: 0,
                        cursor: u ? "pointer" : "default",
                      }}
                    >
                      {u ? (
                        <img
                          src={u}
                          alt={fileName || "Photo"}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          onLoad={() => {
                            setThumbStatusById((m) => ({ ...m, [id]: 200 }));
                            setThumbErrById((m) => ({ ...m, [id]: "" }));
                          }}
                          onError={() => { void renewThumbOnce(ev, u); }}
                        />
                      ) : (
                        <div
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 10,
                            color: "#6f6f6f",
                            textAlign: "center",
                            padding: 4,
                          }}
                        >
                          {thumbErrById[id] ? "Unavailable" : "Loading…"}
                        </div>
                      )}
                      {process.env.NODE_ENV !== "production" && thumbDebugOverlay ? (
                        <div
                          style={{
                            position: "absolute",
                            left: 4, right: 4, top: 4,
                            background: "rgba(0,0,0,0.65)",
                            color: "#a5f3fc",
                            fontSize: 9,
                            border: "1px solid rgba(103,232,249,0.3)",
                            borderRadius: 3,
                            padding: "2px 4px",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>id={id}</div>
                          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>mint={String(thumbStatusById[id] || 0)}</div>
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* PEAKOPS_REPORT_NOTES_V1 (2026-05-05)
              Notes section. Spec asks for "Field Notes" + an optional
              "Supervisor Notes" subsection. The supervisor-notes
              field doesn't exist in the data model yet — we render
              the Field Notes block today and leave the Supervisor
              Notes block as a clean empty state so the section
              reads consistently when the data ships. */}
          {(() => {
            const incidentNotesText = String(notesDoc?.incidentNotes || "").trim();
            const siteNotesText = String(notesDoc?.siteNotes || "").trim();
            const status = String(notesDoc?.notesStatus || "").trim().toLowerCase();
            const bypassReason = String(notesDoc?.notesBypassReason || "").trim();
            const hasNoteText = !!incidentNotesText || !!siteNotesText;
            const bypassed = !hasNoteText && (status === "bypassed" || !!bypassReason || notesBypassedLocal);
            return (
              <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "16px 18px" }}>
                <h2 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.10em", color: "#6f6f6f", textTransform: "uppercase" as const }}>
                  Notes
                </h2>
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#b3b3b3" }}>Field Notes</div>
                  {bypassed ? (
                    <div style={{ marginTop: 6, fontSize: 13, color: "#b3b3b3", lineHeight: 1.55 }}>
                      No additional note provided. Photos were submitted as sufficient documentation.
                    </div>
                  ) : hasNoteText ? (
                    <div style={{ marginTop: 6 }}>
                      {incidentNotesText ? (
                        <div style={{ fontSize: 13, color: "#f5f5f5", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                          {incidentNotesText}
                        </div>
                      ) : null}
                      {siteNotesText ? (
                        <div style={{ marginTop: incidentNotesText ? 10 : 0, fontSize: 12, color: "#b3b3b3", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                          <span style={{ color: "#6f6f6f", fontWeight: 600, marginRight: 6 }}>Site:</span>
                          {siteNotesText}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, fontSize: 13, color: "#6f6f6f" }}>
                      Add a short note for the supervisor.
                    </div>
                  )}
                </div>
              </section>
            );
          })()}

          {/* PEAKOPS_REPORT_TASKS_V1 (2026-05-05)
              Tasks section — per-task name, status pill, vendor (if
              assigned), and a small thumbnail strip of the photos
              attached to that task. This is the proof-of-work
              section: it answers "what did you do, and where are
              the pictures." */}
          <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.10em", color: "#6f6f6f", textTransform: "uppercase" as const }}>
                Tasks
              </h2>
              {jobs.length > 0 ? (
                <span style={{ fontSize: 11, color: "#6f6f6f" }}>
                  {jobs.length} {jobs.length === 1 ? "task" : "tasks"}
                </span>
              ) : null}
            </div>
            {jobs.length === 0 ? (
              <div style={{ marginTop: 12, fontSize: 13, color: "#6f6f6f" }}>
                No tasks recorded on this job.
              </div>
            ) : (
              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                {jobs.map((j: any) => {
                  const id = String(j?.id || j?.jobId || "");
                  const decisionRaw = String(j?.reviewStatus || "").toLowerCase() || String(j?.status || "").toLowerCase();
                  const decision =
                    decisionRaw === "approved" ? "Approved"
                      : decisionRaw === "rejected" || decisionRaw === "revision_requested" ? "Sent back"
                      : decisionRaw === "review" ? "In review"
                      : decisionRaw === "complete" ? "Complete"
                      : decisionRaw ? decisionRaw[0].toUpperCase() + decisionRaw.slice(1) : "—";
                  const photos = (evidenceByJob[id] || []) as EvidenceDoc[];
                  const _vName = String(j?.vendorName || "").trim();
                  const _vId = String(j?.vendorId || "").trim();
                  const _archived = !!_vId && archivedVendorIds.has(_vId);
                  return (
                    <div key={id} style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#050505", padding: "12px 14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ minWidth: 0, fontSize: 14, fontWeight: 600, color: "#f5f5f5" }}>
                          {String(j?.title || "Untitled task")}
                        </div>
                        <span
                          style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" as const,
                            padding: "3px 8px", borderRadius: 999,
                            border: decision === "Approved" ? "1px solid rgba(34,197,94,0.35)"
                              : decision === "Sent back" ? "1px solid rgba(220,60,60,0.35)"
                              : "1px solid #1c1c1c",
                            background: decision === "Approved" ? "rgba(34,197,94,0.10)"
                              : decision === "Sent back" ? "rgba(220,60,60,0.08)"
                              : "#0b0b0b",
                            color: decision === "Approved" ? "#86efac"
                              : decision === "Sent back" ? "#fca5a5"
                              : "#b3b3b3",
                          }}
                        >
                          {decision}
                        </span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11, color: "#6f6f6f", display: "flex", flexWrap: "wrap", gap: 10 }}>
                        {(() => {
                          const who = formatActor(j?.approvedBy);
                          return who ? <span>Approved by {who}</span> : null;
                        })()}
                        {_vName ? (
                          <span title="Service provider">
                            Vendor: <span style={{ color: "#b3b3b3" }}>{_vName}{_archived ? " (archived)" : ""}</span>
                          </span>
                        ) : null}
                        <span>{photos.length} {photos.length === 1 ? "photo" : "photos"}</span>
                      </div>
                      {photos.length > 0 ? (
                        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {photos.slice(0, 8).map((ev) => {
                            const eid = String(ev.id || "");
                            const u = thumbUrl[eid];
                            return (
                              <button
                                key={eid}
                                type="button"
                                onClick={() => { if (u) window.open(u, "_blank", "noreferrer"); }}
                                title={String(ev?.file?.originalName || "View photo")}
                                style={{
                                  width: 78,
                                  height: 58,
                                  borderRadius: 6,
                                  overflow: "hidden",
                                  border: "1px solid #1a1a1a",
                                  background: "#000",
                                  padding: 0,
                                  cursor: u ? "pointer" : "default",
                                }}
                              >
                                {u ? (
                                  <img
                                    src={u}
                                    alt={String(ev?.file?.originalName || "Photo")}
                                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                                    onLoad={() => {
                                      setThumbStatusById((m) => ({ ...m, [eid]: 200 }));
                                      setThumbErrById((m) => ({ ...m, [eid]: "" }));
                                    }}
                                    onError={() => { void renewThumbOnce(ev, u); }}
                                  />
                                ) : (
                                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#6f6f6f" }}>
                                    {thumbErrById[eid] ? "Unavailable" : "…"}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                          {photos.length > 8 ? (
                            <span style={{ fontSize: 10, color: "#6f6f6f", alignSelf: "center" }}>
                              +{photos.length - 8} more
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* PEAKOPS_SUMMARY_BREAKDOWN_ROLE_GATE_V1 (2026-04-28) /
              PEAKOPS_INTERNAL_TASK_STATUS_V1 (2026-05-05)
              Internal-only diagnostic view, gated on supervisor +
              admin roles and wrapped in `peakops-no-print` so it
              never appears on a printed/shared report. Counts feed
              off the same statusCounts the rest of the page reads
              from. */}
          {(() => {
            const role = String(authClaims?.role || "").toLowerCase();
            const isSupervisor = role === "supervisor" || role === "admin";
            if (!isSupervisor) return null;
            return (
              <section className="peakops-no-print" style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "12px 16px" }}>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, letterSpacing: "0.10em", color: "#6f6f6f", textTransform: "uppercase" as const }}>
                    Internal task status
                  </summary>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6 }}>
                    {Object.entries(statusCounts).map(([k, v]) => {
                      const label =
                        k === "open" ? "Open"
                        : k === "in_progress" ? "In Progress"
                        : k === "complete" ? "Complete"
                        : k === "review" ? "Awaiting Review"
                        : k === "approved" ? "Approved"
                        : k === "rejected" ? "Sent Back"
                        : k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");
                      return (
                        <div key={k} style={{ borderRadius: 8, border: "1px solid #1c1c1c", background: "#050505", padding: "8px 10px" }}>
                          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", color: "#6f6f6f" }}>{label}</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginTop: 2 }}>{v}</div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </section>
            );
          })()}

          {/* PEAKOPS_REPORT_DEV_TOOLS_V1 (2026-05-05)
              Dev tools (refresh thumbnails, force remint, debug
              overlay, fix unassigned) live in their own collapsed
              disclosure at the bottom of the page, gated on
              devMode. */}
          {devMode ? (
            <section className="peakops-no-print" style={{ borderRadius: 10, border: "1px dashed #1c1c1c", background: "#050505", padding: "10px 14px" }}>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 10, color: "#6f6f6f", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                  Dev tools
                </summary>
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", cursor: "pointer" }}
                    onClick={() => refreshVisibleThumbsDebounced()}
                  >
                    Refresh thumbnails
                  </button>
                  <button
                    type="button"
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", cursor: "pointer" }}
                    onClick={() => forceRemintVisibleThumbs()}
                  >
                    Force remint URLs
                  </button>
                  <button
                    type="button"
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #1c1c1c", background: "#0b0b0b", color: "#b3b3b3", cursor: "pointer" }}
                    onClick={() => setThumbDebugOverlay((v) => !v)}
                  >
                    {thumbDebugOverlay ? "Hide thumb debug" : "Show thumb debug"}
                  </button>
                  {unassignedEvidenceCount > 0 ? (
                    <button
                      type="button"
                      style={{
                        fontSize: 10,
                        padding: "3px 8px",
                        borderRadius: 4,
                        border: "1px solid rgba(200,168,78,0.3)",
                        background: "rgba(200,168,78,0.08)",
                        color: "#C8A84E",
                        fontWeight: 600,
                        cursor: fixUnassignedBusy ? "not-allowed" : "pointer",
                        opacity: fixUnassignedBusy ? 0.5 : 1,
                      }}
                      onClick={() => { void fixUnassignedEvidence(); }}
                      disabled={fixUnassignedBusy}
                    >
                      {fixUnassignedBusy ? "Fixing…" : "Fix unassigned (dev)"}
                    </button>
                  ) : null}
                </div>
                {lastArtifactFilename ? (
                  <div style={{ marginTop: 8, fontSize: 10, color: "#6f6f6f" }}>
                    Last report:{" "}
                    <span style={{ color: "#b3b3b3", fontFamily: "ui-monospace, monospace" }}>{lastArtifactFilename}</span>
                    {lastArtifactAt ? ` • ${lastArtifactAt}` : ""}
                  </div>
                ) : null}
              </details>
            </section>
          ) : null}

          {/* PEAKOPS_REPORT_FOOTER_V1 (2026-05-05)
              Footer with the certification line + a "Generated"
              timestamp. The timestamp prefers the Firestore
              packetMeta.exportedAt (ISO string from the most recent
              successful export); falls back to lastArtifactAt
              (in-memory after a download) or a dash. */}
          <footer
            style={{
              borderRadius: 10,
              border: "1px solid #1c1c1c",
              background: "transparent",
              padding: "16px 18px",
              marginTop: 4,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 12, color: "#b3b3b3", lineHeight: 1.6 }}>
              This report represents the final record of work performed.
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: "#6f6f6f", letterSpacing: "0.06em" }}>
              {(() => {
                const exported = String(incident?.packetMeta?.exportedAt || "").trim();
                if (exported) {
                  try {
                    return `Generated ${new Date(exported).toLocaleString()}`;
                  } catch {
                    return `Generated ${exported}`;
                  }
                }
                if (lastArtifactAt) return `Generated ${lastArtifactAt}`;
                return "Report has not been generated yet.";
              })()}
            </div>
          </footer>

          {loading ? <div style={{ fontSize: 11, color: "#6f6f6f", textAlign: "center" }}>Refreshing…</div> : null}
        </div>
      </main>
    </>
  );
  }
