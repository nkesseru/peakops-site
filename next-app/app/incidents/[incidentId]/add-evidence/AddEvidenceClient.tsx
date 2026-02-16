"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { uploadEvidence } from "@/lib/evidence/uploadEvidence";
import { getFunctionsBase } from "@/lib/functionsBase";

type Item = { id: string; file: File; url: string };

function makeId() {
  return "ev_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

export default function AddEvidenceClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const sp = useSearchParams();

  // Queue of captured/selected media
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [errMsg, setErrMsg] = useState("");

  // Camera
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");

  // Env / context
  const functionsBase = getFunctionsBase();
  const techUserId = process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web";
  const selectedJobId = String(sp?.get("jobId") || "").trim();

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
    if (!functionsBase) throw new Error("Missing NEXT_PUBLIC_FUNCTIONS_BASE in .env.local");
    if (!selectedJobId) throw new Error("No job selected. Return to incident page and pick My job first.");
    await uploadEvidence({
      functionsBase,
      techUserId,
      orgId,
      incidentId,
      phase: "inspection",
      labels: ["damage"],
      jobId: selectedJobId,
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
      setErrMsg(m);
      setStatus("");
      alert(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white p-4">
      <div className="mb-4">
        <div className="text-[11px] uppercase tracking-wider text-gray-400">Add Evidence</div>
        <div className="text-lg font-semibold">
          Incident {incidentId.slice(-6)}
        </div>
        <div className="text-xs text-cyan-200/90 mt-1">
          My job: {selectedJobId || "(not selected)"}
        </div>
        {!selectedJobId ? (
          <div className="text-xs text-amber-200 mt-1">Select a job on incident page before uploading.</div>
        ) : null}
        <div className="text-xs text-gray-500 mt-1">Audit-safe capture • Auto-tagged • Time-locked</div>
      </div>

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
          <button
            className="w-full py-4 rounded-xl bg-gradient-to-r from-amber-500 to-slate-400 font-semibold active:from-amber-600 active:to-slate-500"
            onClick={openCamera}
            disabled={busy}
          >
            Open Camera
          </button>

          <input
            id="pick"
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={(e) => addPickedFiles(e.target.files)}
            className="hidden"
          />
          <label
            htmlFor="pick"
            className="w-full py-5 flex items-center justify-center border-2 border-dashed border-white/20 rounded-xl text-gray-200 active:border-white/40"
          >
            Pick multiple photos/videos
          </label>

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
                disabled={busy || !items.length || !selectedJobId}
                title={!selectedJobId ? "Return and select My job first" : (items.length ? "Upload all queued evidence" : "Add photos first")}
              >
                {busy ? (status || "Working…") : "Upload & Secure Evidence"}
              </button>

              {status ? <div className="mt-2 text-sm text-gray-300">{status}</div> : null}
              {errMsg ? <div className="mt-2 text-sm text-red-300">{errMsg}</div> : null}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Tip: Open Camera → tap Capture repeatedly → Done → Upload All.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
