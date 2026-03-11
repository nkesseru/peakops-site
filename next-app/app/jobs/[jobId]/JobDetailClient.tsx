"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getFunctionsBase } from "@/lib/functionsBase";
import { uploadEvidence } from "@/lib/evidence/uploadEvidence";
import { getBestEvidenceImageRef, getThumbExpiresSec, logThumbEvent, mintEvidenceReadUrl, probeMintedThumbUrl } from "@/lib/evidence/signedThumb";

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
  const res = await fetch(url, {
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
  const [orgId, setOrgId] = useState(String(initialOrgId || "").trim() || "riverbend-electric");
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
        `&actorUid=${encodeURIComponent(actorUid())}` +
        `&actorRole=${encodeURIComponent(actorRole())}`;
      const res = await fetch(url);
      const txt = await res.text();
      const out = txt ? JSON.parse(txt) : {};
      if (!res.ok || !out?.ok) throw new Error(out?.error || `getJobV1 failed (${res.status})`);
      setJob(out.job || null);
      setIncident(out.incident || null);
      setEvidence(Array.isArray(out.evidence) ? out.evidence : []);
      setNotes(String(out?.job?.notes || ""));
      const assignedOrg = String(out?.job?.assignedOrgId || "").trim();
      const incidentOrg = String(out?.incident?.orgId || "").trim();
      const preferredOrg = assignedOrg || incidentOrg;
      if (preferredOrg && preferredOrg !== orgId) {
        setOrgId(preferredOrg);
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
        const ref = getBestEvidenceImageRef(ev);
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
            evidenceId: key,
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
  }, [evidence, incidentId, orgId, thumbUrlByKey]);

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
    const ref = getBestEvidenceImageRef(ev);
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
      evidenceId: id,
      bucket: ref.bucket,
      storagePath: ref.storagePath,
      expiresSec: getThumbExpiresSec(),
    });
    if (out?.ok && out.url) {
      const sep = out.url.includes("?") ? "&" : "?";
      const fresh = `${out.url}${sep}v=${Date.now()}`;
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
      await postJson(`${functionsBase}/updateJobNotesV1`, {
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
      await postJson(`${functionsBase}/markJobCompleteV1`, {
        orgId,
        incidentId,
        jobId,
        actorUid: actorUid(),
        actorRole: actorRole(),
        actorEmail: actorEmail(),
      });
      await refresh();
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
          <div className="flex items-center gap-2">
            <span className={"px-2 py-0.5 rounded-full border text-xs " + statusChip(fmtStatus(job?.status))}>
              {fmtStatus(job?.status)}
            </span>
            <span className="text-xs text-gray-400">incident: {incident?.title || incident?.id || incidentId || "-"}</span>
            <span className="text-xs text-gray-400">incidentStatus: {String(incident?.status || "-")}</span>
          </div>
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
          <div className="flex items-center gap-2">
            <input type="file" accept="image/*,.heic,.heif" onChange={onUpload} disabled={uploading} />
            <span className="text-xs text-gray-400">{uploadStatus}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {evidence.map((ev) => {
              const key = String(ev.id || "").trim();
              const src = String(thumbUrlByKey[key] || "").trim();
              return (
                <div key={ev.id} className="rounded border border-white/10 bg-black/25 p-2">
                  <div className="text-[11px] truncate text-gray-300">{String(ev?.file?.originalName || ev.id)}</div>
                  {src ? (
                    <button
                      type="button"
                      className="mt-1 block w-full text-left cursor-pointer group"
                      onClick={() =>
                        setPreviewOpen({
                          src,
                          name: String(ev?.file?.originalName || ev.id),
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
                          alt={String(ev?.file?.originalName || ev.id)}
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
            {evidence.length === 0 ? <div className="text-xs text-gray-400">No evidence linked to this job yet.</div> : null}
          </div>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
          <div className="text-sm font-medium">Notes</div>
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
