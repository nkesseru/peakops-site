"use client";
import React, { useEffect, useMemo, useState } from "react";

/*__GWP_UI_HELPERS_V1__*/
type Role = "admin" | "tech" | "viewer";
type StepStatus = "TODO" | "DOING" | "DONE";

type WfHistItem = {
  ts: string;
  stepKey: string;
  from?: StepStatus;
  to: StepStatus;
  mode: "AUTO" | "MANUAL";
};

const AUTO_EMBLEM_STYLE: "flow" | "ai" | "cloud" = "flow";

function autoEmblem(): React.ReactNode {
  const frame: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: 8,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
  };

  if (AUTO_EMBLEM_STYLE === "ai") {
    return (
      <span style={frame} aria-label="Auto checks" title="Auto checks">
        <span style={{ fontSize: 11, fontWeight: 950, letterSpacing: 0.4 }}>AI</span>
      </span>
    );
  }

  if (AUTO_EMBLEM_STYLE === "cloud") {
    return (
      <span style={frame} aria-label="Auto checks" title="Auto checks">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.7A3.5 3.5 0 0 0 7 18Z"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    );
  }

  // flow (default): arrows + nodes
  return (
    <span style={frame} aria-label="Auto checks" title="Auto checks">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M7 8h6a3 3 0 0 1 0 6H8"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M7 8l2-2M7 8l2 2"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M8 14l-2 2M8 14l-2-2"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="17.5" cy="8" r="1.5" fill="currentColor" />
        <circle cx="17.5" cy="14" r="1.5" fill="currentColor" />
      </svg>
    </span>
  );
}

function bannerTone(level: "OK" | "WARN" | "ERR") {
  if (level === "OK") return { bd: "1px solid color-mix(in oklab, lime 24%, transparent)", bg: "color-mix(in oklab, lime 12%, transparent)" };
  if (level === "ERR") return { bd: "1px solid color-mix(in oklab, crimson 26%, transparent)", bg: "color-mix(in oklab, crimson 12%, transparent)" };
  return { bd: "1px solid color-mix(in oklab, orange 26%, transparent)", bg: "color-mix(in oklab, orange 12%, transparent)" };
}

function statusAccent(st: StepStatus): string {
  if (st === "DONE") return "color-mix(in oklab, lime 55%, CanvasText)";
  if (st === "DOING") return "color-mix(in oklab, orange 60%, CanvasText)";
  return "color-mix(in oklab, CanvasText 28%, transparent)";
}

function statusPillStyle(st: StepStatus): React.CSSProperties {
  const bg =
    st === "DONE" ? "color-mix(in oklab, lime 18%, transparent)" :
    st === "DOING" ? "color-mix(in oklab, orange 16%, transparent)" :
    "color-mix(in oklab, CanvasText 6%, transparent)";
  const bd =
    st === "DONE" ? "1px solid color-mix(in oklab, lime 26%, transparent)" :
    st === "DOING" ? "1px solid color-mix(in oklab, orange 24%, transparent)" :
    "1px solid color-mix(in oklab, CanvasText 18%, transparent)";
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: bd,
    background: bg,
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
    userSelect: "none",
  };
}

function readHist(key: string): WfHistItem[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeHist(key: string, items: WfHistItem[]) {
  try { localStorage.setItem(key, JSON.stringify(items.slice(-25))); } catch {}
}
/*__GWP_UI_HELPERS_V1_END__*/

type Step = { key: string; title?: string; hint?: string; status?: StepStatus };
type Workflow = { version?: string; steps?: Step[] };

type AutoLevel = "" | "INFO" | "WARN" | "CRITICAL";

type CheckState = {
  baselineOk: boolean;
  timelineOk: boolean;
  filingsOk: boolean;
  packetOk: boolean;
  notes: string[];
  level: AutoLevel;
};

function safeParseJson(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    userSelect: "none",
  };
}

function banner(level: AutoLevel): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 14,
    padding: 12,
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
  if (level === "CRITICAL") return { ...base, border: "1px solid color-mix(in oklab, red 35%, transparent)", background: "color-mix(in oklab, red 10%, transparent)" };
  if (level === "WARN") return { ...base, border: "1px solid color-mix(in oklab, orange 35%, transparent)", background: "color-mix(in oklab, orange 10%, transparent)" };
  if (level === "INFO") return { ...base, border: "1px solid color-mix(in oklab, dodgerblue 35%, transparent)", background: "color-mix(in oklab, dodgerblue 8%, transparent)" };
  return base;
}

function readLocal(key: string): Record<string, StepStatus> {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}
function writeLocal(key: string, v: Record<string, StepStatus>) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

function percentDone(steps: Step[]) {
  if (!steps.length) return 0;
  const done = steps.filter((s) => (s.status || "TODO") === "DONE").length;
  return Math.round((done / steps.length) * 100);
}

function computeLevel(x: CheckState): AutoLevel {
  if (!x.baselineOk) return "CRITICAL";
  if (!x.timelineOk || !x.filingsOk) return "WARN";
  if (!x.packetOk) return "INFO";
  return "INFO";
}

function levelLabel(lvl: AutoLevel) {
  if (lvl === "CRITICAL") return "CRITICAL";
  if (lvl === "WARN") return "WARN";
  if (lvl === "INFO") return "INFO";
  return "";
}

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string; role?: Role }) {
  
  // __AUTOLEVEL_SAFE_DEF__
  // Demo-safe: prevents runtime crash if JSX references autoLevel.
const { orgId, incidentId } = props;
  const role: Role = (props as any)?.role || "admin";

  const storageKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);
  const histKey = useMemo(() => `wf_hist:${orgId}:${incidentId}`, [orgId, incidentId]);

  const [hist, setHist] = useState<WfHistItem[]>([]);

  // Load history (client only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setHist(readHist(histKey));
    } catch {
      // demo-safe: ignore storage errors
    }
  }, [histKey]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const workflowMissingDerived = !!(err && (String(err).includes("getWorkflowV1") || String(err).includes("does not exist") || String(err).includes("HTTP 404") || String(err).includes("Function us-central1-getWorkflowV1") || String(err).includes("proxyGET failed") || String(err).includes("fetch failed")));
  const [wf, setWf] = useState<Workflow | null>(null);

  /*__MANUAL_MODE_DERIVED_STATUS__*/
  // Derived flags (declare once, after wf exists)
  const effectiveCanonical = Boolean((wf?.steps || []).find((x: any) => x?.key === "export_packet")?.status === "DONE");
  const effectiveZipVerified = Boolean((wf?.steps || []).find((x: any) => x?.key === "verify_zip")?.status === "DONE");

  // Derived flags (declare once, after wf exists)

  const [autoLevel, setAutoLevel] = useState<AutoLevel>("");

/*__TIMELINE_AUTO_WIRE_V1__*/
type TimelineEvent = {
  id: string;
  type: string;
  title?: string;
  message?: string;
  occurredAt?: string;
};

const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
const [timelineLoaded, setTimelineLoaded] = useState(false);

useEffect(() => {
  if (!orgId || !incidentId) return;
  fetch(`/api/fn/getTimelineEvents?orgId=${orgId}&incidentId=${incidentId}&limit=50`)
    .then(r => r.json())
    .then(j => {
      if (j?.ok && Array.isArray(j.docs)) {
        setTimeline(j.docs);
      }
    })
    .finally(() => setTimelineLoaded(true));
}, [orgId, incidentId]);

// AUTO: if timeline exists, mark step 2 DONE
useEffect(() => {
  if (!timelineLoaded) return;
  if (timeline.length > 0) {
    setStatus("build_timeline", "DONE");
  }
}, [timelineLoaded, timeline.length]);

  const [autoNotes, setAutoNotes] = useState<string[]>([]);
  const [autoBusy, setAutoBusy] = useState(false);

  const [localStatus, setLocalStatus] = useState<Record<string, StepStatus>>(() =>
    typeof window === "undefined" ? {} : readLocal(storageKey)
  );

  const steps: Step[] = useMemo(() => {
    const base = wf?.steps || [];
    return base.map((s) => ({
      ...s,
      status: localStatus[String(s.key)] || s.status || "TODO",
    }));
  }, [wf, localStatus]);

  function setStatus(key: string, status: StepStatus, why?: string) {
    const k = String(key);
    const next = { ...localStatus, [k]: status };
    setLocalStatus(next);
    writeLocal(storageKey, next);
    if (why) setAutoNotes((x) => [`AUTO: ${why}`, ...x].slice(0, 10));
  }

  async function loadWorkflow() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error(`Workflow API returned empty body (HTTP ${r.status})`);

      const parsed = safeParseJson(text);
      if (!parsed.ok) {
        const sample = text.slice(0, 140).replace(/\s+/g, " ");
        throw new Error(`Workflow engine not active yet (manual mode) (HTTP ${r.status}): ${parsed.error} — ${sample}`);
      }

      const j = parsed.value;
      if (j?.ok === false) throw new Error(String(j?.error || "getWorkflowV1 failed"));

      const workflow: Workflow = j?.workflow || {};
      setWf(workflow);

      if (workflow?.steps?.length) {
        const next = { ...readLocal(storageKey), ...localStatus };
        setLocalStatus(next);
        writeLocal(storageKey, next);
      }
    } catch (e: any) {
      setWf(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function runAutoChecks(): Promise<CheckState> {
    const out: CheckState = {
      baselineOk: false,
      timelineOk: false,
      filingsOk: false,
      packetOk: false,
      notes: [],
      level: "",
    };

    try {
      // Baseline + meta signals via undefined bundle
      const bUrl =
        `/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const bRes = await fetch(bUrl, { method: "GET" });
      const bTxt = await bRes.text();
      const bParsed = safeParseJson(bTxt || "");
      const bundle = bParsed.ok ? bParsed.value : null;

      const undefined = bundle?.undefined || bundle?.doc || bundle?.data || null;

      const title = String(undefined?.title || "").trim();
      const startTime = undefined?.startTime || undefined?.createdAt || null;
      out.baselineOk = !!(incidentId && title && startTime);
      out.notes.push(out.baselineOk ? "Baseline OK: title + startTime present." : "Baseline missing: add title + startTime (Intake).");

      // Timeline check: meta or events exist
      const timelineMeta = bundle?.timelineMeta || undefined?.timelineMeta || null;
      const eventCount = Number(timelineMeta?.eventCount || 0);
      if (eventCount > 0) {
        out.timelineOk = true;
        out.notes.push(`Timeline OK: ${eventCount} events (meta).`);
      } else {
        const tUrl =
          `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=1`;
        const tRes = await fetch(tUrl, { method: "GET" });
        const tTxt = await tRes.text();
        const tParsed = safeParseJson(tTxt || "");
        const docs = tParsed.ok ? (tParsed.value?.docs || tParsed.value?.events || []) : [];
        out.timelineOk = Array.isArray(docs) && docs.length > 0;
        out.notes.push(out.timelineOk ? "Timeline OK: events exist." : "Timeline missing: run Generate Timeline.");
      }

      // Filings check: filingsMeta or filings array
      const filingsMeta = undefined?.filingsMeta || null;
      const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
      out.filingsOk = !!(filingsMeta?.generatedAt || filings.length > 0);
      out.notes.push(out.filingsOk ? `Filings OK: ${filings.length || "meta"} present.` : "Filings missing: run Generate Filings.");

      // Packet check: packetMeta present on undefined (earned export)
      const packetMeta = undefined?.packetMeta || bundle?.packetMeta || null;
      out.packetOk = !!(packetMeta?.packetHash || packetMeta?.hash);
      out.notes.push(out.packetOk ? "Packet OK: packetMeta present." : "Packet not ready yet (run Export Packet).");

      out.level = computeLevel(out);
      return out;
    } catch (e: any) {
      out.level = "WARN";
      out.notes.push(`Auto-check failed: ${String(e?.message || e)}`);
      return out;
    }
  }

  async function refreshAll() {
    setAutoBusy(true);
    setAutoNotes([]);
    setAutoLevel("");
    try {
      await loadWorkflow();

      const c = await runAutoChecks();
      setAutoLevel(c.level);
      setAutoNotes(c.notes);

      // Auto-advance (forward only)
      if (c.baselineOk) setStatus("intake", "DONE", "Intake marked DONE (baseline valid).");
      if (c.timelineOk) setStatus("timeline", "DONE", "Timeline marked DONE (events/meta present).");
      if (c.filingsOk) setStatus("filings", "DONE", "Filings marked DONE (meta/filings present).");
      if (c.packetOk) setStatus("export", "DONE", "Export marked DONE (packet download available).");
    } finally {
      setAutoBusy(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  const donePct = percentDone(steps);

  return (
    <div style={card()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 950 }}>Guided Workflow</div>

{workflowMissingDerived && (
  <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 12, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", fontSize: 12 }}>
    Workflow engine not active yet — running in manual mode. (This is OK in dev.)
  </div>
)}
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {steps.length} steps · {donePct}% complete
          </div>
        </div>

        <button onClick={refreshAll} disabled={busy || autoBusy} style={pill(false)}>
          {(busy || autoBusy) ? "Checking…" : "Re-check"}
        </button>
      </div>

      {(autoLevel || autoNotes.length > 0) && (
        <div style={{ marginTop: 10, ...banner(autoLevel) }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
            <div style={{ fontWeight: 950 }}>
              {autoLevel ? `Auto-checks: ${levelLabel(autoLevel)}` : "Auto-checks"}
            </div>
      <details style={{ marginTop: 10, opacity: 0.95 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
          Revision history (local)
        </summary>
        {hist.length === 0 ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>No actions yet.</div>
        ) : (
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            {hist.slice().reverse().map((h, i) => (
              <div
                key={String(h.ts) + ":" + i}
                style={{
                  border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
                  borderRadius: 12,
                  padding: "8px 10px",
                  background: "color-mix(in oklab, CanvasText 3%, transparent)",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.9 }}>
                  <span style={{ fontWeight: 950 }}>{h.mode}</span>{" "}
                  <span style={{ opacity: 0.75 }}>step</span>{" "}
                  <span style={{ fontWeight: 950 }}>{h.stepKey}</span>{" "}
                  <span style={{ opacity: 0.75 }}>→</span>{" "}
                  <span style={{ fontWeight: 950 }}>{h.to}</span>
                  {h.from ? <span style={{ opacity: 0.6 }}> (was {h.from})</span> : null}
                </div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{new Date(h.ts).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </details>

            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {new Date().toLocaleTimeString()}
            </div>
          </div>

          {autoNotes.length > 0 && (
            <ul style={{ margin: "8px 0 0 0", paddingLeft: 18, display: "grid", gap: 6, fontSize: 12, opacity: 0.9 }}>
              {autoNotes.slice(0, 10).map((t, i) => (
                <li key={i} style={{ color: autoLevel === "CRITICAL" ? "crimson" : "CanvasText" }}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {err && !workflowMissingDerived && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      {!err && steps.length === 0 && (
        <div style={{ marginTop: 10, opacity: 0.75 }}>No workflow steps.</div>
      )}

      {!err && steps.length > 0 && (
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {steps.map((s, idx) => {
            const st = s.status || "TODO";
            return (
              <div key={String(s.key || idx)} style={{ ...card(), borderLeft: `6px solid ${statusAccent(st as any)}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 950 }}>
                    {idx + 1}. {s.title || s.key}
                  </div>
                  <span style={statusPillStyle(st as any)}>{st}</span>
                </div>

                {s.hint && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{s.hint}</div>}

                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button style={pill(st === "TODO")} onClick={() => setStatus(String(s.key), "TODO")}>TODO</button>
                  <button style={pill(st === "DOING")} onClick={() => setStatus(String(s.key), "DOING")}>DOING</button>
                  <button style={pill(st === "DONE")} onClick={() => setStatus(String(s.key), "DONE")}>DONE</button>
                </div>

                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
                  Saved locally so techs don’t lose their place.
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
