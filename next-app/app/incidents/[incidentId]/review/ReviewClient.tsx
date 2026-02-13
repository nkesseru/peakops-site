"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { enqueueSupervisorRequestUpdate, enqueueSupervisorRequestClear, outboxFlushSupervisorRequests } from "@/lib/offlineOutbox";
import { getFunctionsBase } from "@/lib/functionsBase";

type EvidenceDoc = {
  id: string;
  labels?: string[];
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
  storedAt?: { _seconds?: number };
  createdAt?: { _seconds?: number };
  sessionId?: string;
};

type TimelineDoc = {
  id: string;
  type: string;
  actor?: string;
  refId?: string | null;
  sessionId?: string | null;
  occurredAt?: { _seconds?: number };
  meta?: any;
};

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  try {
    return JSON.parse(txt) as T;
  } catch {
    // allow non-json responses in dev
    return ({ ok: true, raw: txt } as any) as T;
  }
}

function fmtAgo(sec?: number) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
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
  const previewPath =
    String(f?.previewPath || f?.derivatives?.preview?.storagePath || "").trim();
  const thumbPath =
    String(f?.thumbPath || f?.derivatives?.thumb?.storagePath || "").trim();
  const heic = isHeicEvidence(ev);
  return {
    thumbPath: heic && thumbPath ? thumbPath : originalPath,
    previewPath: heic && previewPath ? previewPath : originalPath,
  };
}

export default function ReviewClient({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  // PEAKOPS_V2_REVIEW_REQUEST_UPDATE (canonical)
  const [reqOpen, setReqOpen] = useState(false);
  const [reqText, setReqText] = useState("");
  const reqKey = "peakops_review_request_" + String(incidentId || "");

  useEffect(() => {
    try { outboxFlushSupervisorRequests(); } catch {}

    try {
      const prev = localStorage.getItem(reqKey) || "";
      if (prev) setReqText(prev);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  const saveRequest = () => {
    try {
      localStorage.setItem(reqKey, reqText || "");
    } catch {}
  };

  const orgId = "org_001";
 "org_001";
  const functionsBase = getFunctionsBase();
  const evidenceBucket = "peakops-evidence-peakops-pilot-20251028065848";

  
  // PHASE5B_SUPERVISOR_REQUEST_PERSIST_V1
  async function persistSupervisorRequest(text: string) {
    try {
      await ({ incidentId, message: String(reqText || reqUpdateText || reqUpdate || ""), actor: { role: "supervisor" } });
} catch {}
  }

const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [timeline, setTimeline] = useState<TimelineDoc[]>([]);

  // Gallery state
  const [thumbUrl, setThumbUrl] = useState<Record<string, string>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>("");
  const [evidenceLimit, setEvidenceLimit] = useState<number>(12);

  // Notes saved flag (local)
  const [notesSavedLocal, setNotesSavedLocal] = useState(false);
  const syncNotesSavedLocal = () => {
    try {
      const k = "peakops_notes_saved_" + String(incidentId);
      setNotesSavedLocal(!!localStorage.getItem(k));
    } catch {}
  };

  async function getEvidenceReadUrl(storagePath: string, expiresSec = 900): Promise<string> {
    const out: any = await postJson(`${functionsBase}/createEvidenceReadUrlV1`, {
      orgId,
      incidentId,
      storagePath,
      bucket: evidenceBucket,
      expiresSec,
    });
    if (!out?.ok || !out?.url) throw new Error(out?.error || "createEvidenceReadUrlV1 failed");
    return String(out.url);
  }

  // Download all visible (opens tabs; popup blockers may apply)
  async function downloadAllVisible() {
    try {
      const list = (evidence || [])
        .filter((ev: any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath || "").includes("demo_placeholder"))
        .slice(0, evidenceLimit);

      let i = 0
      for (const ev of list) {
        const sp = String(pickEvidencePaths(ev as any).previewPath || "");
        if (!sp) continue;
        try {
          const url = await getEvidenceReadUrl(sp, 900);
          const delay = i * 250;
          i += 1;
          setTimeout(() => {
            try { window.open(url, "_blank", "noopener,noreferrer"); } catch {}
          }, delay);
        } catch {}
      }
    } catch {}
  }

  // Ensure visible thumbs are present (not aggressive prefetch)
  async function ensureThumbs(list: any[]) {
    try {
      const arr = Array.isArray(list) ? list : [];
      for (const ev of arr) {
        const id = String(ev?.id || ev?.evidenceId || "");
        const sp = String(pickEvidencePaths(ev as any).thumbPath || "");
        if (!id || !sp) continue;
        if (thumbUrl[id]) continue;
        try {
          const url = await getEvidenceReadUrl(sp, 900);
          setThumbUrl((m: any) => ({ ...m, [id]: url }));
        } catch {}
      }
    } catch {}
  }

  async function openEvidence(ev: any) {
    try {
      const sp = String(pickEvidencePaths(ev as any).previewPath || "");
      const id = String(ev?.id || ev?.evidenceId || "");
      if (!sp) return;

      setSelectedEvidenceId(id || "");
      setPreviewName(String(ev?.file?.originalName || id || "evidence"));
      setPreviewOpen(true);

      const url = await getEvidenceReadUrl(sp, 900);
      setPreviewUrl(url);
    } catch {
      setPreviewUrl("");
    }
  }

  async function refresh() {
    if (!functionsBase) return;
    setLoading(true);
    setErr("");
    try {
      const evUrl =
        `${functionsBase}/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      const evRes = await fetch(evUrl);
      const evText = await evRes.text();
      if (!evRes.ok) throw new Error(`GET ${evUrl} -> ${evRes.status} ${evText}`);
      const ev = evText ? JSON.parse(evText) : {};
      if (ev?.ok && Array.isArray(ev.docs)) setEvidence(ev.docs);

      const tlUrl =
        `${functionsBase}/getTimelineEventsV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=500`;
      const tlRes = await fetch(tlUrl);
      const tlText = await tlRes.text();
      if (!tlRes.ok) throw new Error(`GET ${tlUrl} -> ${tlRes.status} ${tlText}`);
      const tl = tlText ? JSON.parse(tlText) : {};
      if (tl?.ok && Array.isArray(tl.docs)) {
        const docs = tl.docs.slice();
        docs.sort((a: any, b: any) => (b?.occurredAt?._seconds || 0) - (a?.occurredAt?._seconds || 0));
        setTimeline(docs);
      }

      syncNotesSavedLocal();
    } catch (e: any) {
      console.error("review refresh failed", {
        functionsBase,
        incidentId,
        error: String(e?.message || e),
      });
      setErr((e && (e.message || String(e))) || "refresh failed");
    } finally {
      setLoading(false);
    }
  }

  // Refresh loop
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60000);
    const onFocus = () => {
      syncNotesSavedLocal();
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, functionsBase]);

  // Ensure thumbs for visible tiles
  useEffect(() => {
    try {
      const list = (evidence || [])
        .filter((ev: any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath || "").includes("demo_placeholder"))
        .slice(0, Math.max(1, evidenceLimit));
      ensureThumbs(list);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidence, evidenceLimit]);

  const evidenceN = useMemo(() => {
    return evidence.filter((ev: any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath || "").includes("demo_placeholder")).length;
  }, [evidence]);

  const hasSession = useMemo(() => {
    return timeline.some((t) => ["SESSION_STARTED", "FIELD_ARRIVED", "EVIDENCE_ADDED"].includes(String(t.type)));
  }, [timeline]);

  const hasEvidence = evidenceN >= 4;

  const hasNotes = useMemo(() => {
    return notesSavedLocal || timeline.some((t) => String(t.type) === "NOTES_SAVED");
  }, [timeline, notesSavedLocal]);

  const ready = hasSession && hasEvidence && hasNotes;

  async function approveAndLock() {
    alert("TODO: wire approve endpoint (approveIncidentV1). For now, this is a stub.");
  }

  async function sendBack() {
    alert("TODO: wire send-back endpoint (sendBackIncidentV1). For now, this is a stub.");
  }


  return (
    <main className="min-h-screen bg-black text-white">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-gray-400">Supervisor Review</div>
            <div className="text-lg font-semibold truncate">{incidentId}</div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
              onClick={() => router.push(`/incidents/${incidentId}`)}
            >
              ← Back to Incident
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-blue-600/20 border border-blue-400/20 text-blue-100 hover:bg-blue-600/25 text-sm"
              onClick={() => router.push(`/incidents/${incidentId}/notes`)}
            >
              📝 Notes
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Status + actions */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-gray-400">Decision</div>
              <div className="text-sm text-gray-200">
                {ready ? "Ready to approve." : "Not ready yet — missing required items."}
              </div>
              {err ? <div className="text-xs text-red-300 mt-1">Error: {err}</div> : null}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10 disabled:opacity-50"
                onClick={sendBack}
                disabled={loading}
                title="Send back to field with reasons"
              >
                ↩︎ Send Back
              </button>

              <button
                className={
                  "px-3 py-2 rounded-xl text-sm font-semibold border " +
                  (ready
                    ? "bg-green-700/25 border-green-400/25 text-green-200 hover:bg-green-700/35"
                    : "bg-white/5 border-white/10 text-gray-500")
                }
                onClick={approveAndLock}
                disabled={!ready || loading}
                title={ready ? "Approve & lock the record" : "Not ready yet"}
              >
                🛡 Approve & Lock
              </button>
            </div>
          </div>
        </section>

{/* PEAKOPS_MOVE_REQ_UPDATE_UNDER_DECISION_V4 */}
{/* PEAKOPS_V2_REVIEW_ACTIONS_UI */}
      <div className="rounded-2xl bg-white/5 border border-white/10 p-4 mt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400">Request update</div>
            <div className="text-sm text-gray-200">Ask the field team for better photos / missing info.</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
              onClick={() => { setReqOpen(false); }}
            >
              View evidence
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-xl bg-blue-600/18 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25"
              onClick={() => setReqOpen(true)}
            >
              Request update
            </button>
          </div>
        </div>

        {reqOpen ? (
          <div className="mt-3">
            <textarea
              className="w-full min-h-[110px] bg-black/30 border border-white/10 rounded-xl p-3 text-sm text-gray-200 outline-none"
              placeholder="Example: Please re-shoot the pole base from 10ft back + include hazard tape + include GPS landmark..."
              value={reqText}
              onChange={(e) => setReqText(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
		onClick={() => {
  		setReqOpen(false);
		}}             
		 >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-blue-600/22 border border-blue-400/22 text-sm text-blue-100 hover:bg-blue-600/30"
                onClick={() => {
                  saveRequest();
                  // v2: we just store + bounce to incident evidence area with a hint.
                  if (incidentId) router.push("/incidents/" + incidentId + "?hi=request_update");
                  setReqOpen(false);
                }}
              >
                Save request
              </button>
            </div>
            <div className="mt-2 text-[11px] text-gray-500">
              V2 behavior: stored locally for demo. V2.1: persist to Firestore + notify crew.
            </div>
          </div>
        ) : null}
      </div>





        {/* Readiness */}
        <section className={"rounded-2xl border p-4 " + (ready ? "bg-green-700/15 border-green-400/20" : "bg-white/5 border-white/10")}>
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Readiness</div>
            <span className="text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300">
              {loading ? "Refreshing…" : "Live"}
            </span>
          </div>

          <div className="mt-3 grid gap-2 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
              <div className="text-gray-200">Field session started</div>
              <div className={hasSession ? "text-green-300" : "text-gray-500"}>{hasSession ? "✓" : "—"}</div>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
              <div className="text-gray-200">Evidence captured (4+)</div>
              <div className={hasEvidence ? "text-green-300" : "text-gray-500"}>{hasEvidence ? "✓" : "—"}</div>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-black/30 border border-white/10 px-3 py-2">
              <div className="text-gray-200">Notes saved</div>
              <div className={hasNotes ? "text-green-300" : "text-gray-500"}>{hasNotes ? "✓" : "—"}</div>
            </div>
          </div>

          <div className="mt-2 text-xs text-gray-400">
            Supervisor should only approve once these are green.
          </div>
        </section>

        
                {/* PEAKOPS_REVIEW_EVIDENCE_GALLERY_V1 */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4" id="review-evidence">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Evidence</div>
              <div className="text-xs text-gray-500">
                {evidenceN} captured • showing {Math.min(evidenceLimit, evidenceN)} (latest)
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                onClick={() => downloadAllVisible()}
                title="Opens each evidence download in a new tab (may be popup-blocked)"
              >
                ⬇ Download all
              </button>

              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                onClick={() => {
                  if (!incidentId) return;
                  router.push("/incidents/" + incidentId + "#evidence");
                }}
                title="Open the field incident page evidence rail"
              >
                Open full evidence
              </button>

              {evidenceN > evidenceLimit ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-xl bg-blue-600/18 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25"
                  onClick={() => setEvidenceLimit((n) => Math.min(n + 12, evidenceN))}
                >
                  Load more
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-3 -mx-1 px-1 overflow-x-auto">
            <div className="flex gap-2 justify-center">
              {(() => {
                const list = (evidence || [])
                  .filter((ev: any) => !!ev?.file?.storagePath && !String(ev?.file?.storagePath || "").includes("demo_placeholder"));
                const shown = list.slice(0, evidenceLimit);

                return shown.map((ev: any) => {
                  const id = String(ev?.id || ev?.evidenceId || "");
                  const u = id ? thumbUrl[id] : "";
                  const name = String(ev?.file?.originalName || id);
                  const labels = (ev?.labels || []).map((x: any) => String(x).toUpperCase());

                  return (
                    <button
                      key={id || name}
                      type="button"
                      className={
                        "min-w-[148px] w-[148px] sm:min-w-[168px] sm:w-[168px] aspect-[4/3] relative rounded-xl overflow-hidden border " +
                        (selectedEvidenceId === id ? "border-blue-400/40 ring-2 ring-blue-500/20 " : "border-white/10 ") +
                        "bg-black/40 hover:border-white/25 hover:scale-[1.015] hover:bg-black/50 transition-all duration-150"
                      }
                      onClick={() => openEvidence(ev)}
                      title={name}
                    >
                      {u ? (
                        <img src={u} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">Loading…</div>
                      )}

                      <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                        {labels.slice(0, 2).map((l: string) => (
                          <span
                            key={l}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-black/40 border border-white/15 text-gray-100 backdrop-blur"
                          >
                            {l}
                          </span>
                        ))}
                      </div>

                      <div className="absolute bottom-2 left-2 right-2 text-[10px] text-gray-200/90 truncate bg-black/40 px-2 py-1 rounded">
                        {name || "evidence"}
                      </div>
                    </button>
                  );
                });
              })()}
            </div>
          </div>

          <div className="mt-2 text-[11px] text-gray-500">
            Click a tile to preview. Use “Open full evidence” for the full field page rail.
          </div>
        </section>


        {/* PEAKOPS_REVIEW_EVIDENCE_MODAL_V1 */}
        {previewOpen ? (
          <div className="fixed inset-0 bg-black/70 backdrop-blur flex items-center justify-center p-6 z-50">
            <div className="w-full max-w-4xl rounded-2xl bg-black border border-white/10 overflow-hidden">
              <div className="flex items-center justify-between p-3 border-b border-white/10 gap-3">
                <div className="text-sm text-gray-200 truncate">{previewName}</div>
                <div className="flex items-center gap-2">
                  {previewUrl ? (
                    <a
                      className="px-3 py-2 rounded-xl bg-white/6 border border-white/10 text-sm text-gray-200 hover:bg-white/10"
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      download
                      title="Download image"
                    >
                      ⬇ Download
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="px-3 py-2 rounded-xl bg-blue-600/20 border border-blue-400/20 text-sm text-blue-100 hover:bg-blue-600/25"
                    onClick={() => setPreviewOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="p-3">
                {previewUrl ? (
                  <img src={previewUrl} className="w-full max-h-[70vh] object-contain" />
                ) : (
                  <div className="text-gray-400 text-sm">Loading…</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
{/* Timeline summary */}
        <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-gray-400">Timeline</div>
            <div className="text-xs text-gray-500">{timeline.length} events</div>
          </div>

          <div className="mt-3 space-y-2">
            {timeline.slice(0, 12).map((t) => (
              <div key={t.id} className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-100">{String(t.type || "EVENT")}</div>
                  <div className="text-xs text-gray-500 truncate">
                    actor: {String(t.actor || "system")} {t.refId ? `• ref: ${t.refId}` : ""}
                  </div>
                </div>
                <div className="text-xs text-gray-500">{fmtAgo(t.occurredAt?._seconds)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
