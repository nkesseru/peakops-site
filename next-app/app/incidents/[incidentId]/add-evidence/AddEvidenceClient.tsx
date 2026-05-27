"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { uploadEvidence } from "@/lib/evidence/uploadEvidence";
import { getFunctionsBase } from "@/lib/functionsBase";
import { authedFetch } from "@/lib/apiClient";
import { SealedRecordPanel } from "@/components/sealedRecord/SealedRecordPanel";
// PR 88 — AppTopBar shell consistency on /add-evidence + archetype-aware
// required-proof checklist driven by getArchetypeDetails.
import AppTopBar from "@/components/AppTopBar";
import { getArchetypeDetails } from "@/lib/incidents/newIncidentDraft";
// PR 90 — snapshot-first requirements resolver. Reads
// incident.requirements (PR 89a backend) when present, falls back
// to the archetype catalog for legacy records.
import { effectiveRequirements } from "@/lib/incidents/requirementsSnapshot";
type Item = { id: string; file: File; url: string };
type JobLite = { id: string; jobId?: string; title?: string; rawStatus?: string; status?: string };

function makeId() {
  return "ev_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

export default function AddEvidenceClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const sp = useSearchParams();

  // Queue of captured/selected media
  const [items, setItems] = useState<Item[]>([]);
const [mounted, setMounted] = useState(false);
useEffect(() => {
  setMounted(true);
}, []);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [sessionId, setSessionId] = useState<string>("");
  const [sessionBusy, setSessionBusy] = useState(false);

  // Camera
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [jobs, setJobs] = useState<JobLite[]>([]);
  // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
  // Pre-emptive incident.status fetch so we render the sealed-record
  // panel from the first paint when the record is closed, instead of
  // letting the user start camera/file flows that will 409 server-side.
  // sealedAfterMutation covers the reactive case where the record gets
  // sealed mid-edit while the user is on this page.
  const [incidentStatus, setIncidentStatus] = useState<string>("");
  // PEAKOPS_PROOF_CAPTURE_TITLE_V1 (PR 72) — surface the real record
  // title from getIncidentV1 instead of a truncated incidentId.
  const [incidentTitle, setIncidentTitle] = useState<string>("");
  // PR 88 — capture archetype from the same getIncidentV1 round-trip so
  // the required-proof checklist below the header can read it.
  const [incidentArchetype, setIncidentArchetype] = useState<string>("");
  // PR 88 — capture location too so the meta line has real content.
  const [incidentLocation, setIncidentLocation] = useState<string>("");
  // PR 90 — snapshot field plumbed from getIncidentV1. When present,
  // effectiveRequirements() prefers it over the archetype catalog
  // so historical records stay frozen on their creation-time
  // requirements contract.
  const [incidentRequirements, setIncidentRequirements] = useState<any>(null);
  const [sealedAfterMutation, setSealedAfterMutation] = useState(false);

  // Env / context
  const functionsBase = getFunctionsBase();
  const fnProxyBase = "/api/fn";
  const [selectedJobId, setSelectedJobId] = useState("");
  const techUserId = process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web";

// Prefer orgId from query (?orgId=...), else localStorage, else riverbend-electric (your demo org)
  const orgId = useMemo(() => {
    const q = String(sp?.get("orgId") || "").trim();
    if (q) return q;
    try {
      const v = String(localStorage.getItem("peakops_orgId") || "").trim();
      if (v) return v;
    } catch {}
    return "riverbend-electric";
  }, [sp]);

  useEffect(() => {
    let cancelled = false;

    async function loadJobsAndResolve() {
      try {
        const queryJobId = String(sp?.get("jobId") || "").trim();

        let localJobId = "";
        try {
          localJobId = String(localStorage.getItem(`peakops_current_job_${String(incidentId || "").trim()}`) || "").trim();
        } catch {}

        const res = await fetch(
          `/api/fn/listJobsV1?orgId=${encodeURIComponent(String(orgId || "").trim())}&incidentId=${encodeURIComponent(String(incidentId || "").trim())}&limit=50&actorUid=dev-admin&actorRole=admin`,
          { cache: "no-store" }
        );

        const out = await res.json().catch(() => ({}));
        const docs = Array.isArray(out?.docs) ? out.docs : [];

        if (cancelled) return;
        setJobs(docs);

        const normalized = docs
          .map((j: any) => ({
            raw: j,
            id: String(j?.id || j?.jobId || "").trim(),
            status: String(j?.status || j?.rawStatus || "").trim().toLowerCase(),
          }))
          .filter((j: any) => j.id);

        const chosen =
          normalized.find((j: any) => j.id === queryJobId) ||
          normalized.find((j: any) => j.id === localJobId) ||
          normalized.find((j: any) => j.status === "open") ||
          normalized.find((j: any) => j.status === "in_progress" || j.status === "in-progress") ||
          normalized[0];

        const chosenId = String(chosen?.id || "").trim();
        if (chosenId) {
          setSelectedJobId(chosenId);
          try {
            localStorage.setItem(`peakops_current_job_${String(incidentId || "").trim()}`, chosenId);
          } catch {}
        }
      } catch (e) {
        console.warn("[add-evidence] loadJobsAndResolve failed", e);
      }
    }

    void loadJobsAndResolve();
    return () => {
      cancelled = true;
    };
  }, [incidentId, orgId, sp]);

  // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
  // Pre-emptive incident-status check. Defense-in-depth: even though
  // the backend mutation gate (PR 41) rejects sealed-record writes,
  // surfacing the sealed UI before the user attempts any action is
  // calmer and avoids any time spent in the camera/file flow.
  useEffect(() => {
    let cancelled = false;
    async function loadIncidentStatus() {
      if (!incidentId || !orgId) return;
      try {
        const res = await authedFetch(
          `/api/fn/getIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const txt = await res.text().catch(() => "");
        const out: any = txt ? JSON.parse(txt) : {};
        if (cancelled) return;
        const s = String(out?.doc?.status || "").toLowerCase();
        if (s) setIncidentStatus(s);
        const t = String(out?.doc?.title || "").trim();
        if (t) setIncidentTitle(t);
        // PR 88 — archetype + location plumbed from the same call.
        setIncidentArchetype(String(out?.doc?.archetype || "").trim());
        setIncidentLocation(String(out?.doc?.location || "").trim());
        // PR 90 — snapshot requirements plumbed from the same call.
        // Stored opaque; effectiveRequirements() validates the shape.
        if (out?.doc?.requirements && typeof out.doc.requirements === "object") {
          setIncidentRequirements(out.doc.requirements);
        } else {
          setIncidentRequirements(null);
        }
      } catch {
        // tolerate — fall back to reactive 409 handling
      }
    }
    void loadIncidentStatus();
    return () => {
      cancelled = true;
    };
  }, [incidentId, orgId]);

  useEffect(() => {
    const jid = String(selectedJobId || "").trim();
    const key = `peakops_current_job_${String(incidentId || "").trim()}`;
    try {
      if (jid) localStorage.setItem(key, jid);
    } catch {}
  }, [selectedJobId, incidentId]);

  

  useEffect(() => {
    let cancelled = false;
    async function ensureSession() {
      if (!functionsBase || !orgId || !incidentId) return;
      const existing = String(sp?.get("sid") || "").trim();
      if (existing) {
        if (!cancelled) {
          setSessionId(existing);
          setStatus("");
        }
        return;
      }
      let localSid = "";
      try { localSid = String(localStorage.getItem("peakops_active_session_" + String(incidentId || "")) || "").trim(); } catch {}
      if (localSid) {
        if (!cancelled) {
          setSessionId(localSid);
          setStatus("");
        }
        return;
      }
      if (!cancelled) {
        setSessionBusy(true);
        setStatus("Starting session…");
      }
      try {
        const res = await fetch(`${fnProxyBase}/startFieldSessionV1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orgId,
            incidentId,
            createdBy: "ui",
            techUserId,
            phase: "inspection",
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out?.ok || !out?.sessionId) {
          throw new Error(out?.error || `Could not start field session (${res.status})`);
        }
        const sid = String(out.sessionId || "").trim();
        if (!sid) throw new Error("startFieldSessionV1 returned no sessionId");
        try { localStorage.setItem("peakops_active_session_" + String(incidentId || ""), sid); } catch {}
        if (!cancelled) {
          setSessionId(sid);
          setStatus("");
        }
      } catch (e: any) {
        if (!cancelled) {
          const m = String(e?.message || e || "session_start_failed");
          setErrMsg(m);
          setStatus("Session start failed");
        }
      } finally {
        if (!cancelled) setSessionBusy(false);
      }
    }
    void ensureSession();
    return () => {
      cancelled = true;
    };
  }, [functionsBase, orgId, incidentId, sp, techUserId]);

  useEffect(() => {
    // Cleanup camera + blob urls
    return () => {
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      streamRef.current = null;
      try {
        items.forEach((it) => URL.revokeObjectURL(it.url));
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openCamera() {
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      streamRef.current = stream;
      setCameraOpen(true);

      const v = videoRef.current;
      if (v) {
        v.muted = true;
        // @ts-ignore
        v.playsInline = true;
        v.autoplay = true;
        // @ts-ignore
        v.srcObject = stream;

        v.onloadedmetadata = async () => {
          try {
            await new Promise((r) => setTimeout(r, 80));
            await v.play();
          } catch (err) {
            console.warn("video.play() failed", err);
          }
        };
      }
    } catch (e: any) {
      console.error(e);
      setCameraError(e?.message || String(e));
      setCameraOpen(false);
    }
  }

  function closeCamera() {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    streamRef.current = null;
    setCameraOpen(false);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video) return;

    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, w, h);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const f = new File([blob], `capture_${Date.now()}.jpg`, { type: "image/jpeg" });
        const url = URL.createObjectURL(f);
        const id = makeId();
        setItems((prev) => [{ id, file: f, url }, ...prev]);
        // keep camera open for rapid multi-capture
      },
      "image/jpeg",
      0.92
    );
  }

  function addPickedFiles(fileList: FileList | null | undefined) {
    if (!fileList || !fileList.length) return;
    const next: Item[] = [];
    for (const f of Array.from(fileList)) {
      const url = URL.createObjectURL(f);
      next.push({ id: makeId(), file: f, url });
    }
    setItems((prev) => [...next, ...prev]);
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it) {
        try { URL.revokeObjectURL(it.url); } catch {}
      }
      return prev.filter((x) => x.id !== id);
    });
  }

  async function uploadOne(it: Item) {
    if (!selectedJobId) throw new Error("No job selected. Return to incident page and pick My job first.");
    if (!sessionId) throw new Error("Session not ready yet. Please wait for 'Starting session…' to finish.");
    await uploadEvidence({
      functionsBase: fnProxyBase,
      techUserId,
      orgId,
      incidentId,
      phase: "inspection",
      labels: ["damage"],
      jobId: selectedJobId,
      sessionId,
      file: it.file,
      onStatus: setStatus,
    });
  }

  async function uploadAll() {
    if (!items.length) return;
    setBusy(true);
    setErrMsg("");
    setStatus("Preparing…");
    try {
      // Sequential upload = fewer edge cases; fastest path to “enterprise reliable”
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        setStatus(`Uploading ${items.length - i}/${items.length}…`);
        await uploadOne(it);
      }
      setStatus("Secured ✔️");
      // Clear queue
      setItems((prev) => {
        try { prev.forEach((x) => URL.revokeObjectURL(x.url)); } catch {}
        return [];
      });
      // Back to incident
      setTimeout(() => router.push(`/incidents/${incidentId}`), 350);
    } catch (e: any) {
      console.error("UPLOAD FAIL", e);
      const m = (e && (e.message || e.toString())) || String(e);
      // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
      // Reactive 409: if the record was sealed while the user was
      // staging uploads, surface the calm sealed-state panel instead
      // of a generic alert. The check covers both the JSON error
      // body ("incident_closed") and the HTTP status path.
      if (/incident_closed/i.test(m) || / 409 /.test(m)) {
        setSealedAfterMutation(true);
        setStatus("");
        return;
      }
      setErrMsg(m);
      setStatus("");
      alert(m);
    } finally {
      setBusy(false);
    }
  }

  // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
  // Sealed-record full-page swap. Fires either pre-emptively (incident
  // status === "closed" on load) or reactively (a 409 came back from
  // the upload attempt). Either way the user sees a calm sealed panel
  // instead of the camera/file flow.
  const isSealed = incidentStatus === "closed" || sealedAfterMutation;
  if (isSealed) {
    return (
      <SealedRecordPanel
        variant="fullPage"
        title="Operational record sealed"
        body={
          sealedAfterMutation
            ? "This record was sealed while you were preparing uploads. Your photos were not attached. Use an addendum to file supplemental context."
            : "This record has been finalized. Supplemental context can be attached as an addendum without modifying the original field record."
        }
        orgId={orgId}
        incidentId={incidentId}
      />
    );
  }

  return (
    <main className="min-h-screen bg-black text-white">
      {/* PR 88 — AppTopBar shell consistency. Was missing on this
          surface, leaving the page floating in a sea of black. */}
      <AppTopBar />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* PR 88 — calmer header. Title and PROOF CAPTURE eyebrow
            kept; the four debug-y meta lines (My job / Session /
            "No job bound yet" / Audit-safe capture / Jobs detected)
            collapsed into one quiet meta row that surfaces location
            + the audit-safe trust signal. The session / job state
            still drives the disable conditions below; we just don't
            need to spam those internals on the surface. */}
        <header className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Proof capture
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold leading-tight tracking-tight text-white">
            {incidentTitle || `Field record ${incidentId.slice(-6)}`}
          </h1>
          <div className="text-[12px] text-gray-400">
            {incidentLocation ? (
              <>
                {incidentLocation}
                <span aria-hidden="true" className="text-white/20 mx-2">·</span>
              </>
            ) : null}
            <span>Audit-safe capture · auto-tagged · time-locked</span>
          </div>
          {!selectedJobId && mounted ? (
            <div className="text-[11px] text-amber-200/80">
              {sessionBusy ? "Starting session…" : "Binding to an active job…"}
            </div>
          ) : null}
        </header>

        {/* PR 88 + PR 90 — Required-proof panel.
            Data source resolved by effectiveRequirements():
              1. incident.requirements snapshot (PR 89a, frozen at
                 creation) — wins when present, even if the static
                 catalog has drifted since then.
              2. Static archetype catalog — fallback for legacy
                 records created before PR 89a or for archetypes
                 the backend mirror doesn't know about yet.
              3. Nothing — panel doesn't render.
            The archetype label still reads from the static catalog
            for the subtitle (legacy records keep their friendly
            label even when snapshot wins). */}
        {(() => {
          const requirements = effectiveRequirements({
            archetype: incidentArchetype,
            requirements: incidentRequirements,
          });
          if (requirements.source === "none" || requirements.requiredProof.length === 0) {
            return null;
          }
          const details = getArchetypeDetails(incidentArchetype);
          const archetypeLabel = details?.label || "";
          const total = requirements.requiredProof.length;
          const captured = items.length;
          const complete = total > 0 && captured >= total;
          return (
            <section
              aria-label="Required proof for this work package"
              className="rounded-xl border border-amber-300/20 bg-amber-500/[0.04] px-4 py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-amber-200/70">
                    Required proof for this work package
                  </div>
                  {archetypeLabel ? (
                    <div className="text-[11px] text-gray-400 mt-0.5">
                      {archetypeLabel}
                    </div>
                  ) : null}
                </div>
                <div
                  className={
                    "shrink-0 text-[11px] font-semibold uppercase tracking-[0.10em] rounded-full border px-2 py-0.5 " +
                    (complete
                      ? "border-emerald-300/40 bg-emerald-500/15 text-emerald-100"
                      : "border-white/15 bg-white/[0.04] text-gray-200")
                  }
                  title="Items queued for capture this session"
                >
                  {captured} / {total} captured
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-[12px] text-gray-200">
                {requirements.requiredProof.map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span aria-hidden="true" className="text-emerald-300/70 mt-0.5">
                      ✓
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })()}

      {/* CAMERA MODE */}
      {cameraOpen && (
        <div className="space-y-3">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="w-full max-h-[55vh] object-contain rounded-xl border border-white/10 bg-black"
          />
          <div className="grid grid-cols-2 gap-3">
            <button
              className="w-full py-4 rounded-xl bg-green-600/90 border border-green-300/20 text-white font-semibold hover:bg-green-600 active:translate-y-[1px] transition"
              onClick={capturePhoto}
              disabled={busy}
            >
              Capture Photo
            </button>
            <button
              className="w-full py-4 bg-gray-800 active:bg-gray-700 rounded-xl font-semibold"
              onClick={closeCamera}
              disabled={busy}
            >
              Done
            </button>
          </div>
          {cameraError ? <div className="text-xs text-red-300">Camera error: {cameraError}</div> : null}
        </div>
      )}

      {/* PICK / QUEUE */}
      {!cameraOpen && (
        <div className="space-y-3">
          {/* PR 88 — replaced the orange-to-slate gradient with the
              calm white-on-dark primary used elsewhere in PeakOps
              (Capture proof, Create field record). The disabled
              state mutes to a quieter neutral so the button reads
              as "the primary action" without screaming at the
              operator. */}
          <button
            className={
              "w-full py-4 rounded-xl text-[14px] font-semibold transition " +
              (busy || sessionBusy || !sessionId
                ? "bg-white/10 text-gray-400 cursor-not-allowed"
                : "bg-white text-black hover:bg-white/90")
            }
            onClick={openCamera}
            disabled={busy || sessionBusy || !sessionId}
          >
            Open camera
          </button>

          <input
            id="pick"
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={(e) => {
              if (process.env.NODE_ENV !== "production") {
                console.warn("[add-evidence]", { step: "change", files: Number(e.target.files?.length || 0), ts: Date.now() });
              }
              addPickedFiles(e.target.files);
            }}
            className="hidden"
            disabled={busy || sessionBusy || !sessionId}
          />
          <button
            type="button"
            className="w-full py-5 flex items-center justify-center border-2 border-dashed border-white/20 rounded-xl text-gray-200 active:border-white/40"
            disabled={busy || sessionBusy || !sessionId}
            onClick={() => {
              if (process.env.NODE_ENV !== "production") {
                console.warn("[add-evidence]", {
                  step: "click",
                  disabled: busy || sessionBusy || !sessionId,
                  hasInput: !!fileInputRef.current,
                  isUserGesture: true,
                  ts: Date.now(),
                });
              }
              if (busy || sessionBusy || !sessionId) return;
              fileInputRef.current?.click();
              if (process.env.NODE_ENV !== "production") {
                console.warn("[add-evidence]", { step: "input_click", ts: Date.now() });
              }
            }}
          >
            Pick multiple photos/videos
          </button>

          {items.length ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-gray-200">
                  Queue: <span className="font-semibold">{items.length}</span>
                </div>
                <button
                  className="px-3 py-2 rounded-lg bg-white/6 border border-white/12 text-sm text-gray-200 hover:bg-white/10"
                  onClick={() => setItems((prev) => { try { prev.forEach((x) => URL.revokeObjectURL(x.url)); } catch {} return []; })}
                  disabled={busy}
                >
                  Clear
                </button>
              </div>

              <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
                {items.slice(0, 12).map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className="relative aspect-square rounded-lg overflow-hidden border border-white/10 bg-black"
                    onClick={() => removeItem(it.id)}
                    title="Remove"
                    disabled={busy}
                  >
                    {it.file.type.startsWith("video/") ? (
                      <div className="w-full h-full flex items-center justify-center text-xs text-gray-300">VIDEO</div>
                    ) : (
                      <img src={it.url} className="w-full h-full object-cover" />
                    )}
                    <div className="absolute bottom-0 left-0 right-0 text-[10px] bg-black/60 text-gray-100 px-1 py-0.5 truncate">
                      {it.file.name}
                    </div>
                  </button>
                ))}
              </div>

              <button
                className="mt-3 w-full py-4 rounded-xl bg-green-600/90 border border-green-300/20 text-white font-semibold hover:bg-green-600 active:translate-y-[1px] transition"
                onClick={uploadAll}
                disabled={busy || sessionBusy || !sessionId || !items.length || !selectedJobId}
                title={!selectedJobId ? "Return to the record and pick a work package first" : (items.length ? "Upload all queued proof items" : "Add proof items first")}
              >
                {busy ? (status || "Working…") : "Upload & secure proof"}
              </button>

              {status ? <div className="mt-2 text-sm text-gray-300">{status}</div> : null}
              {errMsg ? <div className="mt-2 text-sm text-red-300">{errMsg}</div> : null}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Tip: Open camera → capture proof items → Done → Upload &amp; secure proof.
            </p>
          )}
        </div>
      )}
      </div>
    </main>
  );
}
