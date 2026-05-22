"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getFunctionsBase } from "@/lib/functionsBase";
import { uploadEvidence } from "@/lib/evidence/uploadEvidence";
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";
import { incidentStatusLabel, incidentStatusPill, normalizeIncidentStatusShared } from "@/lib/incidents/incidentStatus";
import { authedFetch } from "@/lib/apiClient";
import { SealedRecordPanel } from "@/components/sealedRecord/SealedRecordPanel";
import { useAuth } from "@/hooks/useAuth";

type JobDoc = {
  id: string;
  title?: string;
  status?: string;
  incidentId?: string;
  orgId?: string;
  assignedOrgId?: string | null;
  notes?: string;
  updatedAt?: { _seconds?: number };
};

type EvidenceDoc = {
  id: string;
  fileName?: string;
  label?: string;
  file?: {
    originalName?: string;
    bucket?: string;
    storagePath?: string;
    thumbPath?: string;
    previewPath?: string;
    thumbBucket?: string;
    previewBucket?: string;
    derivativeBucket?: string;
    derivatives?: {
      thumb?: { storagePath?: string; bucket?: string };
      preview?: { storagePath?: string; bucket?: string };
    };
  };
  jobId?: string | null;
  evidence?: { jobId?: string | null };
};

function fmtStatus(s: any) {
  return String(s || "open").toLowerCase();
}

function statusChip(status: string) {
  if (status === "complete") return "bg-emerald-500/15 border-emerald-300/30 text-emerald-100";
  if (status === "assigned") return "bg-blue-500/15 border-blue-300/30 text-blue-100";
  if (status === "in_progress") return "bg-cyan-500/15 border-cyan-300/30 text-cyan-100";
  if (status === "open") return "bg-white/10 border-white/20 text-gray-200";
  return "bg-white/10 border-white/20 text-gray-200";
}

// PEAKOPS_JOBDETAIL_ACTOR_FROM_CLAIMS_V1 (PR 53)
// Resolve actor identity from Firebase Auth claims (the canonical
// post-Slice-12 source) with a one-step localStorage fallback for
// callers that haven't yet plumbed useAuth context. Returns "tech_web"
// only as a last-resort sentinel — server-side resolveActor reads the
// Bearer ID token first regardless, so the value is mostly cosmetic
// when authedFetch is in use. Replaces the prior actorUid/actorRole/
// actorEmail localStorage-only helpers that defaulted to legacy
// "tech_web" / "field" and bypassed the real signed-in identity.
function readLocalStorage(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = String(window.localStorage.getItem(key) || "").trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
function deriveActorUid(authedUid: string | null | undefined): string {
  const claim = String(authedUid || "").trim();
  if (claim) return claim;
  return readLocalStorage("peakops_uid", "tech_web");
}
function deriveActorRole(claimRole: string | null | undefined): string {
  const claim = String(claimRole || "").trim().toLowerCase();
  if (claim) return claim;
  return readLocalStorage("peakops_role", "field").toLowerCase();
}
function deriveActorEmail(authedEmail: string | null | undefined): string {
  const claim = String(authedEmail || "").trim();
  if (claim) return claim;
  return readLocalStorage("peakops_email", "");
}

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return (txt ? JSON.parse(txt) : {}) as T;
}

export default function JobDetailClient({
  jobId,
  initialIncidentId,
  initialOrgId,
}: {
  jobId: string;
  initialIncidentId?: string;
  initialOrgId?: string;
}) {
  const router = useRouter();
  const functionsBase = getFunctionsBase();
  // PEAKOPS_JOBDETAIL_ACTOR_FROM_CLAIMS_V1 (PR 53)
  // Pull the canonical actor identity off Firebase Auth claims. Falls
  // back to the legacy localStorage values when claims haven't loaded
  // yet (cold start) so first-paint API calls don't strand without
  // any actor at all. Server still trusts Bearer over body claims.
  const { user, claims } = useAuth();
  const authUid = user?.uid || "";
  const authEmail = user?.email || "";
  const authRole = claims?.role || "";
  // PEAKOPS_JOBDETAIL_ORG_FROM_URL_V1 (2026-05-15)
  // orgId initializes from `initialOrgId` prop which is read from
  // the URL searchParam in the parent server page. The previous
  // hardcode fallback (`"riverbend-electric"`) caused 401/403 from
  // every Cloud Function call when the URL lacked `?orgId=...`.
  // Empty string when missing; the missing-org guard panel below
  // renders instead of the main UI in that case.
  const [orgId, setOrgId] = useState(String(initialOrgId || "").trim());
  const [incidentId, setIncidentId] = useState(String(initialIncidentId || "").trim());
  const [job, setJob] = useState<JobDoc | null>(null);
  const [incident, setIncident] = useState<{ id: string; title?: string; status?: string } | null>(null);
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [markingComplete, setMarkingComplete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [err, setErr] = useState("");
  const [thumbUrlByKey, setThumbUrlByKey] = useState<Record<string, string>>({});
  const [thumbErrById, setThumbErrById] = useState<Record<string, string>>({});
  const [thumbRetryById, setThumbRetryById] = useState<Record<string, number>>({});
  const [thumbStatusById, setThumbStatusById] = useState<Record<string, number>>({});
  const [thumbMintErrorById, setThumbMintErrorById] = useState<Record<string, string>>({});
  const [thumbProbeStatusById, setThumbProbeStatusById] = useState<Record<string, number>>({});
  const [thumbProbeErrorById, setThumbProbeErrorById] = useState<Record<string, string>>({});
  const [thumbPathById, setThumbPathById] = useState<Record<string, string>>({});
  const [thumbBucketById, setThumbBucketById] = useState<Record<string, string>>({});
  const [thumbDebugOverlay, setThumbDebugOverlay] = useState(false);
  const [previewOpen, setPreviewOpen] = useState<{ src: string; name: string } | null>(null);
  const thumbRefreshInflightRef = useRef<Record<string, boolean>>({});
  const thumbRefreshDebounceRef = useRef<any>(null);
  const isDev = process.env.NODE_ENV !== "production";
  const isEmulatorThumbMode = useMemo(() => {
    const base = String(functionsBase || "").toLowerCase();
    return base.includes("127.0.0.1") || base.includes("localhost");
  }, [functionsBase]);

  const canMarkComplete = useMemo(() => {
    const st = fmtStatus(job?.status);
    return st === "open" || st === "assigned" || st === "in_progress";
  }, [job]);

  async function refresh() {
    if (!functionsBase) return;
    // PEAKOPS_JOBDETAIL_MISSING_ORG_GUARD_V1 (2026-05-15)
    // Short-circuit when no orgId is in scope. Mirrors the
    // IncidentClient guard in PR #24 and Summary in PR #25.
    // Without this, getJobV1 would fire with empty orgId and
    // server returns 400. The component renders a safe
    // missing-org panel below in that case.
    if (!orgId) {
      setLoading(false);
      return;
    }
    if (!incidentId) {
      setErr("Missing incidentId. Open this page from Incident -> Jobs -> Open.");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const url =
        `${functionsBase}/getJobV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&jobId=${encodeURIComponent(jobId)}` +
        `&actorUid=${encodeURIComponent(deriveActorUid(authUid))}` +
        `&actorRole=${encodeURIComponent(deriveActorRole(authRole))}`;
      const res = await authedFetch(url);
      const txt = await res.text();
      const out = txt ? JSON.parse(txt) : {};
      if (!res.ok || !out?.ok) throw new Error(out?.error || `getJobV1 failed (${res.status})`);
      setJob(out.job || null);
      setIncident(out.incident || null);
      setEvidence(Array.isArray(out.evidence) ? out.evidence : []);
      setNotes(String(out?.job?.notes || ""));
      const assignedOrg = String(out?.job?.assignedOrgId || "").trim();
      const incidentOrg = String(out?.incident?.orgId || "").trim();

      // Keep API calls pinned to the canonical incident org.
      // assignedOrgId is display/routing metadata only.
      if (incidentOrg && incidentOrg !== orgId) {
        setOrgId(incidentOrg);
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!incidentId) {
      try {
        const v = String(localStorage.getItem("peakops_last_incident_id") || "").trim();
        if (v) setIncidentId(v);
      } catch {}
    }
  }, [incidentId]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, incidentId, orgId, functionsBase]);

  // PEAKOPS_JOBDETAIL_EVIDENCE_SCOPE_V1 (PR 53)
  // Defense-in-depth client-side filter. The server's getJobV1 already
  // filters by linkedJobId(ev) === jobId, but a mid-flight state swap
  // (e.g., refresh races with a new fetch) can briefly surface
  // evidence from an adjacent job. Belt-and-suspenders: re-verify
  // every render that what we're about to show is bound to THIS job.
  // No widening of the data contract; just a paranoid filter. Hoisted
  // up here so the resolveThumbs useEffect below can read it without
  // a TS use-before-declaration error.
  const visibleEvidence = useMemo(() => {
    return (evidence || []).filter((ev) => {
      const ejid = String(ev?.jobId || ev?.evidence?.jobId || "").trim();
      return ejid === String(jobId || "").trim();
    });
  }, [evidence, jobId]);

  useEffect(() => {
    let cancelled = false;
    async function resolveThumbs() {
      if (!incidentId || !orgId) return;
      // PEAKOPS_JOBDETAIL_EVIDENCE_SCOPE_V1 (PR 53)
      // Only mint signed URLs for evidence that survives the
      // client-side job-scope filter. Prevents wasting Identity
      // Toolkit cycles on items we won't render anyway.
      for (const ev of visibleEvidence) {
        const ref = getBestEvidencePreviewRef(ev);
        const key = String(ev.id || "").trim();
        if (!ref?.storagePath || !ref?.bucket || thumbUrlByKey[key]) continue;
        try {
          if (isDev) {
            console.debug("[job-thumb-readurl]", {
              evidenceId: key,
              kind: ref.kind,
              orgId,
              incidentId,
              bucket: ref.bucket,
              storagePath: ref.storagePath,
            });
          }
          const out = await mintEvidenceReadUrl({
            orgId,
            incidentId,
            bucket: ref.bucket,
            storagePath: ref.storagePath,
            expiresSec: getThumbExpiresSec(),
          });
          if (cancelled) return;
          if (out?.ok && out?.url) {
            setThumbUrlByKey((m) => ({ ...m, [key]: String(out.url) }));
            setThumbRetryById((m) => ({ ...m, [key]: 0 }));
            setThumbPathById((m) => ({ ...m, [key]: String(ref.storagePath) }));
            setThumbBucketById((m) => ({ ...m, [key]: String(ref.bucket) }));
            setThumbStatusById((m) => ({ ...m, [key]: Number(out.status || 200) }));
            setThumbMintErrorById((m) => ({ ...m, [key]: "-" }));
            setThumbProbeStatusById((m) => ({ ...m, [key]: 0 }));
            setThumbProbeErrorById((m) => ({ ...m, [key]: "-" }));
            setThumbErrById((m) => {
              if (!m[key]) return m;
              const next = { ...m };
              delete next[key];
              return next;
            });
          }
        } catch (e: any) {
          if (cancelled) return;
          setThumbErrById((m) => ({ ...m, [key]: String(e?.message || e) }));
          setThumbStatusById((m) => ({ ...m, [key]: 0 }));
          setThumbMintErrorById((m) => ({ ...m, [key]: String(e?.message || e || "thumb_prefetch_failed") }));
        }
      }
    }
    resolveThumbs();
    return () => {
      cancelled = true;
    };
  }, [visibleEvidence, incidentId, orgId, thumbUrlByKey]);

  async function renewThumbOnce(ev: EvidenceDoc, currentSrc: string) {
    const id = String(ev?.id || "").trim();
    if (!id) return;
    if (isEmulatorThumbMode) {
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
    if (isDev) {
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
      bucket: ref.bucket,
      storagePath: ref.storagePath,
      expiresSec: getThumbExpiresSec(),
    });
    if (out?.ok && out.url) {
      // PEAKOPS_NO_POST_SIGN_CACHEBUST_V1 (2026-05-15)
      // Use the minted GCS signed URL as-is; appending a cache-buster
      // here voids the V4 signature (see signedThumb.ts for details).
      const fresh = out.url;
      setThumbUrlByKey((m) => ({ ...m, [id]: fresh }));
      setThumbRetryById((m) => ({ ...m, [id]: 0 }));
      setThumbPathById((m) => ({ ...m, [id]: String(ref.storagePath) }));
      setThumbBucketById((m) => ({ ...m, [id]: String(ref.bucket) }));
      setThumbStatusById((m) => ({ ...m, [id]: Number(out.status || 200) }));
      setThumbMintErrorById((m) => ({ ...m, [id]: "-" }));
      setThumbProbeStatusById((m) => ({ ...m, [id]: 0 }));
      setThumbProbeErrorById((m) => ({ ...m, [id]: "-" }));
      setThumbErrById((m) => {
        if (!m[id]) return m;
        const n = { ...m };
        delete n[id];
        return n;
      });
      if (!isEmulatorThumbMode) {
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

  function refreshVisibleThumbsDebounced() {
    if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    thumbRefreshDebounceRef.current = setTimeout(() => {
      visibleEvidence.forEach((ev) => {
        const id = String(ev?.id || "").trim();
        if (!id || thumbRefreshInflightRef.current[id]) return;
        thumbRefreshInflightRef.current[id] = true;
        setThumbRetryById((m) => ({ ...m, [id]: 0 }));
        setThumbErrById((m) => ({ ...m, [id]: "" }));
        const current = String(thumbUrlByKey[id] || "");
        void renewThumbOnce(ev, current).finally(() => {
          thumbRefreshInflightRef.current[id] = false;
        });
      });
    }, 120);
  }

  useEffect(() => {
    return () => {
      if (thumbRefreshDebounceRef.current) clearTimeout(thumbRefreshDebounceRef.current);
    };
  }, []);

  // PEAKOPS_JOBDETAIL_SEALED_GATE_V1 (PR 53)
  // Mirror the upload path's reactive 409 handling — if a sealed-state
  // race fires while the user is mid-edit, flip into sealed mode so the
  // banner takes over instead of a raw error string.
  function isSealedMutationError(msg: string): boolean {
    return /incident_closed/i.test(msg) || / 409 /.test(msg);
  }

  async function saveNotes() {
    if (!functionsBase || !incidentId) return;
    // Proactive guard. The button is hidden when isIncidentClosed,
    // but defend against any future call site forcing the action.
    if (isIncidentClosed) return;
    try {
      setSavingNotes(true);
      await postJson(`/api/fn/updateJobNotesV1`, {
        orgId,
        incidentId,
        jobId,
        notes,
        actorUid: deriveActorUid(authUid),
        actorRole: deriveActorRole(authRole),
        actorEmail: deriveActorEmail(authEmail),
      });
      await refresh();
    } catch (e: any) {
      const m = String(e?.message || e);
      if (isSealedMutationError(m)) {
        setSealedAfterMutation(true);
        return;
      }
      setErr(m);
    } finally {
      setSavingNotes(false);
    }
  }

  async function markComplete() {
    if (!functionsBase || !incidentId) return;
    if (isIncidentClosed) return;
    try {
      setMarkingComplete(true);
      await postJson(`/api/fn/markJobCompleteV1`, {
        orgId,
        incidentId,
        jobId,
        assignedOrgId: String(job?.assignedOrgId || "").trim() || undefined,
        actorUid: deriveActorUid(authUid),
        actorRole: deriveActorRole(authRole),
        actorEmail: deriveActorEmail(authEmail),
      });
      await refresh();
    } catch (e: any) {
      const m = String(e?.message || e);
      if (isSealedMutationError(m)) {
        setSealedAfterMutation(true);
        return;
      }
      setErr(m);
    } finally {
      setMarkingComplete(false);
    }
  }

  // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
  // sealedAfterMutation flips on if a mutating call encounters a 409
  // because the incident was sealed mid-edit. The render then swaps
  // the affected control for the inline sealed banner. PR 53 extends
  // this from "upload-only" to also cover saveNotes + markComplete —
  // both function endpoints already gate sealed state server-side
  // (PR 41/42) but JobDetail wasn't catching the 409 to swap UI.
  const [sealedAfterMutation, setSealedAfterMutation] = useState(false);

  // PEAKOPS_JOBDETAIL_SEALED_GATE_V1 (PR 53)
  // Canonical closed-state predicate. Hoisted to component scope so
  // the upload section, Notes section, and Mark Complete button all
  // read from one source instead of recomputing inline. Matches the
  // rest of the app's status pipeline (lib/incidents/incidentStatus).
  const isIncidentClosed =
    normalizeIncidentStatusShared(incident?.status) === "closed" ||
    sealedAfterMutation;

  // visibleEvidence hoisted above the resolveThumbs useEffect (PR 53).

  async function onUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file || !functionsBase || !incidentId) return;
    // PEAKOPS_JOBDETAIL_SEALED_GATE_V1 (PR 53)
    // Proactive client-side guard. The upload input is already hidden
    // when isIncidentClosed (the SealedRecordPanel takes its place),
    // but if some future call site forces the action, refuse here
    // before the bytes leave the browser. Server still enforces via
    // 409 incident_closed (PR 41).
    if (isIncidentClosed) {
      ev.target.value = "";
      return;
    }
    try {
      setUploading(true);
      setUploadStatus("Preparing upload...");
      await uploadEvidence({
        functionsBase,
        techUserId: deriveActorUid(authUid),
        orgId,
        incidentId,
        phase: "INSPECTION",
        labels: ["DAMAGE"],
        notes: "",
        file,
        jobId,
        onStatus: (s) => setUploadStatus(s),
        // PEAKOPS_UPLOAD_ACTOR_FROM_CLAIMS_V1 (PR 53)
        // Plumb the real signed-in identity through so audit events
        // (EVIDENCE_ADDED, SESSION_STARTED) carry the actor's claim
        // uid + role instead of the legacy "dev-admin"/"admin" pair.
        actorUid: deriveActorUid(authUid),
        actorRole: deriveActorRole(authRole),
      });
      await refresh();
      setUploadStatus("Uploaded");
    } catch (e: any) {
      const m = String(e?.message || e);
      // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
      // Reactive 409: replace the generic "Upload failed" with the
      // sealed-state banner so the supervisor sees an operational
      // explanation instead of a raw failure.
      if (/incident_closed/i.test(m) || / 409 /.test(m)) {
        setSealedAfterMutation(true);
        setUploadStatus("");
        return;
      }
      setErr(m);
      setUploadStatus("Upload failed");
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  // PEAKOPS_JOBDETAIL_MISSING_ORG_GUARD_V1 (2026-05-15)
  // Safe missing-org panel. Renders instead of the main UI when
  // the URL has no `?orgId=...` query param. The mirror guard in
  // refresh() above prevents any /api/fn/* network calls from
  // firing while this panel is shown.
  if (!orgId) {
    return (
      <main className="min-h-screen bg-[#0A0E14] text-gray-100 p-6">
        <div className="max-w-2xl mx-auto rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5">
          <div className="text-sm text-amber-100 font-semibold">Job unavailable</div>
          <div className="mt-2 text-sm text-amber-50/90">
            The job detail page needs an <code className="px-1 py-0.5 rounded bg-white/10">orgId</code> in the URL to load.
          </div>
          <div className="mt-3 text-xs text-amber-100/80">
            Open this job from the Incident page, or include{" "}
            <code className="px-1 py-0.5 rounded bg-white/10">?orgId=&lt;your-org-id&gt;</code> in the URL.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0A0E14] text-gray-100 px-4 py-5 md:px-8">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400">Job Detail</div>
            <h1 className="text-xl font-semibold">{job?.title || jobId}</h1>
            <div className="text-xs text-gray-400">jobId: {jobId}</div>
          </div>
          <button
            type="button"
            className="px-3 py-1.5 rounded border border-white/15 bg-white/5 text-sm"
            onClick={() => {
              if (incidentId) router.push(`/incidents/${encodeURIComponent(incidentId)}`);
              else router.back();
            }}
          >
            Back to Incident
          </button>
        </div>

        {err ? <div className="text-sm text-amber-300">{err}</div> : null}

        <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
          {/* PEAKOPS_JOBDETAIL_LIFECYCLE_HIERARCHY_V1 (PR 53)
              When the incident is sealed, the incident's status is the
              load-bearing lifecycle signal — supervisors need to read
              "Closed" as the page-level state, not "in_progress" from
              the job chip. The job's status moves into the secondary
              meta line as "Job: in_progress" with a clear prefix.
              When the incident is still open, the job chip leads as
              before. */}
          {isIncidentClosed ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  "px-2 py-0.5 rounded-full border text-xs " +
                  incidentStatusPill(incident?.status || "closed")
                }
              >
                {incidentStatusLabel(incident?.status || "closed")}
              </span>
              <span className="text-xs text-gray-400">
                Job: {fmtStatus(job?.status)}
              </span>
              <span className="text-xs text-gray-400">
                · incident: {incident?.title || incident?.id || incidentId || "-"}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  "px-2 py-0.5 rounded-full border text-xs " +
                  statusChip(fmtStatus(job?.status))
                }
              >
                {fmtStatus(job?.status)}
              </span>
              <span className="text-xs text-gray-400">
                incident: {incident?.title || incident?.id || incidentId || "-"}
              </span>
              <span className="text-xs text-gray-400">
                incidentStatus: {incident ? incidentStatusLabel(incident?.status) : "-"}
              </span>
            </div>
          )}
          <div className="text-xs text-gray-400">org: {orgId} · assignedOrg: {String(job?.assignedOrgId || "-")}</div>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Evidence</div>
            {isDev ? (
              <div className="flex items-center gap-2">
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
                  onClick={() => setThumbDebugOverlay((v) => !v)}
                >
                  {thumbDebugOverlay ? "Hide thumb debug" : "Show thumb debug"}
                </button>
              </div>
            ) : null}
          </div>
          {/* PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
              Sealed-record swap: when the incident is closed (pre-
              emptively known from incident.status, or reactively after
              a 409), replace the upload control with the calm inline
              sealed banner pointing at the addendum flow. The
              existing read-only evidence grid below still renders. */}
          {(() => {
            // PEAKOPS_JOBDETAIL_SEALED_GATE_V1 (PR 53)
            // Source the predicate from the hoisted isIncidentClosed
            // so this surface stays in sync with the Notes + Mark
            // Complete gates below.
            if (isIncidentClosed) {
              return (
                <SealedRecordPanel
                  variant="inlineBanner"
                  title={sealedAfterMutation ? "Record sealed mid-edit" : "Record sealed — upload disabled"}
                  body={
                    sealedAfterMutation
                      ? "This record was sealed while you were preparing the upload. Your photo was not attached. Use an addendum to file supplemental context."
                      : "Use an addendum to attach supplemental context. The original field record remains unchanged."
                  }
                  orgId={orgId}
                  incidentId={String(incidentId || "")}
                />
              );
            }
            return (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="job-detail-upload-input"
                  className={"px-3 py-1.5 rounded border text-xs " + (uploading ? "border-white/10 bg-white/5 text-gray-500 cursor-not-allowed" : "border-white/15 bg-white/5 text-gray-200 hover:bg-white/10 cursor-pointer")}
                >
                  {uploading ? "Uploading..." : "Upload photo"}
                </label>
                <input
                  id="job-detail-upload-input"
                  type="file"
                  accept="image/*,.heic,.heif"
                  onChange={onUpload}
                  disabled={uploading}
                  className="hidden"
                />
                <span className="text-xs text-gray-400">{uploadStatus}</span>
              </div>
            );
          })()}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {visibleEvidence.map((ev) => {
              const key = String(ev.id || "").trim();
              const src = String(thumbUrlByKey[key] || "").trim();
              return (
                <div key={ev.id} className="rounded border border-white/10 bg-black/25 p-2">
                  <div className="text-[11px] truncate text-gray-300">{String(ev?.file?.originalName || ev?.fileName || ev?.label || ev?.id || "Untitled evidence")}</div>
                  {src ? (
                    <button
                      type="button"
                      className="mt-1 block w-full text-left cursor-pointer group"
                      onClick={() =>
                        setPreviewOpen({
                          src,
                          name: String(ev?.file?.originalName || ev?.fileName || ev?.label || ev?.id || "Untitled evidence"),
                        })
                      }
                    >
                      <div className="relative aspect-[4/3] w-full overflow-hidden rounded border border-white/10 transition-colors group-hover:border-white/25">
                        <div className="absolute right-1.5 top-1.5 z-10 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-gray-100 opacity-0 transition-opacity group-hover:opacity-100">
                          Preview
                        </div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt={String(ev?.file?.originalName || ev?.fileName || ev?.label || ev?.id || "Untitled evidence")}
                          className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                          onError={() => { void renewThumbOnce(ev, src); }}
                        />
                      </div>
                    </button>
                  ) : (
                    <div className="mt-1 aspect-[4/3] w-full rounded bg-white/5 border border-white/10 flex items-center justify-center text-[11px] text-gray-500">
                      no image
                    </div>
                  )}
                  {isDev && thumbErrById[key] ? (
                    <div className="mt-1 text-[10px] text-amber-300 break-all">{thumbErrById[key]}</div>
                  ) : null}
                  {isDev && thumbDebugOverlay ? (
                    <div className="mt-1 text-[10px] text-cyan-200 break-all">
                      id={key}
                      <br />
                      bucket={String(thumbBucketById[key] || "")}
                      <br />
                      path={String(thumbPathById[key] || "")}
                      <br />
                      mint_http={String(thumbStatusById[key] || 0)}
                      <br />
                      mint_error={String(thumbMintErrorById[key] || "-")}
                      <br />
                      probe_http={String(thumbProbeStatusById[key] || "-")}
                      <br />
                      probe_error={String(thumbProbeErrorById[key] || "-")}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {visibleEvidence.length === 0 ? <div className="text-xs text-gray-400">No evidence linked to this job yet.</div> : null}
          </div>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
          <div className="text-sm font-medium">Notes</div>
          {/* PEAKOPS_JOBDETAIL_SEALED_GATE_V1 (PR 53)
              Closed-record gate. When the incident is sealed, the
              entire mutation surface (textarea + Save Notes + Mark
              Complete) collapses to a calm SealedRecordPanel that
              points the supervisor at the addendum flow. The textarea
              still shows the prior notes as a read-only audit view so
              context isn't hidden — only the ability to mutate is
              removed. Mirrors the upload section's pattern + matches
              NotesClient's sealed handling (PR 42). */}
          {isIncidentClosed ? (
            <>
              <SealedRecordPanel
                variant="inlineBanner"
                title={
                  sealedAfterMutation
                    ? "Record sealed mid-edit"
                    : "Record sealed — notes locked"
                }
                body={
                  sealedAfterMutation
                    ? "This record was sealed while you were editing. Save Notes and Mark Complete are no longer available. Use an addendum for supplemental context."
                    : "This operational record is finalized. Job notes and completion state are immutable. Use an addendum to attach post-closure context."
                }
                orgId={orgId}
                incidentId={String(incidentId || "")}
              />
              <textarea
                className="w-full min-h-[120px] rounded border border-white/10 bg-black/30 px-3 py-2 text-sm opacity-80 cursor-not-allowed"
                value={notes}
                readOnly
                aria-readonly="true"
                placeholder="Job notes"
              />
            </>
          ) : (
            <>
              <textarea
                className="w-full min-h-[120px] rounded border border-white/15 bg-black/40 px-3 py-2 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Job notes"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded border border-white/15 bg-white/5 text-sm disabled:opacity-50"
                  onClick={saveNotes}
                  disabled={savingNotes || loading}
                >
                  {savingNotes ? "Saving..." : "Save Notes"}
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded border border-emerald-300/30 bg-emerald-600/20 text-sm disabled:opacity-50"
                  onClick={markComplete}
                  disabled={markingComplete || loading || !canMarkComplete}
                >
                  {markingComplete ? "Completing..." : "Mark Complete"}
                </button>
              </div>
            </>
          )}
        </section>

        <div className="text-xs text-gray-500">{loading ? "Loading..." : ""}</div>
      </div>
      {previewOpen ? (
        <div className="fixed inset-0 z-50 bg-black/80 p-4 md:p-8 flex items-center justify-center">
          <div className="max-w-5xl w-full rounded-xl border border-white/15 bg-[#0A0E14] p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-gray-200 truncate">{previewOpen.name}</div>
              <button
                type="button"
                className="px-3 py-1.5 rounded border border-white/15 bg-white/5 text-sm"
                onClick={() => setPreviewOpen(null)}
              >
                Close
              </button>
            </div>
            <div className="w-full max-h-[80vh] overflow-auto rounded border border-white/10 bg-black/30">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewOpen.src} alt={previewOpen.name} className="w-full h-auto object-contain" />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
