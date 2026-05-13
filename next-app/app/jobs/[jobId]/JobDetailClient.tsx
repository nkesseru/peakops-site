"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getFunctionsBase } from "@/lib/functionsBase";
import { uploadEvidence } from "@/lib/evidence/uploadEvidence";
import { getBestEvidenceImageRef, getBestEvidencePreviewRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";
import { incidentStatusLabel } from "@/lib/incidents/incidentStatus";
// PEAKOPS_JOB_DETAIL_AUTH_V1 (2026-05-08) — Slice Start Job 1.3.
// Production smoke caught markJobCompleteV1 returning 401 Missing
// Authorization header. Root cause: this file's local postJson +
// refresh() were using bare fetch() without the Firebase ID token.
// Route every /api/fn/* call through authedFetch so the
// enforceOrgAndProxy chain accepts them, matching the pattern
// IncidentClient established in Slice 17 / 17C.
import { authedFetch } from "@/../lib/apiClient";
import { logAnalyticsEvent } from "@/../lib/analytics";

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

// PEAKOPS_TASK_STATUS_HUMANIZE_V1 (2026-04-29)
// Customer-facing label for raw lifecycle tokens. Never render the
// underlying string ("complete", "in_progress", "approved", …) directly.
function humanizeTaskStatus(s: string): string {
  switch (String(s || "").toLowerCase()) {
    case "open": return "Open";
    case "assigned": return "Assigned";
    case "in_progress":
    case "in-progress": return "In progress";
    case "complete": return "Complete";
    case "review": return "In review";
    case "approved": return "Approved";
    case "rejected":
    case "revision_requested": return "Sent back";
    default: return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Open";
  }
}

function statusChip(status: string) {
  if (status === "complete") return "bg-emerald-500/15 border-emerald-300/30 text-emerald-100";
  if (status === "assigned") return "bg-blue-500/15 border-blue-300/30 text-blue-100";
  if (status === "in_progress") return "bg-cyan-500/15 border-cyan-300/30 text-cyan-100";
  if (status === "open") return "bg-white/10 border-white/20 text-gray-200";
  return "bg-white/10 border-white/20 text-gray-200";
}

function actorUid() {
  try {
    return String(localStorage.getItem("peakops_uid") || "tech_web").trim();
  } catch {
    return "tech_web";
  }
}

function actorRole() {
  try {
    return String(localStorage.getItem("peakops_role") || "field").trim().toLowerCase();
  } catch {
    return "field";
  }
}

function actorEmail() {
  try {
    return String(localStorage.getItem("peakops_email") || "").trim();
  } catch {
    return "";
  }
}

async function postJson<T>(url: string, body: any): Promise<T> {
  // PEAKOPS_JOB_DETAIL_AUTH_V1 (2026-05-08) — must use authedFetch.
  // Bare fetch was producing 401 Missing Authorization on
  // markJobCompleteV1 / updateJobNotesV1 in production. Proxy-side
  // enforceOrgAndProxy validates the Firebase ID token and only
  // accepts requests that carry it.
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
  // PEAKOPS_JOB_DETAIL_ORGID_V1
  // orgId comes from the URL via initialOrgId (the parent page reads ?orgId=
  // and passes it as a prop). No hardcoded fallback — if the URL has no
  // ?orgId=, downstream API calls target an empty org and surface a clear
  // "orgId required" error instead of silently cross-fetching from a random
  // default org.
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
  const [thumbBrokenById, setThumbBrokenById] = useState<Record<string, boolean>>({});
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
    // PEAKOPS_JOB_DETAIL_AUTH_V1 (2026-05-08) — route through the
    // Vercel /api/fn/* proxy via authedFetch, NOT a direct cloud-
    // function URL. The direct-URL pattern (a) skipped the bearer
    // token and (b) required a non-empty getFunctionsBase() — both
    // of which broke this page in production. The relative path
    // works regardless of env-var config and the proxy injects the
    // server-derived actor identity from the verified token, so
    // actorUid / actorRole query params drop here too.
    if (!incidentId) {
      setErr("This page is missing incident context. Open it from a task tile on the incident page.");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const url =
        `/api/fn/getJobV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&jobId=${encodeURIComponent(jobId)}`;
      const res = await authedFetch(url);
      const txt = await res.text();
      const out = txt ? JSON.parse(txt) : {};
      if (!res.ok || !out?.ok) throw new Error(out?.error || `getJobV1 failed (${res.status})`);
      setJob(out.job || null);
      setIncident(out.incident || null);
      setEvidence(Array.isArray(out.evidence) ? out.evidence : []);
      setNotes(String(out?.job?.notes || ""));
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

  useEffect(() => {
    let cancelled = false;
    async function resolveThumbs() {
      if (!incidentId || !orgId) return;
      for (const ev of evidence) {
        const ref = getBestEvidencePreviewRef(ev);
        const key = String(ev.id || "").trim();
        if (!ref?.storagePath || !ref?.bucket || thumbUrlByKey[key] || thumbBrokenById[key]) continue;
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
            setThumbBrokenById((m) => ({ ...m, [key]: false }));
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
  }, [evidence, incidentId, orgId, thumbUrlByKey, thumbBrokenById]);

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
      const sep = out.url.includes("?") ? "&" : "?";
      const fresh = `${out.url}${sep}v=${Date.now()}`;
      setThumbUrlByKey((m) => ({ ...m, [id]: fresh }));
      setThumbBrokenById((m) => ({ ...m, [id]: false }));
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
      (evidence || []).forEach((ev) => {
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

  async function saveNotes() {
    if (!functionsBase || !incidentId) return;
    try {
      setSavingNotes(true);
      await postJson(`/api/fn/updateJobNotesV1`, {
        orgId,
        incidentId,
        jobId,
        notes,
        actorUid: actorUid(),
        actorRole: actorRole(),
        actorEmail: actorEmail(),
      });
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSavingNotes(false);
    }
  }

  async function markComplete() {
    if (!functionsBase || !incidentId) return;
    try {
      setMarkingComplete(true);
      await postJson(`/api/fn/markJobCompleteV1`, {
        orgId,
        incidentId,
        jobId,
        assignedOrgId: String(job?.assignedOrgId || "").trim() || undefined,
        actorUid: actorUid(),
        actorRole: actorRole(),
        actorEmail: actorEmail(),
      });
      void logAnalyticsEvent("JOB_COMPLETED", {
        incidentId,
        orgId,
        jobId,
      });
      await refresh();
      if (incidentId) router.push(`/incidents/${encodeURIComponent(incidentId)}`);
      else router.back();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setMarkingComplete(false);
    }
  }

  async function onUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file || !functionsBase || !incidentId) return;
    try {
      setUploading(true);
      setUploadStatus("Preparing upload...");
      await uploadEvidence({
        functionsBase,
        techUserId: actorUid(),
        orgId,
        incidentId,
        phase: "INSPECTION",
        labels: ["DAMAGE"],
        notes: "",
        file,
        jobId,
        onStatus: (s) => setUploadStatus(s),
      });
      await refresh();
      setUploadStatus("Uploaded");
    } catch (e: any) {
      setErr(String(e?.message || e));
      setUploadStatus("Upload failed");
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  return (
    <main className="min-h-screen bg-[#0A0E14] text-gray-100 px-4 py-5 md:px-8">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400">Task</div>
            {/* PEAKOPS_JOB_DETAIL_HYDRATION_V1 (2026-05-08) —
                Slice Start Job 1.3. Show a neutral loading state
                instead of the "Task" placeholder while the initial
                refresh is in flight. The placeholder reads as
                "Task" only when there's no job AND we're not
                loading (rare — error / not-found cases). */}
            <h1 className="text-xl font-semibold">
              {job?.title
                ? job.title
                : (loading ? <span className="text-gray-400">Loading…</span> : "Task")}
            </h1>
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
          <div className="flex items-center gap-2 flex-wrap">
            <span className={"px-2 py-0.5 rounded-full border text-xs " + statusChip(fmtStatus(job?.status))}>
              {humanizeTaskStatus(fmtStatus(job?.status))}
            </span>
            {incident?.title ? (
              <span className="text-xs text-gray-400">on {incident.title}</span>
            ) : null}
            {incident ? (
              <span className="text-xs text-gray-400">· {incidentStatusLabel(incident?.status)}</span>
            ) : null}
          </div>
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {evidence.map((ev) => {
              const key = String(ev.id || "").trim();
              const src = String(thumbUrlByKey[key] || "").trim();
              const thumbBroken = !!thumbBrokenById[key];
              return (
                <div key={ev.id} className="rounded border border-white/10 bg-black/25 p-2">
                  <div className="text-[11px] truncate text-gray-300">{String(ev?.file?.originalName || "Photo")}</div>
                  {src && !thumbBroken ? (
                    <button
                      type="button"
                      className="mt-1 block w-full text-left cursor-pointer group"
                      onClick={() =>
                        setPreviewOpen({
                          src,
                          name: String(ev?.file?.originalName || "Photo"),
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
                          alt={String(ev?.file?.originalName || "Photo")}
                          className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                          onError={() => {
                            setThumbBrokenById((m) => ({ ...m, [key]: true }));
                            if (!isEmulatorThumbMode && Number(thumbRetryById[key] || 0) < 1) {
                              void renewThumbOnce(ev, src);
                            }
                          }}
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
            {/* PEAKOPS_JOB_DETAIL_HYDRATION_V1 (2026-05-08) —
                "No evidence attached" only when the load has
                actually completed. While loading is in flight, show
                a quiet skeleton so the buyer doesn't see a false
                empty state during the post-redirect hydration race. */}
            {evidence.length === 0 ? (
              loading ? (
                <div className="text-xs text-gray-400">Loading evidence…</div>
              ) : (
                <div className="text-xs text-gray-400">No evidence attached to this task yet.</div>
              )
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
          <div className="text-sm font-medium">Notes</div>
          <textarea
            className="w-full min-h-[120px] rounded border border-white/15 bg-black/40 px-3 py-2 text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Task notes"
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
