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

function fmtAgoIso(iso?: string) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return fmtAgo(Math.floor(ms / 1000));
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
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
    if ((timelineCounts["job_approved"] || 0) < 2) {
      reasons.push("expected at least 2 job_approved events");
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
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
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
            {(incident as any)?.title || incidentId}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-gray-400">
            <span className={"text-[11px] px-2 py-0.5 rounded-full border " + incidentStatusPill(incident?.status || incidentStatus)}>
              {incidentStatusLabel(incident?.status || incidentStatus)}
            </span>
            <span className="text-white/20">·</span>
            <span>{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</span>
            <span className="text-white/20">·</span>
            <span>{evidence.length} {evidence.length === 1 ? "piece of evidence" : "pieces of evidence"}</span>
            {(incident as any)?.updatedAt?._seconds ? (
              <>
                <span className="text-white/20">·</span>
                <span>updated {fmtAgo((incident as any)?.updatedAt?._seconds)}</span>
              </>
            ) : null}
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
                  ⚠ integrity check · {truthMismatchReasons.length}
                </a>
              </>
            ) : null}
          </div>
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
              <span>Integrity check · {truthMismatchReasons.length} item{truthMismatchReasons.length === 1 ? "" : "s"}</span>
              <span className="text-[11px] text-amber-300/60 group-open:hidden">Show details</span>
              <span className="text-[11px] text-amber-300/60 hidden group-open:inline">Hide</span>
            </summary>
            <div className="mt-3 text-[12px] text-amber-100/85 space-y-1.5">
              {truthMismatchReasons.map((r, i) => (
                <div key={i}>· {r}</div>
              ))}
              <div className="pt-2 text-[11px] text-amber-200/60">
                Export should be treated as blocked until this is resolved.
              </div>
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

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Incident Status</div>
            <span className={"text-[11px] px-2 py-0.5 rounded-full border " + incidentStatusPill(incidentStatus)}>{incidentStatusLabel(incidentStatus)}</span>
          </div>
          <div className="mt-3">
            <button
              type="button"
              className={"px-3 py-2 rounded-xl text-sm border " + (!err && orgId && incidentId ? "bg-emerald-600/20 border-emerald-300/30 text-emerald-100 hover:bg-emerald-600/30" : "bg-white/5 border-white/10 text-gray-400")}
              disabled={artifactBusy || !orgId || !incidentId || !!err}
              onClick={() => { void handleArtifactDownload(); }}
              title={artifactHint}
            >
              {artifactBusy ? "Preparing Artifact..." : (artifactHint.toLowerCase().includes("ready") ? "Download Artifact" : artifactHint.toLowerCase().includes("building") ? "Artifact Building..." : "Generate Artifact")}
            </button>
            <div className="mt-2 text-xs text-gray-500">{artifactHint}</div>
            {lastArtifactFilename ? (
              <div className="mt-1 text-xs text-gray-500">
                Last artifact: {lastArtifactFilename} {lastArtifactAt ? `• ${lastArtifactAt}` : ""}
              </div>
            ) : null}
            <div className="mt-1 text-xs text-gray-500">
              Packet counts: evidence {incident?.packetMeta?.evidenceCount ?? packetEvidenceCount} • jobs {incident?.packetMeta?.jobCount ?? packetJobCount}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-400">Jobs Breakdown</div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {Object.entries(statusCounts).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                <div className="text-[10px] uppercase text-gray-400">{k}</div>
                <div className="text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-gray-400">Evidence by Job</div>
            {unassignedEvidenceCount > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-1 rounded-full border border-amber-300/30 bg-amber-500/15 text-amber-100">
                  {unassignedEvidenceCount} unassigned evidence
                </span>
                {(isDemoMode || process.env.NODE_ENV !== "production") ? (
                  <button
                    type="button"
                    className="text-[11px] px-2 py-1 rounded border border-amber-300/30 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
                    onClick={() => { void fixUnassignedEvidence(); }}
                    disabled={fixUnassignedBusy}
                  >
                    {fixUnassignedBusy ? "Fixing…" : "Fix unassigned"}
                  </button>
                ) : null}
              </div>
            ) : null}
            {process.env.NODE_ENV !== "production" ? (
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
            ) : null}
          </div>
          <div className="mt-3 space-y-3">
            {Object.keys(evidenceByJob).length === 0 ? (
              <div className="text-sm text-gray-400">No evidence found.</div>
            ) : Object.entries(evidenceByJob).map(([jobId, list]) => {
              const job = jobs.find((j) => String(j?.id || j?.jobId || "") === jobId);
              return (
                <div key={jobId} className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-100 truncate">{job ? String(job.title || jobId) : (jobId === "unassigned" ? "Unassigned" : jobId)}</div>
                    <span className="text-xs text-gray-400">{list.length} evidence</span>
                  </div>
                  <div className="mt-2 flex gap-2 overflow-x-auto">
                    {list.slice(0, 8).map((ev) => {
                      const id = String(ev.id || "");
                      const u = thumbUrl[id];
                      return (
                        <div key={id} className="relative min-w-[110px] w-[110px] aspect-[4/3] rounded-lg overflow-hidden border border-white/10 bg-black">
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
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-400">Timeline Highlights</div>
          <div className="mt-3 space-y-2">
            {timelineHighlights.length === 0 ? (
              <div className="text-sm text-gray-400">No highlights yet.</div>
            ) : timelineHighlights.map((t) => (
              <div key={t.id} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-gray-100">{String(t.type || "event")}</div>
                  <div className="text-xs text-gray-500 truncate">
                    actor: {String(t.actor || "system")} {t.refId ? `• ref: ${String(t.refId)}` : ""}
                  </div>
                </div>
                <div className="text-xs text-gray-500">{fmtAgo(t.occurredAt?._seconds)}</div>
              </div>
            ))}
          </div>
        </section>

        {loading ? <div className="text-xs text-gray-500">Refreshing summary…</div> : null}
      </div>
    </main>
    </>
  );
}
