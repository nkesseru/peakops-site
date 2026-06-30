"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { uploadEvidence } from "@/lib/evidence/uploadEvidence";
// PR 137B-2 — client-side HEIC → JPEG convert at capture time.
// Iron rule: never blocks capture. On failure/timeout, original HEIC
// is kept and surfaced in the tile as "Couldn't preview · original kept".
import { maybeConvertHeicToJpeg } from "@/lib/evidence/maybeConvertHeicToJpeg";
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
// PR 117 — shared slug helper, mirrored from functions_clean/_readiness.js.
// Was previously a local copy in this file; extracted so the Summary
// proof-slot dossier can use the same algorithm.
import { slugRequirement } from "@/lib/evidence/slugRequirement";
// PR 120b — provenance block ("Requirements source · <Customer> · <Archetype> · v<N>")
// rendered above the required-proof checklist so operators see where
// the requirements came from before they start capturing. Subsumes the
// PR 92 audit footer that previously sat below the checklist.
import { ProvenanceBlock } from "@/components/incident/ProvenanceBlock";

// PR 94b — Guided proof-slot assignment. A ProofSlot binds a queued
// photo to one specific entry in the incident's snapshotted
// requiredProof[]. Slot fields ride through uploadEvidence() to
// addEvidenceV1 (PR 94a backend). All four fields are optional on
// the backend; we either send all four or send none.
type ProofSlot = {
  requirementKey: string;     // slug(label), ^[a-z0-9-]{1,120}$
  requirementLabel: string;   // exact label from resolvedRequirements
  requirementSource: "customer_template" | "org_template" | "archetype";
  requirementIndex: number;   // position in resolvedRequirements.requiredProof
};
type Item = {
  id: string;
  file: File;
  url: string;
  slot?: ProofSlot;
  // PR 137B-2 — HEIC convert state. `optimizing` is true while the
  // background client-side convert is running; the upload button is
  // disabled while any item is optimizing. On convert failure or
  // timeout the original HEIC is kept (`originalRetained: true`) and
  // the tile shows the "original kept" badge.
  optimizing?: boolean;
  originalRetained?: boolean;
  convertReason?: string;
};
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
  // PR 94b — Active proof-slot the operator clicked into. Session-
  // bound: stays set while the camera is open so multi-angle captures
  // of the same required item all carry the same slot. Cleared on
  // closeCamera() (Done). File-picker path never touches this state.
  const [currentSlot, setCurrentSlot] = useState<ProofSlot | null>(null);
  const [jobs, setJobs] = useState<JobLite[]>([]);
  // PEAKOPS_NO_JOB_PROOF_V1 (PR 111)
  // True ONLY after listJobsV1 successfully returns. Distinguishes
  // "jobs loaded, none exist → allow record-level proof capture" from
  // "still loading / load failed → stay locked, do not assume no jobs."
  // Used by the Upload gate + the "Binding to an active job…" banner.
  const [jobsLoaded, setJobsLoaded] = useState(false);
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
  // PR 92 — customer field plumbed for the requirements-source
  // audit footer. When the snapshot source is "customer_template",
  // we display the human-readable customer name (not the slug).
  const [incidentCustomer, setIncidentCustomer] = useState<string>("");
  // PR 96 — Set of requirementKey slugs that have at least one
  // matching persisted evidence doc. Drives server-backed
  // satisfaction so the checklist survives queue clears + page
  // reloads. Merged with queue-local slot assignments in
  // requirementCaptureMap below.
  const [serverCapturedKeys, setServerCapturedKeys] = useState<Set<string>>(new Set());
  // PR 96 — Bumped after uploadAll success so the listEvidenceLocker
  // fetch re-runs and the panel reflects what we just persisted
  // before the redirect fires.
  const [refetchTick, setRefetchTick] = useState(0);
  const [sealedAfterMutation, setSealedAfterMutation] = useState(false);
  // PR 136B — post-upload confirmation panel state. Replaces the
  // prior 350ms auto-redirect (which gave the operator no time to
  // notice that their proof had been secured nor any guidance on
  // what to do next). Captured count is frozen at upload-success
  // time before the queue clear, so the panel reads e.g.
  // "✓ 3 items captured" even though items.length is now 0.
  const [uploadConfirmation, setUploadConfirmation] = useState<{ count: number } | null>(null);

  // PR 136D — desktop-aware primary capture button.
  //
  // The Phase 1 audit flagged the file-picker button as visually
  // de-emphasized (dashed border, lighter contrast) which made the
  // desktop sales-demo path feel like a second-class option. Field
  // operators on mobile want the camera primary — that's unchanged.
  // Sales demos run on desktop laptops, where the file-picker is
  // the only practical capture path even when getUserMedia is
  // exposed (Chrome on macOS exposes it but there's no usable rear
  // camera).
  //
  // Detection uses TWO signals (not just getUserMedia per the
  // literal spec, because desktop Chrome with a webcam exposes
  // getUserMedia and would otherwise stay camera-primary):
  //   - hasUserMedia      — navigator.mediaDevices.getUserMedia exists
  //   - coarsePointer     — primary input is touch (matchMedia
  //                         "(pointer: coarse)") → strong mobile signal
  //
  // Camera stays primary IFF both signals are true (mobile field
  // surface). Anything else (desktop, no camera, no touch) → file
  // picker becomes the primary styled button + appears first.
  //
  // Runtime fallback: cameraFailedAtRuntime is one-way; once a
  // getUserMedia attempt fails, file-picker stays primary for the
  // rest of the session (no flapping if the operator retries).
  const [filePickerPrimaryFlag, setFilePickerPrimaryFlag] = useState(false);
  const [cameraFailedAtRuntime, setCameraFailedAtRuntime] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const coarsePointer = (() => {
      try { return !!window.matchMedia?.("(pointer: coarse)")?.matches; }
      catch { return false; }
    })();
    // File-picker primary unless BOTH mobile signals fire.
    setFilePickerPrimaryFlag(!(hasUserMedia && coarsePointer));
  }, []);
  const filePickerPrimary = filePickerPrimaryFlag || cameraFailedAtRuntime;

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

        // PEAKOPS_AUTH_RACE_FIX_V1 (2026-05-01)
        // listJobsV1 + startFieldSessionV1 used to fire with a bare
        // fetch() before Firebase had hydrated the auth state, so the
        // first attempt 401'd ("Missing Authorization header") and a
        // retry was needed. authedFetch awaits getIdToken() — which
        // itself waits for onAuthStateChanged when currentUser is
        // briefly null after navigation — guaranteeing every call
        // carries a valid Bearer token. Ported from the deploy branch.
        const res = await authedFetch(
          `/api/fn/listJobsV1?orgId=${encodeURIComponent(String(orgId || "").trim())}&incidentId=${encodeURIComponent(String(incidentId || "").trim())}&limit=50&actorUid=dev-admin&actorRole=admin`,
          { cache: "no-store" }
        );

        const out = await res.json().catch(() => ({}));
        const docs = Array.isArray(out?.docs) ? out.docs : [];

        if (cancelled) return;
        setJobs(docs);
        // PR 111 — only flip jobsLoaded on the success path so a
        // listJobsV1 failure preserves today's pessimistic gate
        // behavior (Upload stays disabled, banner stays).
        setJobsLoaded(true);

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
        // PR 92 — customer plumbed for the requirements-source label.
        setIncidentCustomer(String(out?.doc?.customer || "").trim());
      } catch {
        // tolerate — fall back to reactive 409 handling
      }
    }
    void loadIncidentStatus();
    return () => {
      cancelled = true;
    };
  }, [incidentId, orgId]);

  // PR 96 — Server-backed required-proof satisfaction. Reads
  // persisted evidence docs once on mount and again after each
  // successful uploadAll (refetchTick), projecting requirementKey
  // values into a Set. The checklist merges this with queue-local
  // slot assignments below. Tolerant on failure: an empty Set just
  // means the panel falls back to PR 94b queue-local behavior, no
  // broken state. Uses the same /api/fn/listEvidenceLocker path
  // IncidentClient / SummaryClient / ReviewClient already rely on;
  // limit=200 matches Summary's pattern (PR 96 plan §4 risk 1 — if
  // incidents grow past 200 evidence docs we add server-side
  // projection in PR 96b).
  useEffect(() => {
    if (!incidentId || !orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(
          `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const out = await res.json().catch(() => ({}));
        const docs = Array.isArray(out?.docs) ? out.docs : [];
        const keys = new Set<string>();
        for (const d of docs) {
          const k = String(d?.requirementKey || "").trim();
          // Match the backend's own validation regex (PR 94a) so we
          // never project a malformed key into satisfaction state.
          if (/^[a-z0-9-]{1,120}$/.test(k)) keys.add(k);
        }
        if (!cancelled) setServerCapturedKeys(keys);
      } catch {
        // tolerate — checklist falls back to queue-local
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [incidentId, orgId, refetchTick]);

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
        // PEAKOPS_AUTH_RACE_FIX_V1 (2026-05-01)
        // authedFetch ensures the Firebase ID token is loaded
        // (waiting for onAuthStateChanged if currentUser is briefly
        // null after navigation) before this request fires. Stops the
        // first-photo "Missing Authorization header 401" race that
        // forced a retry on the second click. Ported from deploy.
        const res = await authedFetch(`${fnProxyBase}/startFieldSessionV1`, {
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
      // PR 136D — runtime fallback: once getUserMedia has failed
      // (permission denied, no camera attached, etc.), swap the
      // surface to file-picker-primary for the rest of the session
      // so the operator doesn't keep tapping a primary that won't
      // open. One-way flip — never reverts even on later retries.
      setCameraFailedAtRuntime(true);
    }
  }

  function closeCamera() {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    streamRef.current = null;
    setCameraOpen(false);
    // PR 94b — Done/Close clears the active slot so the next camera
    // open starts unassigned unless the operator explicitly picks a
    // requirement again.
    setCurrentSlot(null);
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
        // PR 94b — Camera-captured items inherit the current slot
        // (set by selectSlotAndOpen below). Bound at capture time so
        // the queued Item carries the slot even if the operator
        // closes the camera and the live currentSlot resets.
        const slot = currentSlot || undefined;
        setItems((prev) => [{ id, file: f, url, slot }, ...prev]);
        // PR 136B — dismiss the post-upload confirmation panel as
        // soon as a new capture activity starts; the panel is for
        // the just-completed upload, not the next one.
        setUploadConfirmation(null);
        // keep camera open for rapid multi-capture
      },
      "image/jpeg",
      0.92
    );
  }

  function addPickedFiles(fileList: FileList | null | undefined) {
    if (!fileList || !fileList.length) return;
    // PEAKOPS_FILE_PICKER_SLOT_INHERIT_V1 (PR 114)
    // File-picker items now inherit the active capture slot so gallery
    // uploads satisfy required-proof slots the same way camera captures
    // do. Pre-PR-114 picker items landed without a slot, so the
    // readiness evaluator (which keys on evidence.requirementKey) could
    // never see them as satisfying a required slot. Resolution order:
    //   1. currentSlot — explicit, set by selectSlotAndOpen for the
    //      camera path; rarely lingers, but prefer it if present
    //   2. nextTargetSlot — derived from the unsatisfied-slot checklist
    //      (matches the adaptive button label "Capture: <slot>")
    //   3. undefined — no unsatisfied slots, picker items stay
    //      unassigned (same as pre-PR-114 behavior for that case)
    const slot = currentSlot || nextTargetSlot || undefined;

    // PR 137B-2 — push items to the queue immediately so capture is
    // never blocked. HEIC items start as `optimizing: true` and run
    // the client-side convert in the background. The upload button
    // gates on `items.some(i => i.optimizing)` so the user can't
    // ship original HEIC bytes while a convert is still in flight.
    const next: Item[] = [];
    for (const f of Array.from(fileList)) {
      const heicCandidate =
        /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type);
      const url = URL.createObjectURL(f);
      next.push({
        id: makeId(),
        file: f,
        url,
        slot,
        optimizing: heicCandidate,
      });
    }
    setItems((prev) => [...next, ...prev]);
    // PR 136B — dismiss confirmation panel; new capture activity starts here.
    setUploadConfirmation(null);

    // PR 137B-2 — kick off convert in parallel for each HEIC item.
    // Each resolves independently and patches its item in place.
    for (const seed of next) {
      if (!seed.optimizing) continue;
      const seedId = seed.id;
      const originalFile = seed.file;
      void (async () => {
        const result = await maybeConvertHeicToJpeg(originalFile);
        setItems((prev) =>
          prev.map((it) => {
            if (it.id !== seedId) return it;
            // Revoke the now-obsolete blob URL before swapping it.
            try { URL.revokeObjectURL(it.url); } catch {}
            const newUrl = URL.createObjectURL(result.file);
            return {
              ...it,
              file: result.file,
              url: newUrl,
              optimizing: false,
              originalRetained: !result.converted,
              convertReason: result.reason,
            };
          })
        );
      })();
    }
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
    // PR 111 — Job binding is only required when the record actually
    // has jobs. Records with no jobs allow record-level proof (the
    // backend already accepts evidence docs with empty jobId — readers
    // render those as "Unassigned"). Empty `selectedJobId` is passed
    // through to the backend, which normalizes it as a no-op.
    if (jobs.length > 0 && !selectedJobId) throw new Error("Multiple jobs exist — pick one before uploading.");
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
      // PR 94b — Carry the per-item slot through to addEvidenceV1.
      // Camera-captured items inherit the active slot at capture
      // time; file-picker items always land unassigned.
      slot: it.slot,
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
      // PR 136B — capture the count BEFORE the queue clear so the
      // confirmation panel can show "✓ N items captured" honestly.
      const uploadedCount = items.length;
      setStatus("Secured ✔️");
      // Clear queue
      setItems((prev) => {
        try { prev.forEach((x) => URL.revokeObjectURL(x.url)); } catch {}
        return [];
      });
      // PR 96 — Bump refetchTick so the listEvidenceLocker effect
      // re-runs and the checklist reflects the proofs we just
      // persisted. Same as before — the satisfaction state is fresh
      // by the time the operator sees the confirmation panel.
      setRefetchTick((t) => t + 1);
      // PR 136B — replace the prior 350ms auto-redirect with a
      // persistent confirmation panel. The operator chooses what
      // happens next: "Next: write notes →" or "Back to incident".
      // No auto-redirect — non-technical first-timers were missing
      // the secured-✓ flash and the lack of guidance to write notes
      // was Gap #3 of the Phase 1 audit.
      setUploadConfirmation({ count: uploadedCount });
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

  // PR 93 — Hoisted from the panel IIFE so both the required-proof
  // panel AND the primary capture button can derive their text from
  // the same resolved requirements. Computing once also avoids the
  // helper running twice per render.
  const resolvedRequirements = effectiveRequirements({
    archetype: incidentArchetype,
    requirements: incidentRequirements,
  });

  // PR 94b — Per-requirement satisfaction.
  // PR 96 — A requirement is "captured" when EITHER an item in the
  // queue carries a matching slot OR a persisted evidence doc
  // carries the matching requirementKey. Either source counts; both
  // require explicit operator intent (queue-local via the "Capture:
  // X" button, persisted via addEvidenceV1's requirementKey). Generic
  // unassigned photos still don't count.
  const captureSource = resolvedRequirements.snapshotSource;
  const requirementCaptureMap: Record<string, boolean> = {};
  for (const label of resolvedRequirements.requiredProof) {
    const key = slugRequirement(label);
    if (!key) continue;
    requirementCaptureMap[key] =
      items.some((it) => it.slot?.requirementKey === key) ||
      serverCapturedKeys.has(key);
  }

  // PR 94b — "Next" target for the primary capture button: first
  // requirement in declared order that isn't queue-satisfied yet.
  // Replaces PR 93's position-based heuristic with deterministic
  // per-slot matching — safe because slot assignment is explicit.
  const nextTargetIndex = (() => {
    if (!captureSource) return -1;
    for (let i = 0; i < resolvedRequirements.requiredProof.length; i++) {
      const key = slugRequirement(resolvedRequirements.requiredProof[i]);
      if (!key) continue;
      if (!requirementCaptureMap[key]) return i;
    }
    return -1;
  })();

  const nextTargetLabel =
    nextTargetIndex >= 0
      ? resolvedRequirements.requiredProof[nextTargetIndex]
      : "";
  const nextTargetKey = nextTargetLabel ? slugRequirement(nextTargetLabel) : "";

  // PR 94b — Capture button slot. Built only when we have a valid
  // source AND the slug is non-empty (per plan point 8.6: empty slug
  // means we can't bind, so leave the click unassigned).
  const nextTargetSlot: ProofSlot | null =
    nextTargetIndex >= 0 && nextTargetKey && captureSource
      ? {
          requirementKey: nextTargetKey,
          requirementLabel: nextTargetLabel,
          requirementSource: captureSource,
          requirementIndex: nextTargetIndex,
        }
      : null;

  // Adaptive label:
  //   No requirements                 → "Open camera"
  //   All requirements queue-captured → "Capture more proof"
  //   Otherwise                       → "Capture: {next requirement label}"
  let captureButtonLabel = "Open camera";
  if (resolvedRequirements.requiredProof.length > 0) {
    if (nextTargetLabel) {
      captureButtonLabel = `Capture: ${nextTargetLabel}`;
    } else {
      captureButtonLabel = "Capture more proof";
    }
  }

  // PR 136D — slot-aware label for the file-picker button so the
  // desktop sales-demo primary action carries the same operator
  // guidance the camera button currently does on mobile.
  let pickButtonLabel = "Upload photos";
  if (resolvedRequirements.requiredProof.length > 0) {
    if (nextTargetLabel) {
      pickButtonLabel = `Upload: ${nextTargetLabel}`;
    } else {
      pickButtonLabel = "Upload more proof";
    }
  }

  function selectSlotAndOpen() {
    setCurrentSlot(nextTargetSlot);
    void openCamera();
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
          {/* PR 111 — Banner renders only while we're genuinely waiting:
              session in flight, OR jobs still loading, OR jobs loaded
              with at least one to bind. Records that loaded with zero
              jobs render no banner (record-level proof is valid). */}
          {!selectedJobId && mounted && (!jobsLoaded || jobs.length > 0) ? (
            <div className="text-[11px] text-amber-200/80">
              {sessionBusy ? "Starting session…" : "Binding to an active job…"}
            </div>
          ) : null}
        </header>

        {/* PEAKOPS_TEMPLATE_PROVENANCE_V1 (PR 120b) — provenance
            block above the required-proof checklist. Reads
            incident.requirements snapshot (PR 89a/120a) and renders
            "Requirements source · <Customer> · <Archetype> · v<N>"
            in compact form. Hides on archetype fallback / no-template
            records. Subsumes the PR 92 audit footer that previously
            sat below the checklist. */}
        <ProvenanceBlock
          variant="compact"
          provenance={{
            source: (incidentRequirements as any)?.source,
            templateKey: (incidentRequirements as any)?.templateKey,
            templateVersion: (incidentRequirements as any)?.templateVersion,
            customerLabel: (incidentRequirements as any)?.customerLabel,
            archetype: incidentArchetype,
          }}
        />

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
          // PR 93 — read from the hoisted const so both panel and
          // primary button stay in sync. (PR 88/90 originally
          // computed this inside the IIFE.)
          const requirements = resolvedRequirements;
          if (requirements.source === "none" || requirements.requiredProof.length === 0) {
            return null;
          }
          const details = getArchetypeDetails(incidentArchetype);
          const archetypeLabel = details?.label || "";
          const total = requirements.requiredProof.length;
          // PR 94b — Per-slot counter. Only items the operator
          // explicitly assigned via a "Capture: X" click count. A
          // queue full of unassigned gallery picks reads "0 / N" —
          // which is correct: those photos haven't been bound to
          // any requirement yet.
          const captured = Object.values(requirementCaptureMap).filter(Boolean).length;
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
              <ul className="mt-3 space-y-2 text-[12px]">
                {requirements.requiredProof.map((item, idx) => {
                  // PR 94b — Per-slot satisfaction. Captured rows
                  // brighten to solid emerald; pending rows keep the
                  // dim treatment. Only explicit slot assignment
                  // marks a row captured (queue-local).
                  const key = slugRequirement(item);
                  const itemCaptured = key ? !!requirementCaptureMap[key] : false;
                  // PR 120b — Per-required-proof rationale from the
                  // frozen snapshot. Parallel array indexed by
                  // position; empty entries render no "Reason:" line.
                  const reason = String(
                    ((incidentRequirements as any)?.requiredProofDescriptions || [])[idx] || ""
                  ).trim();
                  return (
                    <li key={item} className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={
                          (itemCaptured ? "text-emerald-300" : "text-emerald-300/40") +
                          " mt-0.5"
                        }
                      >
                        ✓
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={itemCaptured ? "text-emerald-100" : "text-gray-200"}>
                          {item}
                        </div>
                        {reason ? (
                          <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">
                            <span className="text-gray-600">Reason: </span>
                            {reason}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {/* PR 92's quiet audit footer ("Requirements source: …")
                  was removed in PR 120b. The new prominent
                  ProvenanceBlock above this panel renders the same
                  information with customer language (PR 120a's
                  snapshotted customerLabel) instead of slug
                  fragments, plus an audit framing line on v > 1.
                  See <ProvenanceBlock /> earlier in this file. */}
            </section>
          );
        })()}

      {/* CAMERA MODE */}
      {cameraOpen && (
        <div className="space-y-3">
          {/* PR 94b — Active proof-slot banner. Renders only when the
              operator entered the camera via a "Capture: X" button.
              Communicates that the next photo(s) will be attached to
              this specific requirement.

              PR 136A — Augmented with a per-slot capture counter so
              the operator gets immediate feedback when a photo
              registers. The queue + checklist below are hidden in
              camera mode (the !cameraOpen guard below); without this
              counter, the operator can't see that their taps are
              actually recording captures. Counts items in the local
              queue whose slot matches the currentSlot's key. */}
          {currentSlot ? (() => {
            const slotItemCount = items.filter(
              (it) => it.slot?.requirementKey === currentSlot.requirementKey
            ).length;
            return (
              <div data-testid="capture-mode-active-slot-banner" className="rounded-xl border border-amber-300/25 bg-amber-500/[0.06] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-amber-200/70">
                      Capturing for
                    </div>
                    <div className="text-[14px] font-semibold text-amber-50 mt-0.5">
                      {currentSlot.requirementLabel}
                    </div>
                  </div>
                  <div
                    data-testid="capture-mode-slot-counter"
                    className={
                      "shrink-0 text-[11px] font-semibold uppercase tracking-[0.10em] rounded-full border px-2 py-0.5 " +
                      (slotItemCount > 0
                        ? "border-emerald-300/40 bg-emerald-500/15 text-emerald-100"
                        : "border-white/15 bg-white/[0.04] text-gray-300")
                    }
                    title="Photos captured for this requirement in this session"
                  >
                    {slotItemCount === 0
                      ? "0 captured"
                      : `${slotItemCount} captured ✓`}
                  </div>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  Multiple photos in this session will be attached to this requirement.
                </div>
              </div>
            );
          })() : null}
          {/* PR 136A — Above-video hint. Disambiguates the camera UX
              for first-time non-technical operators who otherwise
              read "Done" as "I'm finished entirely" and abandon the
              page before uploading. */}
          <p data-testid="capture-mode-hint" className="text-[11px] text-gray-400 leading-relaxed">
            Tap <span className="text-white font-medium">Capture photo</span> for each shot.
            Tap <span className="text-white font-medium">Close camera</span> when finished — your photos stay queued for upload below.
          </p>
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
            {/* PR 136A — "Done" was ambiguous (read by first-timers as
                "I'm finished with the whole session") and led some
                operators to abandon the page before uploading.
                "Close camera" makes the action's scope explicit. */}
            <button
              data-testid="capture-mode-close-camera"
              className="w-full py-4 bg-gray-800 active:bg-gray-700 rounded-xl font-semibold"
              onClick={closeCamera}
              disabled={busy}
            >
              Close camera
            </button>
          </div>
          {cameraError ? <div className="text-xs text-red-300">Camera error: {cameraError}</div> : null}
        </div>
      )}

      {/* PR 136B — Post-upload confirmation panel. Renders only when
          uploadConfirmation is set (i.e. a successful uploadAll just
          completed). Replaces the prior 350ms auto-redirect, which
          flashed "Secured ✔️" too briefly for non-technical operators
          to register success and gave no next-step guidance toward
          notes. Operator chooses what's next; we never auto-navigate
          away from a success state. */}
      {!cameraOpen && uploadConfirmation ? (
        <section
          data-testid="upload-confirmation-panel"
          className="rounded-2xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4 space-y-3"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden className="text-emerald-300 text-[20px] leading-none mt-0.5">✓</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-emerald-50">
                {uploadConfirmation.count} {uploadConfirmation.count === 1 ? "item" : "items"} captured and secured
              </div>
              <p className="text-[12px] text-emerald-200/85 mt-1 leading-relaxed">
                Your proof is signed and stored. The required-proof checklist above reflects what&apos;s on file.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <a
              data-testid="upload-confirmation-next-notes"
              href={`/incidents/${incidentId}/notes${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`}
              className="block w-full py-3 rounded-xl text-[13px] font-semibold text-black bg-white hover:bg-white/90 text-center transition"
            >
              Next: write notes →
            </a>
            <a
              data-testid="upload-confirmation-back-incident"
              href={`/incidents/${incidentId}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`}
              className="block w-full py-3 rounded-xl text-[13px] font-semibold text-white border border-white/15 bg-white/[0.04] hover:bg-white/[0.10] text-center transition"
            >
              Back to incident
            </a>
          </div>
          <p className="text-[10px] text-emerald-200/60 italic">
            Or capture more proof below — your queue is empty and ready for additional photos.
          </p>
        </section>
      ) : null}

      {/* PICK / QUEUE */}
      {!cameraOpen && (() => {
        // PR 136D — extract both capture buttons into JSX consts so
        // the parent can swap their order based on filePickerPrimary.
        // The hidden <input> stays in a stable position (its DOM
        // location doesn't affect fileInputRef.current behavior).
        const inputsBusy = busy || sessionBusy || !sessionId;
        const primaryClass =
          "w-full py-4 rounded-xl text-[14px] font-semibold transition " +
          (inputsBusy
            ? "bg-white/10 text-gray-400 cursor-not-allowed"
            : "bg-white text-black hover:bg-white/90");
        // Secondary style: less visual weight than primary, more than
        // the legacy dashed treatment. Matches the "secondary action"
        // pattern used elsewhere in the operator dock.
        const secondaryClass =
          "w-full py-4 rounded-xl text-[14px] font-semibold border transition " +
          (inputsBusy
            ? "bg-white/5 border-white/10 text-gray-500 cursor-not-allowed"
            : "bg-white/8 border-white/15 text-gray-200 hover:bg-white/12");

        const cameraButtonJSX = (
          <button
            key="camera-btn"
            data-testid="capture-camera-button"
            data-primary={!filePickerPrimary}
            className={filePickerPrimary ? secondaryClass : primaryClass}
            onClick={selectSlotAndOpen}
            disabled={inputsBusy}
          >
            {captureButtonLabel}
          </button>
        );

        const filePickerButtonJSX = (
          <button
            key="pick-btn"
            data-testid="capture-pick-button"
            data-primary={filePickerPrimary}
            type="button"
            className={filePickerPrimary ? primaryClass : secondaryClass}
            disabled={inputsBusy}
            onClick={() => {
              if (process.env.NODE_ENV !== "production") {
                console.warn("[add-evidence]", {
                  step: "click",
                  disabled: inputsBusy,
                  hasInput: !!fileInputRef.current,
                  isUserGesture: true,
                  ts: Date.now(),
                });
              }
              if (inputsBusy) return;
              fileInputRef.current?.click();
              if (process.env.NODE_ENV !== "production") {
                console.warn("[add-evidence]", { step: "input_click", ts: Date.now() });
              }
            }}
          >
            {filePickerPrimary ? pickButtonLabel : "Pick multiple photos/videos"}
          </button>
        );

        const hiddenInputJSX = (
          <input
            key="pick-input"
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
            disabled={inputsBusy}
          />
        );

        return (
          <div data-testid="capture-buttons-row" data-file-picker-primary={filePickerPrimary} className="space-y-3">
            {/* PR 136D — order swap. Primary action sits at the top
                (consistent with the operator dock pattern: top action
                is the first thing the eye lands on). Desktop demo →
                file-picker is the primary so the buyer sees the
                expected "click to upload" affordance front-and-center.
                Mobile field path → camera primary (unchanged from
                pre-136D behavior). */}
            {filePickerPrimary ? (
              <>
                {filePickerButtonJSX}
                {hiddenInputJSX}
                {cameraButtonJSX}
              </>
            ) : (
              <>
                {cameraButtonJSX}
                {hiddenInputJSX}
                {filePickerButtonJSX}
              </>
            )}

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
                    title={it.slot ? `Assigned: ${it.slot.requirementLabel} — tap to remove` : "Remove"}
                    disabled={busy}
                  >
                    {/* PR 137B-2 — tile content. HEIC blob URLs can't
                        render as <img> in most desktop browsers, so
                        we substitute placeholders for the "still
                        optimizing" and "convert fell back, original
                        kept" states. */}
                    {it.optimizing ? (
                      <div
                        data-testid="capture-tile-optimizing"
                        className="w-full h-full flex items-center justify-center text-[11px] text-gray-300 px-1 text-center leading-tight"
                      >
                        Optimizing photo…
                      </div>
                    ) : it.file.type.startsWith("video/") ? (
                      <div className="w-full h-full flex items-center justify-center text-xs text-gray-300">VIDEO</div>
                    ) : it.originalRetained ? (
                      <div
                        data-testid="capture-tile-original-retained"
                        className="w-full h-full flex items-center justify-center text-[11px] text-amber-200/90 px-1 text-center leading-tight bg-amber-900/25"
                      >
                        HEIC original
                      </div>
                    ) : (
                      <img src={it.url} className="w-full h-full object-cover" />
                    )}
                    {/* PR 94b — Slot badge. Renders only when the
                        item is explicitly assigned to a required-
                        proof slot. Unassigned thumbnails carry no
                        badge (per approved plan, point 3). */}
                    {it.slot ? (
                      <div
                        className="absolute top-1 left-1 right-1 text-[9px] leading-tight font-semibold uppercase tracking-[0.05em] rounded bg-amber-500/85 text-black px-1.5 py-0.5 truncate"
                        title={it.slot.requirementLabel}
                      >
                        {it.slot.requirementLabel}
                      </div>
                    ) : null}
                    {/* PR 137B-2 — bottom strip. When the original
                        HEIC was retained (convert failed/timeout),
                        surface the "Couldn't preview · original kept"
                        badge in place of the filename so the operator
                        and downstream reviewers see the transparency
                        signal directly on the tile. */}
                    {it.originalRetained ? (
                      <div
                        data-testid="capture-tile-original-retained-badge"
                        className="absolute bottom-0 left-0 right-0 text-[9px] bg-amber-700/85 text-amber-50 px-1 py-0.5 truncate"
                        title={`Couldn't preview — original kept (${it.convertReason || "fallback"})`}
                      >
                        Couldn&apos;t preview · original kept
                      </div>
                    ) : (
                      <div className="absolute bottom-0 left-0 right-0 text-[10px] bg-black/60 text-gray-100 px-1 py-0.5 truncate">
                        {it.file.name}
                      </div>
                    )}
                  </button>
                ))}
              </div>

              <button
                className="mt-3 w-full py-4 rounded-xl bg-green-600/90 border border-green-300/20 text-white font-semibold hover:bg-green-600 active:translate-y-[1px] transition"
                onClick={uploadAll}
                // PR 111 — Job binding required only when the record has jobs;
                // record-level proof is allowed when jobs.length === 0.
                disabled={busy || sessionBusy || !sessionId || !items.length || items.some((i) => i.optimizing) || (jobs.length > 0 && !selectedJobId)}
                title={
                  items.some((i) => i.optimizing)
                    ? `Optimizing ${items.filter((i) => i.optimizing).length} photo${items.filter((i) => i.optimizing).length === 1 ? "" : "s"}…`
                    : (jobs.length > 0 && !selectedJobId)
                      ? "Return to the record and pick a work package first"
                      : (items.length ? "Upload all queued proof items" : "Add proof items first")
                }
              >
                {busy ? (status || "Working…") : "Upload & secure proof"}
              </button>

              {status ? <div className="mt-2 text-sm text-gray-300">{status}</div> : null}
              {errMsg ? <div className="mt-2 text-sm text-red-300">{errMsg}</div> : null}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Capture each required item, then upload and secure the proof package.
            </p>
          )}
        </div>
        );
      })()}
      </div>
    </main>
  );
}
