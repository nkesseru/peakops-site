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
import { ensureDemoActor, getActorRole, getActorUid, isDemoIncident } from "@/lib/demoActor";
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";
import { normalizeIncidentStatusShared, incidentStatusLabel, incidentStatusPill } from "@/lib/incidents/incidentStatus";
import UpgradePrompt from "@/components/UpgradePrompt";
import { authedFetch } from "@/lib/apiClient";

type IncidentDoc = {
  id: string;
  title?: string;
  status?: string;
  // PEAKOPS_INCIDENT_DOC_TYPE_V2 (2026-05-18, PR 30e)
  // Surface dossier fields that were previously read via `(incident as any)`
  // — location, priority, jobType, and provenance (createdBy + createdAt).
  // Reads only; no shape change to the wire response.
  location?: string;
  priority?: string;
  jobType?: string;
  createdBy?: string;
  createdAt?: { _seconds?: number };
  updatedAt?: { _seconds?: number };
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
  // PEAKOPS_EVIDENCE_LABELS_V1 (2026-05-18, PR 30d)
  // Optional operational labels (e.g., "DAMAGE", "SAFETY"). The
  // EvidenceDoc on the wire carries this field even though we
  // previously didn't declare it here. Surfacing the first label as
  // a small overlaid chip on the tile.
  labels?: string[];
};

type TimelineDoc = {
  id: string;
  type?: string;
  actor?: string;
  refId?: string | null;
  occurredAt?: { _seconds?: number };
};

// PEAKOPS_MEMBER_IDENTITY_V1 (2026-05-18, PR 36)
// Identity record returned by listOrgMembersV1. Minimal whitelist —
// the Cloud Function strips everything else (permissions, source,
// invitedBy, audit timestamps). When displayName is populated on the
// member doc it takes precedence; otherwise the resolver falls back
// to email, then role label, then PR 35's context-safe label.
type MemberIdentity = {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
};
type MemberRegistry = Record<string, MemberIdentity>;

function getEvidenceJobId(ev: EvidenceDoc): string {
  const top = String((ev as any)?.jobId || (ev as any)?.["jobId"] || "").trim();
  if (top) return top;
  const nested = String((ev as any)?.evidence?.jobId || (ev as any)?.["evidence.jobId"] || "").trim();
  if (nested) return nested;
  const nestedJob = String((ev as any)?.job?.jobId || (ev as any)?.["job.jobId"] || "").trim();
  return nestedJob;
}

function fmtAgoIso(iso?: string) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return fmtAgo(Math.floor(ms / 1000));
}

// PEAKOPS_OPERATIONAL_LANGUAGE_V1 (2026-05-17)
// Translate raw timeline event types into operational language so the
// page reads like an incident command record, not a database dump.
//
// PEAKOPS_OPERATIONAL_LANGUAGE_V2 (2026-05-18, PR 30c)
// Optional `ctx` parameter folds in job titles and evidence labels so
// `job_approved` reads as "Supervisor approved <Job Title>" instead
// of the generic "Supervisor approved job". Falls back gracefully
// when context isn't available.
type TimelineEventContext = {
  jobTitle?: string;
  evidenceLabel?: string;
};

function prettyTimelineEvent(t?: string, ctx?: TimelineEventContext): string {
  const norm = String(t || "").trim().toLowerCase();
  const jobTitle = ctx?.jobTitle ? String(ctx.jobTitle).trim() : "";
  const evidenceLabel = ctx?.evidenceLabel ? String(ctx.evidenceLabel).trim() : "";

  // Context-aware labels first
  if (norm === "job_approved" && jobTitle) return `Supervisor approved ${jobTitle}`;
  if (norm === "job_rejected" && jobTitle) return `Supervisor rejected ${jobTitle}`;
  if (norm === "job_completed" && jobTitle) return `${jobTitle} marked complete`;
  if (norm === "evidence_added" && evidenceLabel) return `Field crew attached ${evidenceLabel}`;

  const map: Record<string, string> = {
    field_submitted: "Field crew submitted completion package",
    field_arrived: "Field crew arrived on site",
    session_started: "Field session started",
    session_completed: "Field session completed",
    job_approved: "Supervisor approved job",
    job_rejected: "Supervisor rejected job",
    job_completed: "Job marked complete",
    evidence_added: "Evidence captured and attached",
    incident_opened: "Incident opened",
    incident_closed: "Operational record closed",
    notes_saved: "Supervisor notes updated",
    material_added: "Material logged",
    debug_event: "Debug event",
  };
  if (map[norm]) return map[norm];
  if (!t) return "Event";
  return String(t)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// PEAKOPS_TIMELINE_LOOKUPS_V1 (2026-05-18, PR 30c)
// Small helpers for deriving operational interpretation from real
// timeline data. Each returns undefined when the relevant event is
// absent — UI must handle the missing case gracefully.
function findEarliestEventSeconds(timeline: Array<{ type?: string; occurredAt?: { _seconds?: number } }>, typeKey: string): number | undefined {
  const norm = typeKey.toLowerCase();
  let earliest: number | undefined;
  for (const t of timeline) {
    if (String(t.type || "").toLowerCase() !== norm) continue;
    const s = Number(t.occurredAt?._seconds || 0);
    if (s > 0 && (earliest === undefined || s < earliest)) earliest = s;
  }
  return earliest;
}

function findLatestEventSeconds(timeline: Array<{ type?: string; occurredAt?: { _seconds?: number } }>, typeKey: string): number | undefined {
  const norm = typeKey.toLowerCase();
  let latest: number | undefined;
  for (const t of timeline) {
    if (String(t.type || "").toLowerCase() !== norm) continue;
    const s = Number(t.occurredAt?._seconds || 0);
    if (s > 0 && (latest === undefined || s > latest)) latest = s;
  }
  return latest;
}

function eventIcon(t?: string): string {
  const norm = String(t || "").trim().toLowerCase();
  const map: Record<string, string> = {
    field_submitted: "📋",
    field_arrived: "✅",
    session_started: "🧑‍🔧",
    session_completed: "🏁",
    job_approved: "🛡",
    job_rejected: "❌",
    job_completed: "✓",
    evidence_added: "📸",
    incident_opened: "⚡",
    incident_closed: "🔒",
    notes_saved: "📝",
    material_added: "🧱",
    debug_event: "🧪",
  };
  return map[norm] || "•";
}

function formatDuration(secs?: number): string {
  if (!secs || secs < 0) return "—";
  if (secs < 60) return `${Math.floor(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(secs / 3600);
  const remMins = Math.floor((secs % 3600) / 60);
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(secs / 86400);
  const remHrs = Math.floor((secs % 86400) / 3600);
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

function packetButtonLabel(hint?: string, busy?: boolean): string {
  if (busy) return "Preparing Packet…";
  const h = String(hint || "").toLowerCase();
  if (h.includes("ready")) return "Download Packet";
  if (h.includes("building")) return "Packet Building…";
  return "Generate Packet";
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

// PEAKOPS_PRETTY_ACTOR_V3 (2026-05-18, PR 36)
// Now consults a member identity registry (loaded once per Summary
// refresh from listOrgMembersV1) before falling back to PR 35's
// context-safe role labels. Display priority for a UID-shaped input
// with a registry hit:
//   1. displayName + role            → "Sarah Chen · Operations Supervisor"
//   2. email + role                  → "nick@pioneercomclean.com · Operations Supervisor"
//   3. role only                     → "Operations Supervisor"
//   4. no registry hit               → PR 35 context label ("Supervisor", "Field crew", …)
// Raw 28-char UIDs and 6-char UID prefixes are NEVER displayed.
type ActorContext = {
  chainRole?: "opened" | "submitted" | "approved" | "notes";
  eventType?: string;
};

// PEAKOPS_PRETTY_ROLE_V1 (2026-05-18, PR 36)
// Translate the raw `role` value on a member doc into a display
// label. Tiered: owner → "Operations Supervisor", admin/supervisor →
// "Supervisor", field/crew/tech → "Field Crew", lead → "Field Crew
// Lead". Unknown roles get a title-cased fallback so newly-introduced
// roles still render cleanly without code changes.
function prettyRole(role?: string | null): string {
  const r = String(role || "").trim().toLowerCase();
  if (!r) return "";
  if (r === "owner") return "Operations Supervisor";
  if (r === "admin" || r === "supervisor") return "Supervisor";
  if (r === "lead" || r === "field_lead") return "Field Crew Lead";
  if (r === "field" || r === "crew" || r === "tech") return "Field Crew";
  if (r === "viewer") return "Viewer";
  return r
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function prettyActor(raw?: string, ctx?: ActorContext, registry?: MemberRegistry): string {
  const s = String(raw || "").trim();
  if (!s) return "System";
  const lower = s.toLowerCase();
  if (lower === "ui" || lower === "system") return "System";
  if (lower === "supervisor_ui" || lower === "summary_ui" || lower === "review_ui") return "Supervisor";
  if (lower === "dev-admin" || lower === "admin") return "Admin";
  if (lower.includes("@")) {
    const local = s.split("@")[0].trim();
    return local || s;
  }
  // UID-shaped — try the registry first, then context-safe fallback.
  // Also covers pending_* invitee UIDs which exist in some orgs.
  if (/^[A-Za-z0-9]{20,}$/.test(s) || /^pending_/i.test(s)) {
    const member = registry?.[s];
    if (member) {
      const name = String(member.displayName || "").trim();
      const email = String(member.email || "").trim();
      const roleLabel = prettyRole(member.role);
      const roleSuffix = roleLabel ? ` · ${roleLabel}` : "";
      if (name) return name + roleSuffix;
      if (email) return email + roleSuffix;
      if (roleLabel) return roleLabel;
    }
    // No registry hit — PR 35 context-safe fallback.
    if (ctx?.chainRole === "opened") return "Operations";
    if (ctx?.chainRole === "submitted") return "Field crew";
    if (ctx?.chainRole === "approved") return "Supervisor";
    if (ctx?.chainRole === "notes") return "Notes author";
    const t = String(ctx?.eventType || "").toLowerCase();
    if (t === "job_approved" || t === "job_rejected" || t === "incident_closed") return "Supervisor";
    if (t === "field_submitted" || t === "field_arrived" || t === "session_started" || t === "session_completed" || t === "evidence_added") return "Field crew";
    if (t === "notes_saved") return "Notes author";
    if (t === "incident_opened") return "Operations";
    return "Internal user";
  }
  // Snake/underscore/dash forms get title-cased.
  if (/[_-]/.test(s)) {
    return s
      .replace(/[_-]/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s;
}

// PEAKOPS_FMT_ABSOLUTE_V1 (2026-05-18, PR 35)
// Audit-grade absolute timestamp formatter. Browser-local timezone
// (Intl.DateTimeFormat). Example: "May 8, 2026 · 14:14 PDT". Used
// in the chain of accountability section + operational facts where
// audit value of absolute time outweighs the relative-ago glance.
function fmtAbsolute(sec?: number): string {
  if (!sec) return "—";
  try {
    const d = new Date(sec * 1000);
    if (!Number.isFinite(d.getTime())) return "—";
    const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value || "";
    return `${date} · ${time}${tz ? " " + tz : ""}`;
  } catch {
    return "—";
  }
}
function fmtAbsoluteIso(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return fmtAbsolute(Math.floor(ms / 1000));
}

// PEAKOPS_PRETTY_INTEGRITY_REASON_V1 (2026-05-18, PR 30d)
// Translate the raw integrity-check strings (emitted by the
// truthMismatchReasons computation in this same file) into
// supervisor-readable copy. Falls back to the raw string when no
// pattern matches — defensive against future reason strings.
function prettyIntegrityReason(raw: string): string {
  const s = String(raw || "").trim();

  let m = s.match(/^packet\s+jobCount\s+(\d+)\s+!=\s+approved\s+jobs\s+(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return `Export packet shows ${a} ${a === 1 ? "job" : "jobs"}, but ${b} ${b === 1 ? "is" : "are"} actually approved. Regenerate the packet to refresh.`;
  }

  m = s.match(/^packet\s+evidenceCount\s+(\d+)\s+!=\s+evidence\s+rows\s+(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return `Export packet shows ${a} ${a === 1 ? "piece" : "pieces"} of evidence, but ${b} ${b === 1 ? "is" : "are"} attached. Regenerate the packet to refresh.`;
  }

  if (/^missing\s+field_submitted\s+event$/i.test(s)) {
    return "No field submission event recorded. Verify the field crew completed and submitted the package.";
  }

  if (/^missing\s+incident_closed\s+event$/i.test(s)) {
    return "Operational record has not been closed yet.";
  }

  // PEAKOPS_PRETTY_INTEGRITY_REASON_V2 (2026-05-18, PR 30e)
  // New rule emitted by truthMismatchReasons when packetMeta is absent
  // but the record has approved jobs or evidence. Differentiates
  // "never exported" from the prior "regenerate to refresh" copy.
  if (/^packet\s+not\s+yet\s+generated$/i.test(s)) {
    return "Export packet hasn't been generated yet for this operational record.";
  }

  // PEAKOPS_PRETTY_INTEGRITY_REASON_V2 (2026-05-18, PR 30e)
  // Replaces the prior "expected at least N job_approved events" hard
  // threshold with a job-derived check. The approval is recorded on
  // the job itself; the gap is that the audit timeline lacks the
  // corresponding event. Copy reflects that nuance so it doesn't
  // contradict the readiness strip's ✓ "Supervisor approval complete".
  m = s.match(/^(\d+)\s+approved\s+jobs?\s+missing\s+approval\s+timeline\s+events?$/i);
  if (m) {
    const n = Number(m[1]);
    return `${n} approved ${n === 1 ? "job is" : "jobs are"} missing an approval timeline event. The approval is recorded on the job, but the audit timeline doesn't show it — investigate before delivery.`;
  }

  m = s.match(/^expected\s+at\s+least\s+(\d+)\s+job_approved\s+events$/i);
  if (m) {
    const expected = Number(m[1]);
    return `Fewer supervisor approvals are recorded than expected for this incident (expected at least ${expected}). Verify whether additional approval is needed before delivery.`;
  }

  return s;
}

// PEAKOPS_COMPOSE_JOBS_PROSE_V1 (2026-05-18, PR 30d)
// One-line operational summary of jobs status, replacing the chip
// dump. Deterministic — derives only from statusCounts.
type StatusCountsLike = Record<string, number>;
function composeJobsProse(statusCounts: StatusCountsLike, totalJobs: number): string {
  if (totalJobs === 0) return "No jobs recorded yet.";
  const approved = Number(statusCounts.approved || 0);
  const rejected = Number(statusCounts.rejected || 0);
  const remaining = totalJobs - approved - rejected;
  let core: string;
  if (approved === totalJobs) {
    core = `All ${totalJobs} ${totalJobs === 1 ? "job is" : "jobs are"} approved.`;
  } else if (approved > 0 && remaining > 0) {
    core = `${approved} of ${totalJobs} jobs approved · ${remaining} still ${remaining === 1 ? "needs" : "need"} review.`;
  } else if (approved === 0 && remaining > 0) {
    core = `${totalJobs} ${totalJobs === 1 ? "job" : "jobs"} awaiting approval.`;
  } else {
    core = `${approved} of ${totalJobs} jobs approved.`;
  }
  if (rejected > 0) {
    core = core.replace(/\.$/, "") + ` · ${rejected} ${rejected === 1 ? "was" : "were"} rejected.`;
  }
  return core;
}

// PEAKOPS_COMPOSE_OPERATIONAL_SUMMARY_V1 (2026-05-18, PR 30d)
// One-sentence operational summary rendered just below the
// masthead. Deterministic composition from real state — no AI,
// no scoring, no inference beyond simple counting.
function composeOperationalSummary(args: {
  jobsTotal: number;
  jobsApproved: number;
  evidenceCount: number;
  attentionCount: number;
  packetStatus: "ready" | "building" | "stale" | "pending";
  inProgress: boolean;
}): string {
  const { jobsTotal, jobsApproved, evidenceCount, attentionCount, packetStatus, inProgress } = args;

  const parts: string[] = [];

  if (jobsTotal === 0) {
    parts.push("No jobs recorded yet.");
  } else if (evidenceCount === 0 && jobsApproved > 0) {
    // PEAKOPS_OPERATIONAL_SUMMARY_NO_EVIDENCE_V1 (2026-05-18, PR 30e)
    // Approved jobs with zero evidence is a confidence problem the
    // earlier summary missed — it celebrated "All approved" and only
    // mentioned the evidence gap as a side count. Lead with the gap
    // so a supervisor reading the first clause doesn't get false
    // reassurance.
    if (jobsApproved === jobsTotal) {
      parts.push(
        jobsTotal === 1
          ? "The approved job has no evidence attached — verify before delivery."
          : `The ${jobsTotal} approved jobs have no evidence attached — verify before delivery.`
      );
    } else {
      parts.push(`${jobsApproved} of ${jobsTotal} jobs approved; no evidence attached — verify before delivery.`);
    }
  } else if (jobsApproved === jobsTotal) {
    parts.push(`All ${jobsTotal} ${jobsTotal === 1 ? "job" : "jobs"} approved with ${evidenceCount} ${evidenceCount === 1 ? "piece" : "pieces"} of evidence attached.`);
  } else if (jobsApproved > 0) {
    parts.push(`${jobsApproved} of ${jobsTotal} jobs approved with ${evidenceCount} ${evidenceCount === 1 ? "piece" : "pieces"} of evidence attached.`);
  } else {
    parts.push(`${jobsTotal} ${jobsTotal === 1 ? "job" : "jobs"} awaiting approval; ${evidenceCount} ${evidenceCount === 1 ? "piece" : "pieces"} of evidence attached.`);
  }

  if (attentionCount > 0) {
    parts.push(`${attentionCount} readiness ${attentionCount === 1 ? "item needs" : "items need"} review before delivery.`);
  } else if (packetStatus === "ready") {
    parts.push("Export packet is ready.");
  } else if (packetStatus === "building") {
    parts.push("Export packet is building.");
  } else if (packetStatus === "stale") {
    parts.push("Export packet is older than the latest activity — regenerate before delivery.");
  } else if (inProgress) {
    parts.push("Operational record is in progress.");
  } else {
    parts.push("Export packet pending.");
  }

  return parts.join(" ");
}

// PEAKOPS_PRIMARY_CTA_V1 (2026-05-18, PR 30d)
// Decide what the Export Packet primary CTA should read + do.
// Mode "review" scrolls to #integrity; "download"/"regenerate"/
// "generate" each invoke the existing handleArtifactDownload (no
// new backend behavior — label change only).
type PrimaryCtaMode = "review" | "download" | "regenerate" | "generate" | "building" | "disabled";
function composePrimaryCta(args: {
  attentionCount: number;
  packetStatus: "ready" | "building" | "stale" | "pending";
  artifactBusy: boolean;
  hasOrgAndIncident: boolean;
  hasErr: boolean;
}): { label: string; mode: PrimaryCtaMode } {
  if (args.artifactBusy) return { label: "Preparing Packet…", mode: "building" };
  if (!args.hasOrgAndIncident || args.hasErr) return { label: "Generate Packet", mode: "disabled" };
  if (args.attentionCount > 0) return { label: "Review attention items", mode: "review" };
  if (args.packetStatus === "stale") return { label: "Regenerate Packet", mode: "regenerate" };
  if (args.packetStatus === "ready") return { label: "Download Packet", mode: "download" };
  if (args.packetStatus === "building") return { label: "Packet Building…", mode: "building" };
  return { label: "Generate Packet", mode: "generate" };
}

export default function SummaryClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const functionsBase = getFunctionsBase();
  useEffect(() => {
    warnFunctionsBaseIfSuspicious(functionsBase);
  }, [functionsBase]);
  // PEAKOPS_SUMMARY_ORG_FROM_URL_V1 (2026-05-15)
  // orgId comes from the URL's `?orgId=...` searchParam, mirroring
  // the PR #16/#23 pattern for Notes/IncidentClient. The previous
  // hardcode (`"riverbend-electric"`) caused every getIncidentV1 /
  // listJobsV1 / exportIncidentPacketV1 call to be evaluated
  // against the wrong org's membership doc — server returns 403,
  // export remains blocked. Empty string when missing.
  const sp = useSearchParams();
  const orgId = String(sp?.get("orgId") || "").trim();
  const functionsBaseIsLocal = useMemo(() => {
    try {
      const host = String(new URL(String(functionsBase || "")).hostname || "").toLowerCase();
      return host === "127.0.0.1" || host === "localhost";
    } catch {
      return false;
    }
  }, [functionsBase]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errUrl, setErrUrl] = useState("");
  const [errStatus, setErrStatus] = useState<number | null>(null);
  const [errBody, setErrBody] = useState("");
  const [incident, setIncident] = useState<IncidentDoc | null>(null);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);
  // PEAKOPS_MEMBER_REGISTRY_V1 (2026-05-18, PR 36)
  // UID → MemberIdentity map populated once per refresh from
  // listOrgMembersV1. Endpoint failures are non-fatal — the resolver
  // falls back to PR 35's context-safe labels gracefully.
  const [memberRegistry, setMemberRegistry] = useState<MemberRegistry>({});
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
  const [upgrade, setUpgrade] = useState<{
    open: boolean;
    reason: string;
    featureKey: string;
  }>({ open: false, reason: "", featureKey: "" });
  const [fixUnassignedBusy, setFixUnassignedBusy] = useState(false);
  const [artifactHint, setArtifactHint] = useState("Artifact not generated yet.");
  const [artifactToast, setArtifactToast] = useState("");
  const [lastArtifactFilename, setLastArtifactFilename] = useState("");
  const [lastArtifactAt, setLastArtifactAt] = useState("");
  const [, setArtifactUrl] = useState("");
  const [, setArtifactReady] = useState(false);
  const isDemoMode = isDemoIncident(incidentId);
  const [demoAuthBypassMsg, setDemoAuthBypassMsg] = useState("");
  const [activeOrgId, setActiveOrgId] = useState(orgId);
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
    // PEAKOPS_TIMELINE_HIGHLIGHTS_V2 (2026-05-18, PR 30e)
    // Include `notes_saved` so supervisor notes activity stops being
    // invisible. PR #33 surfaced this gap: incidents whose only
    // activity was notes saves would render "No recorded events yet"
    // beneath the "Audit-traceable record of every operational
    // milestone" caption — a contradiction.
    const interesting = new Set([
      "job_completed",
      "job_approved",
      "job_rejected",
      "incident_closed",
      "field_submitted",
      "evidence_added",
      "notes_saved",
    ]);
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
    // PEAKOPS_SUMMARY_MISSING_ORG_GUARD_V1 (2026-05-15)
    // Short-circuit when no orgId is in the URL. Mirrors the
    // IncidentClient guard in PR #24. Without this, refresh()
    // would fire its 4-call fan-out with empty orgId and surface
    // 400 errors. The component renders a safe missing-org panel
    // below in that case, so suppressing the network noise here
    // keeps DevTools clean.
    if (!orgId && !activeOrgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    setErrUrl("");
    setErrStatus(null);
    setErrBody("");
    setDemoAuthBypassMsg("");
    try {
      let requestOrgId = String(activeOrgId || orgId || "").trim();
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

      // PEAKOPS_MEMBER_FETCH_V1 (2026-05-18, PR 36)
      // Identity resolver registry. Wrapped in its own try/catch so a
      // listOrgMembersV1 failure (e.g., function not yet deployed,
      // 403 for a non-member) doesn't break the page — the resolver
      // falls back to PR 35's context-safe labels in that case.
      try {
        const memUrl = `/api/fn/listOrgMembersV1?orgId=${encodeURIComponent(requestOrgId)}`;
        const memRes = await authedFetch(memUrl, { headers: demoHeaders });
        if (memRes.ok) {
          const memTxt = await memRes.text();
          const memJson = memTxt ? JSON.parse(memTxt) : {};
          if (memJson?.ok && Array.isArray(memJson.docs)) {
            const map: MemberRegistry = {};
            for (const m of memJson.docs as MemberIdentity[]) {
              if (m?.uid) map[String(m.uid)] = m;
            }
            setMemberRegistry(map);
          }
        }
      } catch {
        // Silent fallback. PR 35 context labels remain available.
      }

      const packetMeta: any = inc?.doc?.packetMeta || {};
      const packetStatus = String(packetMeta?.status || "").toLowerCase();
      const packetBucket = String(packetMeta?.bucket || packetMeta?.packetBucket || "").trim();
      const packetStoragePath = String(packetMeta?.storagePath || packetMeta?.packetStoragePath || "").trim();
      const packetDownloadUrl = String(packetMeta?.downloadUrl || "").trim();

      let maybeArtifact = "";
      if (packetDownloadUrl) {
        maybeArtifact = packetDownloadUrl;
      } else if (packetBucket && packetStoragePath) {
        maybeArtifact =
          `/api/media?bucket=${encodeURIComponent(packetBucket)}` +
          `&path=${encodeURIComponent(packetStoragePath)}&download=1`;
      } else {
        maybeArtifact =
          `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(requestOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
      }

      if (packetStatus === "ready" && maybeArtifact) {
        setArtifactUrl(maybeArtifact);
        setArtifactHint("Artifact ready to download.");
        setArtifactReady(true);
      } else if (packetStatus === "building") {
        setArtifactUrl("");
        setArtifactHint("Artifact is building. Try again shortly.");
        setArtifactReady(false);
      } else {
        setArtifactUrl("");
        setArtifactHint("No artifact yet. Click Artifact to generate it.");
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
    } finally {
      setLoading(false);
    }
  }

  

  async function handleArtifactDownload() {
    if (!activeOrgId || !incidentId) return;
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
        }),
      });

      const exportTxt = await exportRes.text();
      const out = exportTxt ? JSON.parse(exportTxt) : {};

      // PEAKOPS_ENTITLEMENT_GATE_V1 (2026-05-13)
      // Sprint 1: surface UpgradePrompt for 402 (entitlement-denied)
      // responses from exportIncidentPacketV1. Return early so the
      // generic failure path below does not fire alongside.
      if (exportRes.status === 402) {
        setUpgrade({
          open: true,
          reason: String(out?.error || ""),
          featureKey: String(out?.featureKey || "riskDefenseModule"),
        });
        return;
      }

      if (!exportRes.ok || !out?.ok) {
        throw new Error(out?.error || `exportIncidentPacketV1 failed (${exportRes.status})`);
      }

      const bucket = String(
        out?.bucket ||
        out?.packetBucket ||
        out?.packetMeta?.bucket ||
        out?.packetMeta?.packetBucket ||
        ""
      ).trim();

      const storagePath = String(
        out?.storagePath ||
        out?.packetStoragePath ||
        out?.packetMeta?.storagePath ||
        out?.packetMeta?.packetStoragePath ||
        ""
      ).trim();

      const directUrl = String(
        out?.downloadUrl ||
        out?.packetMeta?.downloadUrl ||
        ""
      ).trim();

      const filename =
        String(out?.filename || "").trim() ||
        (storagePath ? String(storagePath).split("/").pop() || "" : "") ||
        `incident_${incidentId}_packet.zip`;

      let href = directUrl;
      if (!href && bucket && storagePath) {
        href =
          `/api/media?bucket=${encodeURIComponent(bucket)}` +
          `&path=${encodeURIComponent(storagePath)}&download=1`;
      }
      if (!href) {
        href =
          `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(activeOrgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
      }

      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setArtifactUrl(href);
      setArtifactReady(true);
      setLastArtifactFilename(filename);
      setLastArtifactAt(new Date().toLocaleString());
      setArtifactHint("Artifact ready to download.");
      setArtifactToast(`Artifact downloaded: ${filename}`);

      setTimeout(() => {
        void refresh().catch(() => {});
      }, 600);
    } catch (e: any) {
      setErr(String(e?.message || e || "artifact download failed"));
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
      const filename = String(out?.filename || `incident_${incidentId}.zip`);
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
      setArtifactToast(`Artifact downloaded: ${filename}`);
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
      // PEAKOPS_NO_POST_SIGN_CACHEBUST_V1 (2026-05-15)
      // Use the minted GCS signed URL as-is; appending a cache-buster
      // here voids the V4 signature (see signedThumb.ts for details).
      const fresh = out.url;
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
    // PEAKOPS_TRUTH_PACKET_EXISTENCE_V1 (2026-05-18, PR 30e)
    // Distinguish "packet has never been exported" from "packet
    // exported but stale". Without this, the page emits "Regenerate
    // the packet to refresh" copy when no packet exists, which is
    // misleading and undermines trust in the integrity panel.
    const hasPacket = !!String(packetMeta?.exportedAt || "").trim();

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

    const evidenceLen = Array.isArray(evidence) ? evidence.length : 0;

    if (hasPacket) {
      if (packetJobCount !== approvedJobs.length) {
        reasons.push(`packet jobCount ${packetJobCount} != approved jobs ${approvedJobs.length}`);
      }
      if (packetEvidenceCount !== evidenceLen) {
        reasons.push(`packet evidenceCount ${packetEvidenceCount} != evidence rows ${evidenceLen}`);
      }
    } else if (approvedJobs.length > 0 || evidenceLen > 0) {
      reasons.push("packet not yet generated");
    }

    if ((timelineCounts["field_submitted"] || 0) < 1) {
      reasons.push("missing field_submitted event");
    }
    if ((timelineCounts["incident_closed"] || 0) < 1) {
      reasons.push("missing incident_closed event");
    }

    // PEAKOPS_TRUTH_JOB_APPROVAL_V1 (2026-05-18, PR 30e)
    // Replaces the prior hard-coded "expected at least 2 job_approved
    // events" threshold. The new rule is derived from real jobs: if
    // there are more approved jobs than approval events in the audit
    // timeline, surface the gap. This eliminates the contradiction
    // PR #33's audit found (readiness ✓ "Supervisor approval complete"
    // alongside ⚠ "fewer approvals than expected") when a single
    // approved job has no `job_approved` timeline event.
    const jobApprovedEventCount = timelineCounts["job_approved"] || 0;
    if (approvedJobs.length > 0 && jobApprovedEventCount < approvedJobs.length) {
      const missing = approvedJobs.length - jobApprovedEventCount;
      reasons.push(`${missing} approved ${missing === 1 ? "job" : "jobs"} missing approval timeline ${missing === 1 ? "event" : "events"}`);
    }

    return reasons;
  }, [incident, jobs, evidence, timeline]);

  const truthError = truthMismatchReasons.length > 0
    ? truthMismatchReasons.join(" • ")
    : "";

  // PEAKOPS_SUMMARY_MISSING_ORG_GUARD_V1 (2026-05-15)
  // Safe missing-org panel. Renders instead of the main UI when
  // the URL has no `?orgId=...` query param. The mirror guard in
  // refresh() above prevents any /api/fn/* network calls from
  // firing while this panel is shown.
  if (!orgId && !activeOrgId) {
    return (
      <main className="min-h-screen bg-black text-white p-6">
        <div className="max-w-2xl mx-auto rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5">
          <div className="text-sm text-amber-100 font-semibold">Summary unavailable</div>
          <div className="mt-2 text-sm text-amber-50/90">
            The incident summary page needs an <code className="px-1 py-0.5 rounded bg-white/10">orgId</code> in the URL to load.
          </div>
          <div className="mt-3 text-xs text-amber-100/80">
            Open this summary from the Incident page, or include{" "}
            <code className="px-1 py-0.5 rounded bg-white/10">?orgId=&lt;your-org-id&gt;</code> in the URL.
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      <UpgradePrompt
        open={upgrade.open}
        featureKey={upgrade.featureKey}
        reason={upgrade.reason}
        orgId={orgId}
        onClose={() => setUpgrade((s) => ({ ...s, open: false }))}
      />
    <main className="min-h-screen bg-black text-white py-8 sm:py-12">
      {/* PEAKOPS_DOSSIER_CONTAINMENT_V1 (2026-05-18, PR 30c)
          Outer dossier shell. A single subtle bordered surface with
          a faint top-down gradient and ambient shadow makes the page
          read as "one incident record contained in space" rather
          than a stack of floating sections on black. */}
      <div className="max-w-3xl mx-auto px-3 sm:px-4">
        <div className="rounded-2xl border border-white/[0.05] bg-gradient-to-b from-white/[0.018] via-white/[0.005] to-transparent px-6 sm:px-9 py-9 sm:py-12 space-y-10 shadow-[0_10px_60px_rgba(0,0,0,0.55)]">
        {/* PEAKOPS_SUMMARY_DOSSIER_MASTHEAD_V1 (2026-05-17)
            Operational record header. Replaces the previous "Incident
            Summary · {incidentId}" line + Back button + full-bleed
            red truthError banner. The integrity check still fires;
            its visual aggression is downgraded to an inline amber
            chip linked to an expandable detail block below. */}
        <header className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
            Incident Record{orgId ? ` · ${orgId}` : ""}
          </div>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-white">
            {incident?.title || incidentId}
          </h1>
          {/* PEAKOPS_DOSSIER_LOCATION_V1 (2026-05-18, PR 30e)
              Surfaces incident.location directly under the title when
              present. Quiet weight, no icon — the dossier voice should
              feel like a printed operational record header. */}
          {incident?.location ? (
            <div className="text-[12px] text-gray-300">{incident.location}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-gray-400">
            <span className={"text-[11px] px-2 py-0.5 rounded-full border " + incidentStatusPill(incident?.status || incidentStatus)}>
              {incidentStatusLabel(incident?.status || incidentStatus)}
            </span>
            <span className="text-white/20">·</span>
            <span>{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</span>
            <span className="text-white/20">·</span>
            <span>{evidence.length} {evidence.length === 1 ? "piece of evidence" : "pieces of evidence"}</span>
            {/* PEAKOPS_LAST_ACTIVITY_V1 (2026-05-18, PR 30e)
                Last activity = max(incident.updatedAt, latest timeline
                event). PR #33 audit caught that notes saves don't bump
                the incident root doc's updatedAt, leaving the masthead
                "updated 10d" stale while real activity was minutes ago.
                Timeline is sorted desc on load (refresh() line ~572),
                so timeline[0] is the most recent event. */}
            {(() => {
              const updatedSec = Number(incident?.updatedAt?._seconds || 0);
              const latestEventSec = Number(timeline[0]?.occurredAt?._seconds || 0);
              const lastActivitySec = Math.max(updatedSec, latestEventSec);
              return lastActivitySec > 0 ? (
                <>
                  <span className="text-white/20">·</span>
                  <span>last activity {fmtAgo(lastActivitySec)}</span>
                </>
              ) : null;
            })()}
            {incident?.packetMeta?.exportedAt ? (
              <>
                <span className="text-white/20">·</span>
                <span>last exported {fmtAgoIso(incident.packetMeta.exportedAt)}</span>
              </>
            ) : null}
            {truthError ? (
              <>
                <span className="text-white/20">·</span>
                <a
                  href="#integrity"
                  className="text-amber-200/80 hover:text-amber-100 text-[11px] underline-offset-2 hover:underline"
                >
                  Attention needed · {truthMismatchReasons.length} item{truthMismatchReasons.length === 1 ? "" : "s"}
                </a>
              </>
            ) : null}
          </div>
          {/* PEAKOPS_PROVENANCE_V1 (2026-05-18, PR 30e)
              Quiet "Opened by {actor} · {Xd ago}" line. Builds dossier
              authority — a real operational record always names its
              author. Uses prettyActor so we never display the raw
              28-char Firebase UID. */}
          {incident?.createdBy && incident?.createdAt?._seconds ? (
            <div className="text-[11px] text-gray-500">
              Opened by {prettyActor(incident.createdBy, { chainRole: "opened" }, memberRegistry)} · {fmtAbsolute(incident.createdAt._seconds)}
            </div>
          ) : null}
          <div className="pt-1">
            <button
              type="button"
              className="text-[12px] text-gray-400 hover:text-gray-200 underline-offset-2 hover:underline"
              onClick={() => router.push(`/incidents/${incidentId}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`)}
            >
              ← Back to incident
            </button>
          </div>
        </header>

        {/* Integrity detail — collapsed amber block linked from masthead chip */}
        {truthError ? (
          <details
            id="integrity"
            className="group rounded-lg border border-amber-400/20 bg-amber-500/5 px-4 py-3"
          >
            <summary className="cursor-pointer text-[12px] font-medium text-amber-200/90 list-none flex items-center justify-between">
              <span>Attention needed · {truthMismatchReasons.length} item{truthMismatchReasons.length === 1 ? "" : "s"} to review</span>
              <span className="text-[11px] text-amber-300/60 group-open:hidden">Show details</span>
              <span className="text-[11px] text-amber-300/60 hidden group-open:inline">Hide</span>
            </summary>
            <div className="mt-3 text-[12px] text-amber-100/85 space-y-1.5">
              {truthMismatchReasons.map((r, i) => (
                <div key={i}>· {prettyIntegrityReason(r)}</div>
              ))}
              <div className="pt-2 text-[11px] text-amber-200/60">
                Review the items above before exporting this operational packet.
              </div>
              {/* PEAKOPS_INTEGRITY_RAW_DETAILS_V1 (2026-05-18, PR 30d)
                  Raw technical reasons available for engineers / auditors
                  behind a nested disclosure. Default visible copy stays
                  in operational language. */}
              <details className="pt-2">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-amber-300/50 hover:text-amber-200/70 list-none">
                  Show raw technical detail
                </summary>
                <ul className="mt-1.5 text-[11px] text-amber-200/60 font-mono space-y-0.5">
                  {truthMismatchReasons.map((r, i) => (
                    <li key={i}>· {r}</li>
                  ))}
                </ul>
              </details>
            </div>
          </details>
        ) : null}

        {/* Refresh error — calm inline strip with expandable technicalia */}
        {err ? (
          <details
            className="rounded-lg border border-red-400/20 bg-red-500/5 px-4 py-2.5"
            open={process.env.NODE_ENV !== "production"}
          >
            <summary className="cursor-pointer text-[12px] text-red-100/85 list-none flex items-center justify-between gap-3">
              <span className="truncate">Couldn&apos;t load some data — {err}</span>
              <span className="text-[11px] text-red-300/60 shrink-0">Technical details</span>
            </summary>
            <div className="mt-2 space-y-1 text-[11px] text-red-200/80">
              {errUrl ? <div className="break-all">Request: {errUrl}</div> : null}
              {errStatus ? <div>Status: {errStatus}</div> : null}
              {errBody ? <pre className="whitespace-pre-wrap break-words">{String(errBody).slice(0, 500)}</pre> : null}
              {process.env.NODE_ENV !== "production" ? (
                <div className="break-all">
                  baseDebug: {(() => {
                    const d = getFunctionsBaseDebugInfo();
                    return `env=${d.envBase || "(unset)"} override=${d.overrideBase || "(unset)"} active=${d.activeBase || "(unset)"}`;
                  })()}
                </div>
              ) : null}
              {process.env.NODE_ENV !== "production" && getEnvFunctionsBase() ? (
                <div>envBase present, fallback disabled</div>
              ) : null}
              {process.env.NODE_ENV !== "production" && (functionsBaseIsLocal || isDemoMode) ? (
                <button
                  type="button"
                  className="mt-2 px-2 py-1 rounded border border-red-300/30 bg-black/30 hover:bg-black/50 text-[11px]"
                  onClick={() => {
                    clearRememberedFunctionsBase();
                    location.reload();
                  }}
                >
                  Reset connection
                </button>
              ) : null}
            </div>
          </details>
        ) : null}

        {/* Quiet status messages (replaces the old amber/emerald pill cards) */}
        {!err && demoAuthBypassMsg ? (
          <div className="text-[12px] text-amber-200/85 italic">{demoAuthBypassMsg}</div>
        ) : null}
        {!err && artifactToast ? (
          <div className="text-[12px] text-emerald-200/85">{artifactToast}</div>
        ) : null}

        {/* PEAKOPS_OPERATIONAL_SUMMARY_V1 (2026-05-18, PR 30d)
            One deterministic sentence describing the operational
            state of the record. Composed from real counts only —
            no AI, no scoring, no inference. Reads as the first
            line a supervisor needs to scan to know what's going
            on. */}
        {(() => {
          const jobsApproved = jobs.filter((j: any) => {
            const rs = String(j?.reviewStatus || "").toLowerCase();
            const st = String(j?.status || "").toLowerCase();
            return rs === "approved" || st === "approved";
          }).length;
          const packetStatusRaw = String(incident?.packetMeta?.status || "").toLowerCase();
          const packetReady = packetStatusRaw === "ready";
          const packetBuilding = packetStatusRaw === "building";
          // PEAKOPS_PACKET_STALENESS_V1 (2026-05-18, PR 30d)
          // Stale only if exportedAt is more than 1 hour older than
          // incident.updatedAt — 1-hour grace per user decision.
          const exportedAtMs = incident?.packetMeta?.exportedAt
            ? Date.parse(incident.packetMeta.exportedAt)
            : NaN;
          const updatedAtSec = Number((incident as any)?.updatedAt?._seconds || 0);
          const updatedAtMs = updatedAtSec ? updatedAtSec * 1000 : 0;
          const packetStale =
            Number.isFinite(exportedAtMs) &&
            updatedAtMs > 0 &&
            updatedAtMs - exportedAtMs > 60 * 60 * 1000;
          const packetStatusKey: "ready" | "building" | "stale" | "pending" =
            packetReady && packetStale
              ? "stale"
              : packetReady
              ? "ready"
              : packetBuilding
              ? "building"
              : "pending";
          const inProgress = String(incident?.status || "").toLowerCase() === "in_progress" ||
            String(incidentStatus || "").toLowerCase() === "in_progress";
          const summary = composeOperationalSummary({
            jobsTotal: jobs.length,
            jobsApproved,
            evidenceCount: evidence.length,
            attentionCount: truthMismatchReasons.length,
            packetStatus: packetStatusKey,
            inProgress,
          });
          return (
            <div className="text-[13px] text-gray-300 leading-relaxed border-l-2 border-amber-300/30 pl-3">
              {summary}
            </div>
          );
        })()}

        {/* PEAKOPS_OPERATIONAL_READINESS_V1 (2026-05-17)
            Compact operational readiness strip. Only deterministic
            truths from real data — no AI scores, no percentages, no
            fake confidence. Each row reflects an audit-defensible
            signal a supervisor would check before approving the
            record. */}
        {(() => {
          // PEAKOPS_OPERATIONAL_INTERPRETATION_V1 (2026-05-18, PR 30c)
          // Each readiness signal now carries synthesized operational
          // context derived from real timestamps and events — no fake
          // AI scores, no percentages, no opaque "confidence" — every
          // number on this strip is traceable to a Firestore fact.
          const sessionStart = findEarliestEventSeconds(timeline as any, "session_started");
          const sessionEnd =
            findLatestEventSeconds(timeline as any, "session_completed") ||
            findLatestEventSeconds(timeline as any, "field_submitted");
          const fieldWorkSecs =
            sessionStart && sessionEnd && sessionEnd > sessionStart
              ? sessionEnd - sessionStart
              : 0;
          const hasFieldSubmitted = !!(sessionEnd || timeline.some((t) => {
            const k = String(t.type || "").toLowerCase();
            return k === "field_submitted" || k === "session_completed";
          }));

          const evidenceInWindow =
            sessionStart && sessionEnd
              ? evidence.filter((e) => {
                  const s = Number((e as any).storedAt?._seconds || (e as any).createdAt?._seconds || 0);
                  return s >= sessionStart && s <= sessionEnd;
                }).length
              : 0;

          const approvedJobs = jobs.filter((j) => String(j.status || "").toLowerCase() === "approved").length;
          const hasApproval = approvedJobs > 0;
          const latestApprovalSec = findLatestEventSeconds(timeline as any, "job_approved");

          const integrityClean = truthMismatchReasons.length === 0;
          const packetStatus = String(incident?.packetMeta?.status || "").toLowerCase();
          const packetReady = packetStatus === "ready";

          // PEAKOPS_PACKET_FRESHNESS_V1 (2026-05-18, PR 35)
          // Differentiate "synchronized" (ready + fresh) from "stale"
          // (ready but operational activity occurred more than the
          // 1-hour grace after export). Both states matter for audit
          // confidence; the page now names them explicitly.
          const exportedAtMsStrip = incident?.packetMeta?.exportedAt
            ? Date.parse(incident.packetMeta.exportedAt)
            : NaN;
          const stripUpdatedAtSec = Number(incident?.updatedAt?._seconds || 0);
          const stripLatestEventSec = Number(timeline[0]?.occurredAt?._seconds || 0);
          const stripActivityMs = Math.max(stripUpdatedAtSec, stripLatestEventSec) * 1000;
          const packetStaleStrip =
            packetReady &&
            Number.isFinite(exportedAtMsStrip) &&
            stripActivityMs > 0 &&
            stripActivityMs - exportedAtMsStrip > 60 * 60 * 1000;

          // Build operational-language labels with synthesized context.
          const fieldLabel = hasFieldSubmitted
            ? fieldWorkSecs > 0
              ? `Field work completed in ${formatDuration(fieldWorkSecs)}`
              : "Field crew submitted completion package"
            : "Field crew completion pending";

          const evidenceLabel =
            evidence.length > 0
              ? evidenceInWindow > 0 && evidenceInWindow < evidence.length
                ? `${evidence.length} ${evidence.length === 1 ? "piece" : "pieces"} of evidence captured — ${evidenceInWindow} during active work window`
                : evidenceInWindow > 0 && evidenceInWindow === evidence.length
                  ? `${evidence.length} ${evidence.length === 1 ? "piece" : "pieces"} of evidence captured during active work window`
                  : `${evidence.length} ${evidence.length === 1 ? "piece" : "pieces"} of evidence captured`
              : "Evidence not yet captured";

          const approvalLabel = hasApproval
            ? latestApprovalSec
              ? `Supervisor approval logged ${fmtAgo(latestApprovalSec)} ago (${approvedJobs} ${approvedJobs === 1 ? "job" : "jobs"})`
              : `Supervisor approval complete (${approvedJobs} ${approvedJobs === 1 ? "job" : "jobs"})`
            : "Supervisor approval pending";

          const integrityLabel = integrityClean
            ? "Operational record consistent"
            : `Attention needed: ${truthMismatchReasons.length} item${truthMismatchReasons.length === 1 ? "" : "s"} to review`;

          // PEAKOPS_PACKET_FRESHNESS_V1 (2026-05-18, PR 35)
          // Explicit "synchronized" / "stale" wording — the page now
          // names packet freshness instead of just "ready".
          const packetLabel = !packetReady
            ? "Export packet pending"
            : packetStaleStrip
            ? `Packet stale — operational activity occurred after export${incident?.packetMeta?.exportedAt ? ` (generated ${fmtAgoIso(incident.packetMeta.exportedAt)} ago)` : ""}`
            : incident?.packetMeta?.exportedAt
            ? `Packet synchronized with current operational state (generated ${fmtAgoIso(incident.packetMeta.exportedAt)} ago)`
            : "Packet synchronized with current operational state";

          const items: Array<{ ok: boolean | "warn"; label: string }> = [
            { ok: hasFieldSubmitted, label: fieldLabel },
            { ok: evidence.length > 0, label: evidenceLabel },
            { ok: hasApproval, label: approvalLabel },
            { ok: integrityClean ? true : "warn", label: integrityLabel },
            { ok: packetReady && integrityClean && !packetStaleStrip ? true : packetStaleStrip ? "warn" : false, label: packetLabel },
          ];
          return (
            <section aria-label="Operational readiness" className="space-y-3">
              <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
                Operational readiness
              </div>
              <ul className="space-y-1.5">
                {items.map((it, i) => {
                  const sym = it.ok === true ? "✓" : it.ok === "warn" ? "⚠" : "○";
                  const tone =
                    it.ok === true
                      ? "text-emerald-300/90"
                      : it.ok === "warn"
                      ? "text-amber-200/90"
                      : "text-gray-400";
                  return (
                    <li key={i} className="flex items-start gap-3 text-[13px] leading-relaxed">
                      <span className={`mt-[2px] inline-block w-3 text-center font-semibold ${tone}`}>{sym}</span>
                      <span className={it.ok === true ? "text-gray-100" : it.ok === "warn" ? "text-amber-100/90" : "text-gray-400"}>{it.label}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })()}

        {/* PEAKOPS_OPERATIONAL_FACTS_V1 (2026-05-18, PR 35)
            Deterministic operational facts synthesized from real
            Firestore timestamps and counts — no AI, no scoring, no
            inference beyond comparing two numbers. Each fact reads
            as an audit-defensible statement; rendering is suppressed
            when its source data isn't present. */}
        {(() => {
          type Fact = { tone: "info" | "warn" | "good"; text: string };
          const facts: Fact[] = [];

          // Field response began Xm after incident opened
          const createdAtSec = Number(incident?.createdAt?._seconds || 0);
          const inProgressAtSec = Number((incident as any)?.inProgressAt?._seconds || 0);
          if (createdAtSec > 0 && inProgressAtSec > createdAtSec) {
            facts.push({
              tone: "info",
              text: `Field response began ${formatDuration(inProgressAtSec - createdAtSec)} after incident opened.`,
            });
          }

          // Field work completed in Xh
          const sessionStartFact = findEarliestEventSeconds(timeline as any, "session_started");
          const sessionEndFact =
            findLatestEventSeconds(timeline as any, "session_completed") ||
            findLatestEventSeconds(timeline as any, "field_submitted");
          if (sessionStartFact && sessionEndFact && sessionEndFact > sessionStartFact) {
            facts.push({
              tone: "info",
              text: `Field work completed in ${formatDuration(sessionEndFact - sessionStartFact)}.`,
            });
          }

          // Supervisor approval issued Xh after completion (average across approved jobs that have both timestamps)
          const approvedJobsWithLatency = jobs.filter((j: any) => {
            const isApproved = String(j?.reviewStatus || j?.status || "").toLowerCase() === "approved";
            return isApproved && Number(j?.completedAt?._seconds || 0) > 0 && Number(j?.approvedAt?._seconds || 0) > 0;
          });
          if (approvedJobsWithLatency.length > 0) {
            const totalLatency = approvedJobsWithLatency.reduce(
              (acc: number, j: any) => acc + Math.max(0, Number(j.approvedAt._seconds) - Number(j.completedAt._seconds)),
              0
            );
            const avgLatency = Math.floor(totalLatency / approvedJobsWithLatency.length);
            if (avgLatency > 0) {
              facts.push({
                tone: "info",
                text: `Supervisor approval issued ${formatDuration(avgLatency)} after completion.`,
              });
            }
          }

          // All / N of M evidence captured during active work session
          if (evidence.length > 0 && sessionStartFact && sessionEndFact) {
            const inWindow = evidence.filter((e) => {
              const s = Number((e as any).storedAt?._seconds || (e as any).createdAt?._seconds || 0);
              return s >= sessionStartFact && s <= sessionEndFact;
            }).length;
            if (inWindow > 0 && inWindow === evidence.length) {
              facts.push({
                tone: "good",
                text: "All evidence captured during active work session.",
              });
            } else if (inWindow > 0) {
              facts.push({
                tone: "info",
                text: `${inWindow} of ${evidence.length} evidence ${inWindow === 1 ? "piece" : "pieces"} captured during active work session.`,
              });
            }
          }

          // All approved jobs contain evidence (or warn when not)
          const approvedJobIds = jobs
            .filter((j: any) => String(j?.reviewStatus || j?.status || "").toLowerCase() === "approved")
            .map((j: any) => String(j?.id || j?.jobId || ""));
          if (approvedJobIds.length > 0) {
            const allHaveEvidence = approvedJobIds.every((id) => (evidenceByJob[id]?.length || 0) > 0);
            if (allHaveEvidence) {
              facts.push({ tone: "good", text: "All approved jobs contain evidence." });
            } else {
              facts.push({ tone: "warn", text: "Approved jobs missing evidence — verify before delivery." });
            }
          }

          // Packet generated after final approval
          const packetExportedSec = incident?.packetMeta?.exportedAt
            ? Math.floor(Date.parse(incident.packetMeta.exportedAt) / 1000)
            : 0;
          const latestApprovedAtSec = jobs.reduce((max: number, j: any) => {
            const a = Number(j?.approvedAt?._seconds || 0);
            return a > max ? a : max;
          }, 0);
          if (packetExportedSec > 0 && latestApprovedAtSec > 0 && packetExportedSec >= latestApprovedAtSec) {
            facts.push({ tone: "good", text: "Packet generated after final approval." });
          }

          // Packet synchronized / stale
          if (packetExportedSec > 0) {
            const latestActivityMsFact = Math.max(
              Number(incident?.updatedAt?._seconds || 0),
              Number(timeline[0]?.occurredAt?._seconds || 0)
            ) * 1000;
            const exportedMsFact = packetExportedSec * 1000;
            if (latestActivityMsFact > 0 && latestActivityMsFact - exportedMsFact > 60 * 60 * 1000) {
              const drift = Math.floor((latestActivityMsFact - exportedMsFact) / 1000);
              facts.push({
                tone: "warn",
                text: `Packet stale — operational activity occurred ${formatDuration(drift)} after export.`,
              });
            } else {
              facts.push({ tone: "good", text: "Packet synchronized with current operational state." });
            }
          }

          // Supervisor notes updated N times (moved from PR 30e standalone line)
          const notesSavedCount = (timeline || []).filter(
            (t) => String(t?.type || "").toLowerCase() === "notes_saved"
          ).length;
          if (notesSavedCount > 0) {
            facts.push({
              tone: "info",
              text: `Supervisor notes updated ${notesSavedCount} ${notesSavedCount === 1 ? "time" : "times"}.`,
            });
          }

          if (facts.length === 0) return null;

          return (
            <section aria-label="Operational facts" className="space-y-3">
              <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
                Operational facts
              </div>
              <ul className="space-y-1.5">
                {facts.map((f, i) => {
                  const sym = f.tone === "warn" ? "⚠" : "·";
                  const tone =
                    f.tone === "good"
                      ? "text-emerald-200/90"
                      : f.tone === "warn"
                      ? "text-amber-200/90"
                      : "text-gray-300";
                  return (
                    <li key={i} className="flex items-start gap-3 text-[13px] leading-relaxed">
                      <span className={`mt-[2px] inline-block w-3 text-center ${tone}`}>{sym}</span>
                      <span className={f.tone === "warn" ? "text-amber-100/90" : f.tone === "good" ? "text-emerald-100/95" : "text-gray-200"}>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })()}

        {/* PEAKOPS_FIELD_WORK_CHAPTER_V1 (2026-05-17)
            Combines jobs + evidence into a single operational-proof
            chapter. Evidence is the hero (gallery treatment). Jobs
            status appears below as inline chips, not a 6-cell grid.
            Per-job groupings are quiet captions, not boxed cards.
            Dev-only thumb-debug buttons have moved to the Developer
            Tools drawer at the bottom. */}
        <section aria-label="Field work performed" className="space-y-5">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
              Field work performed
            </div>
            <div className="mt-1 text-[12px] text-gray-400">
              {jobs.length} {jobs.length === 1 ? "job" : "jobs"} · {evidence.length} {evidence.length === 1 ? "piece" : "pieces"} of evidence
              {(() => {
                const approved = jobs.filter((j) => String(j.status || "").toLowerCase() === "approved").length;
                return approved > 0 ? ` · ${approved} approved` : "";
              })()}
              {unassignedEvidenceCount > 0 ? (
                <span className="ml-2 text-amber-200/80">· {unassignedEvidenceCount} unassigned</span>
              ) : null}
              {unassignedEvidenceCount > 0 && (isDemoMode || process.env.NODE_ENV !== "production") ? (
                <button
                  type="button"
                  className="ml-2 text-[11px] text-amber-200/80 hover:text-amber-100 underline-offset-2 hover:underline disabled:opacity-50"
                  onClick={() => { void fixUnassignedEvidence(); }}
                  disabled={fixUnassignedBusy}
                >
                  {fixUnassignedBusy ? "Fixing…" : "Fix unassigned"}
                </button>
              ) : null}
            </div>
            {/* PEAKOPS_EVIDENCE_SESSION_CHIP_V1 (2026-05-18, PR 35)
                Surfaces chain-of-custody confidence when evidence
                timestamps fall inside the active session window.
                Quiet single-line chip — no widget energy, just a
                deterministic trust signal. */}
            {(() => {
              const ss = findEarliestEventSeconds(timeline as any, "session_started");
              const se =
                findLatestEventSeconds(timeline as any, "session_completed") ||
                findLatestEventSeconds(timeline as any, "field_submitted");
              if (!ss || !se || evidence.length === 0) return null;
              const inWindow = evidence.filter((e) => {
                const s = Number((e as any).storedAt?._seconds || (e as any).createdAt?._seconds || 0);
                return s >= ss && s <= se;
              }).length;
              if (inWindow === 0) return null;
              const allInWindow = inWindow === evidence.length;
              const chipClass = allInWindow
                ? "text-emerald-200/85 border-emerald-300/25 bg-emerald-500/[0.08]"
                : "text-amber-200/85 border-amber-300/25 bg-amber-500/[0.08]";
              const chipText = allInWindow
                ? "Captured during active work session"
                : `${inWindow} of ${evidence.length} captured during active session`;
              return (
                <div className="mt-2">
                  <span className={`text-[11px] inline-flex items-center px-2 py-0.5 rounded-full border ${chipClass}`}>
                    {chipText}
                  </span>
                </div>
              );
            })()}
          </div>

          {Object.keys(evidenceByJob).length === 0 ? (
            <div className="text-[12px] text-gray-500 italic">
              No evidence captured yet — field photos and inspections will appear here as the operational record.
            </div>
          ) : (
            <div className="space-y-5">
              {Object.entries(evidenceByJob).map(([jobId, list]) => {
                const job = jobs.find((j) => String(j?.id || j?.jobId || "") === jobId);
                const label = job ? String(job.title || jobId) : (jobId === "unassigned" ? "Unassigned" : jobId);
                const jobStatus = job ? String(job.status || "").toLowerCase() : "";
                return (
                  <div key={jobId} className="space-y-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-[13px] font-medium text-gray-100 truncate">{label}</div>
                      <div className="flex items-baseline gap-2 text-[11px] text-gray-400 shrink-0">
                        {jobStatus ? <span className="text-gray-300">{jobStatus}</span> : null}
                        <span>· {list.length} {list.length === 1 ? "piece" : "pieces"}</span>
                      </div>
                    </div>
                    <div className="flex gap-2.5 overflow-x-auto -mx-1 px-1 pb-1">
                      {list.slice(0, 8).map((ev) => {
                        const id = String(ev.id || "");
                        const u = thumbUrl[id];
                        return (
                          <div key={id} className="relative min-w-[160px] w-[160px] aspect-[4/3] rounded-lg overflow-hidden border border-white/8 bg-black/40">
                            {u ? (
                              <img
                                src={u}
                                className="w-full h-full object-cover"
                                onLoad={() => {
                                  setThumbStatusById((m) => ({ ...m, [id]: 200 }));
                                  setThumbErrById((m) => ({ ...m, [id]: "" }));
                                }}
                                onError={() => { void renewThumbOnce(ev, u); }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-500 text-center px-1">
                                {thumbErrById[id] ? "Unavailable" : "Loading…"}
                              </div>
                            )}
                            {/* PEAKOPS_EVIDENCE_LABEL_CHIP_V1 (2026-05-18, PR 30d)
                                Surfaces the first operational label on the
                                tile. Top-left placement avoids the bottom
                                debug overlay; small enough not to obstruct
                                the image. */}
                            {Array.isArray((ev as any).labels) && (ev as any).labels[0] ? (
                              <div className="absolute left-1.5 top-1.5 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-300/30 text-amber-100">
                                {String((ev as any).labels[0])}
                              </div>
                            ) : null}
                            {process.env.NODE_ENV !== "production" && thumbErrById[id] ? (
                              <div className="absolute left-1 right-1 bottom-1 text-[9px] text-red-200 truncate bg-black/70 px-1 py-0.5 rounded border border-red-400/30">
                                {thumbErrById[id]}
                              </div>
                            ) : null}
                            {process.env.NODE_ENV !== "production" && thumbDebugOverlay ? (
                              <div className="absolute left-1 right-1 top-1 text-[9px] text-cyan-100 bg-black/65 px-1 py-0.5 rounded border border-cyan-300/30">
                                <div className="truncate">id={id}</div>
                                <div className="truncate">bucket={String(thumbBucketById[id] || "")}</div>
                                <div className="truncate">path={String(thumbPathById[id] || "")}</div>
                                <div className="truncate">mint_http={String(thumbStatusById[id] || 0)}</div>
                                <div className="truncate">mint_error={String(thumbMintErrorById[id] || "-")}</div>
                                <div className="truncate">probe_http={String(thumbProbeStatusById[id] || "-")}</div>
                                <div className="truncate">probe_error={String(thumbProbeErrorById[id] || "-")}</div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* PEAKOPS_JOBS_PROSE_V2 (2026-05-18, PR 35)
              Single-sentence jobs status (composeJobsProse). PR #33's
              "Status breakdown" <details> was removed in PR 35 per
              audit feedback — it surfaced developer-grade counts that
              didn't belong in a customer-facing operational record. */}
          {jobs.length > 0 ? (
            <div className="pt-1 text-[13px] text-gray-200">
              {composeJobsProse(statusCounts as StatusCountsLike, jobs.length)}
            </div>
          ) : null}
        </section>

        {/* PEAKOPS_OPERATIONAL_TIMELINE_V1 (2026-05-17)
            Narrative audit timeline with a single vertical rule on
            the left. Event labels read in operational language
            (prettyTimelineEvent) instead of raw FIELD_SUBMITTED-style
            tokens. Dots inline with text; time right-aligned. */}
        <section aria-label="Operational timeline" className="space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
              Operational timeline
            </div>
            <div className="mt-1 text-[12px] text-gray-400">
              Audit-traceable record of every operational milestone.
            </div>
          </div>
          {timelineHighlights.length === 0 ? (
            <div className="text-[12px] text-gray-500 italic pl-1">No recorded events yet.</div>
          ) : (
            <ol className="relative border-l border-white/8 ml-2 space-y-3 pt-1">
              {timelineHighlights.map((t) => {
                const tType = String(t.type || "");
                // PEAKOPS_TIMELINE_PROSE_V2 (2026-05-18, PR 30c)
                // Look up job title / evidence label by refId so the
                // event reads like "Supervisor approved <Job Title>"
                // instead of the generic "Supervisor approved job".
                const ref = t.refId ? String(t.refId) : "";
                const job = ref ? jobs.find((j) => String((j as any).id || j.jobId || "") === ref) : undefined;
                const evMatch = ref ? evidence.find((e) => String((e as any).id || "") === ref) : undefined;
                const evidenceLabel = (() => {
                  if (!evMatch) return "";
                  const file = (evMatch as any).file || {};
                  return String(file.originalName || file.label || "").trim();
                })();
                const label = prettyTimelineEvent(tType, {
                  jobTitle: job?.title,
                  evidenceLabel: evidenceLabel || undefined,
                });
                const icon = eventIcon(tType);
                const actor = String(t.actor || "");
                const isSystemActor = !actor || actor === "ui" || actor === "system";
                return (
                  <li key={t.id} className="pl-5 -ml-[7px]">
                    <span className="absolute -left-[7px] mt-1.5 w-[13px] h-[13px] rounded-full border border-white/15 bg-black flex items-center justify-center text-[8px]">
                      {icon}
                    </span>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-[13px] text-gray-100 leading-snug">{label}</div>
                      <div className="text-[11px] text-gray-500 shrink-0">{fmtAgo(t.occurredAt?._seconds)}</div>
                    </div>
                    {!isSystemActor ? (
                      <div className="mt-0.5 text-[11px] text-gray-500 truncate">by {prettyActor(actor, { eventType: tType }, memberRegistry)}</div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* PEAKOPS_CHAIN_OF_ACCOUNTABILITY_V1 (2026-05-18, PR 35)
            Audit-grade chain of accountability. Each row names a
            single transition in the operational record's lifecycle
            with an absolute timestamp. Pending rows render muted so
            completed rows visually anchor. Attribution uses
            context-safe role labels (Operations / Field crew /
            Supervisor) — PR 36's Member Identity Resolver will
            substitute real names. */}
        {(() => {
          type ChainRow = { label: string; when?: string; pending?: boolean };
          const rows: ChainRow[] = [];

          // Opened
          if (incident?.createdBy && incident?.createdAt?._seconds) {
            rows.push({
              label: `Opened by ${prettyActor(incident.createdBy, { chainRole: "opened" }, memberRegistry)}`,
              when: fmtAbsolute(incident.createdAt._seconds),
            });
          } else {
            rows.push({ label: "Opened", pending: true });
          }

          // Field package submitted
          const fieldSubmittedEvent = (timeline || []).find(
            (t) => String(t?.type || "").toLowerCase() === "field_submitted"
          );
          if (fieldSubmittedEvent) {
            rows.push({
              label: `Field package submitted by ${prettyActor(String(fieldSubmittedEvent.actor || ""), { chainRole: "submitted" }, memberRegistry)}`,
              when: fmtAbsolute(fieldSubmittedEvent.occurredAt?._seconds),
            });
          } else {
            rows.push({ label: "Field package submitted", pending: true });
          }

          // Approved
          const approvedJobsForChain = jobs.filter((j: any) => {
            const isApproved = String(j?.reviewStatus || j?.status || "").toLowerCase() === "approved";
            return isApproved && (j?.approvedBy || j?.approvedAt?._seconds);
          });
          if (approvedJobsForChain.length > 0) {
            const approvers = Array.from(
              new Set(
                approvedJobsForChain
                  .map((j: any) => String(j?.approvedBy || "").trim())
                  .filter((a: string) => a)
              )
            );
            const latestApprovedAt = approvedJobsForChain.reduce(
              (max: number, j: any) => Math.max(max, Number(j?.approvedAt?._seconds || 0)),
              0
            );
            const approverLabel = approvers.length === 1
              ? prettyActor(approvers[0], { chainRole: "approved" }, memberRegistry)
              : "multiple supervisors";
            const jobCountSuffix = approvedJobsForChain.length > 1
              ? ` (${approvedJobsForChain.length} jobs)`
              : "";
            rows.push({
              label: `Approved by ${approverLabel}${jobCountSuffix}`,
              when: latestApprovedAt > 0 ? fmtAbsolute(latestApprovedAt) : undefined,
            });
          } else {
            rows.push({ label: "Approved", pending: true });
          }

          // Packet generated
          if (incident?.packetMeta?.exportedAt) {
            rows.push({
              label: "Packet generated",
              when: fmtAbsoluteIso(incident.packetMeta.exportedAt),
            });
          } else {
            rows.push({ label: "Packet generated", pending: true });
          }

          return (
            <section aria-label="Chain of accountability" className="space-y-3">
              <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
                Chain of accountability
              </div>
              <ul className="space-y-1.5">
                {rows.map((r, i) => (
                  <li key={i} className="flex items-baseline gap-3 text-[13px] leading-relaxed">
                    <span className={`mt-[2px] inline-block w-3 text-center ${r.pending ? "text-gray-600" : "text-gray-400"}`}>·</span>
                    <span className={r.pending ? "text-gray-500" : "text-gray-100"}>{r.label}</span>
                    <span className="flex-1" />
                    <span className={`text-[11px] shrink-0 ${r.pending ? "text-gray-600 italic" : "text-gray-400"}`}>
                      {r.pending ? "Pending" : r.when}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })()}

        {/* PEAKOPS_EXPORT_PACKET_CHAPTER_V1 (2026-05-17)
            Renamed from "Incident Status" card. The status pill is
            already in the masthead; this chapter is purely about the
            export action. Aligns with ReviewClient's "Download
            Packet" vocabulary. */}
        <section aria-label="Export packet" className="space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/60">
              Export packet
            </div>
            <div className="mt-1 text-[12px] text-gray-400">
              Operational record output for delivery.{" "}
              {(incident?.packetMeta?.evidenceCount ?? packetEvidenceCount) > 0 ||
              (incident?.packetMeta?.jobCount ?? packetJobCount) > 0 ? (
                <>
                  Includes {incident?.packetMeta?.evidenceCount ?? packetEvidenceCount}{" "}
                  {(incident?.packetMeta?.evidenceCount ?? packetEvidenceCount) === 1 ? "piece" : "pieces"} of evidence and{" "}
                  {incident?.packetMeta?.jobCount ?? packetJobCount}{" "}
                  {(incident?.packetMeta?.jobCount ?? packetJobCount) === 1 ? "job" : "jobs"}.
                </>
              ) : null}
            </div>
          </div>
          {/* PEAKOPS_PRIMARY_CTA_RENDER_V1 (2026-05-18, PR 30d)
              CTA label + action are decided by composePrimaryCta()
              based on attention items, packet staleness (1h grace),
              and basic disabled state. "Review attention items"
              scrolls to #integrity rather than triggering export. */}
          {(() => {
            const exportedAtMs2 = incident?.packetMeta?.exportedAt
              ? Date.parse(incident.packetMeta.exportedAt)
              : NaN;
            const updatedAtSec2 = Number((incident as any)?.updatedAt?._seconds || 0);
            const updatedAtMs2 = updatedAtSec2 ? updatedAtSec2 * 1000 : 0;
            const packetStale2 =
              Number.isFinite(exportedAtMs2) &&
              updatedAtMs2 > 0 &&
              updatedAtMs2 - exportedAtMs2 > 60 * 60 * 1000;
            const packetStatusRaw2 = String(incident?.packetMeta?.status || "").toLowerCase();
            const packetStatusKey2: "ready" | "building" | "stale" | "pending" =
              packetStatusRaw2 === "ready" && packetStale2
                ? "stale"
                : packetStatusRaw2 === "ready"
                ? "ready"
                : packetStatusRaw2 === "building"
                ? "building"
                : "pending";
            const cta = composePrimaryCta({
              attentionCount: truthMismatchReasons.length,
              packetStatus: packetStatusKey2,
              artifactBusy,
              hasOrgAndIncident: !!orgId && !!incidentId,
              hasErr: !!err,
            });
            const onClick = () => {
              if (cta.mode === "review") {
                if (typeof document !== "undefined") {
                  const el = document.getElementById("integrity");
                  if (el) {
                    // Open the <details> if collapsed.
                    if ((el as HTMLDetailsElement).open === false) {
                      (el as HTMLDetailsElement).open = true;
                    }
                    el.scrollIntoView({ behavior: "smooth", block: "start" });
                    return;
                  }
                }
                return;
              }
              if (cta.mode === "disabled" || cta.mode === "building") return;
              void handleArtifactDownload();
            };
            const isAttention = cta.mode === "review";
            const isDisabled =
              cta.mode === "disabled" || cta.mode === "building";
            const stylePrimary =
              "bg-emerald-600/15 border-emerald-400/30 text-emerald-100 hover:bg-emerald-600/25";
            const styleAttention =
              "bg-amber-500/15 border-amber-300/30 text-amber-100 hover:bg-amber-500/25";
            const styleDisabled =
              "bg-white/[0.03] border-white/10 text-gray-500 cursor-not-allowed";
            return (
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  className={
                    "px-4 py-2.5 rounded-lg text-[13px] font-medium border transition " +
                    (isDisabled ? styleDisabled : isAttention ? styleAttention : stylePrimary)
                  }
                  disabled={isDisabled}
                  onClick={onClick}
                  title={artifactHint}
                >
                  {cta.label}
                </button>
                {artifactHint ? (
                  <div className="text-[12px] text-gray-500">{artifactHint}</div>
                ) : null}
              </div>
            );
          })()}
          {lastArtifactFilename ? (
            <div className="text-[11px] text-gray-500">
              Last export: {lastArtifactFilename}
              {lastArtifactAt ? ` · ${lastArtifactAt}` : ""}
            </div>
          ) : null}

          {/* PEAKOPS_SUPERVISOR_ACTION_RAIL_V2 (2026-05-18, PR 35)
              De-footerified per PR 35 audit feedback: the bordered
              "More actions" strip read as a page footer. Now renders
              as quiet inline links directly below the CTA hint, no
              divider, no eyebrow label. */}
          {orgId && incidentId ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray-500">
              <button
                type="button"
                className="hover:text-gray-200 underline-offset-2 hover:underline"
                onClick={() => router.push(`/incidents/${incidentId}/review?orgId=${encodeURIComponent(orgId)}`)}
              >
                Open review
              </button>
              <span className="text-white/10">·</span>
              <button
                type="button"
                className="hover:text-gray-200 underline-offset-2 hover:underline"
                onClick={() => router.push(`/incidents/${incidentId}/notes?orgId=${encodeURIComponent(orgId)}`)}
              >
                Open notes
              </button>
              <span className="text-white/10">·</span>
              <button
                type="button"
                className="hover:text-gray-200 underline-offset-2 hover:underline"
                onClick={() => router.push(`/incidents/${incidentId}?orgId=${encodeURIComponent(orgId)}`)}
              >
                Back to incident
              </button>
            </div>
          ) : null}
        </section>

        {/* PEAKOPS_DEV_TOOLS_DRAWER_V1 (2026-05-17)
            Closed by default. Houses the thumbnail-refresh / remint /
            debug-overlay buttons that previously rendered inline in
            the Evidence header. Production users see only the closed
            summary line; expanding it surfaces the dev buttons. The
            outer conditional keeps this absent from prod entirely. */}
        {process.env.NODE_ENV !== "production" ? (
          <details className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-2">
            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-gray-500 list-none flex items-center justify-between">
              <span>Developer tools</span>
              <span className="text-[10px] text-gray-600">click to expand</span>
            </summary>
            <div className="mt-3 flex flex-wrap items-center gap-2">
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
            </div>
          </details>
        ) : null}

        {loading ? <div className="text-xs text-gray-500">Refreshing summary…</div> : null}
        </div>
      </div>
    </main>
    </>
  );
}
