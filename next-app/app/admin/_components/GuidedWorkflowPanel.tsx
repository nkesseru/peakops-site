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
    border: "1px solid #1a1a1a",
    background: "#0a0a0a",
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
  if (level === "OK") return { bd: "1px solid rgba(200,168,78,0.3)", bg: "rgba(200,168,78,0.08)" };
  if (level === "ERR") return { bd: "1px solid rgba(239,68,68,0.3)", bg: "rgba(239,68,68,0.08)" };
  return { bd: "1px solid rgba(234,179,8,0.3)", bg: "rgba(234,179,8,0.08)" };
}

function statusAccent(st: StepStatus): string {
  if (st === "DONE") return "#C8A84E";
  if (st === "DOING") return "#eab308";
  return "#222";
}

function statusPillStyle(st: StepStatus): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 4,
    border: st === "DONE" ? "1px solid rgba(200,168,78,0.3)" : st === "DOING" ? "1px solid rgba(234,179,8,0.3)" : "1px solid #1a1a1a",
    background: st === "DONE" ? "rgba(200,168,78,0.12)" : st === "DOING" ? "rgba(234,179,8,0.10)" : "#0a0a0a",
    color: st === "DONE" ? "#C8A84E" : st === "DOING" ? "#eab308" : "#666",
    fontSize: 11,
    fontWeight: 600,
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
    border: "1px solid #1a1a1a",
    borderRadius: 8,
    background: "#0a0a0a",
    padding: 14,
  };
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    borderRadius: 4,
    border: active ? "1px solid rgba(200,168,78,0.3)" : "1px solid #1a1a1a",
    background: active ? "rgba(200,168,78,0.12)" : "#0a0a0a",
    color: active ? "#C8A84E" : "#888",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",
  };
}

function banner(level: AutoLevel): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 8,
    padding: 14,
    border: "1px solid #1a1a1a",
    background: "#0a0a0a",
  };
  if (level === "CRITICAL") return { ...base, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)" };
  if (level === "WARN") return { ...base, border: "1px solid rgba(234,179,8,0.3)", background: "rgba(234,179,8,0.06)" };
  if (level === "INFO") return { ...base, border: "1px solid rgba(200,168,78,0.25)", background: "rgba(200,168,78,0.06)" };
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

  function resetLocalWorkflow() {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(histKey);
      // also clear any legacy keys if present
      window.localStorage.removeItem(`wf:${orgId}:${incidentId}`);
      window.localStorage.removeItem(`wf_hist:${orgId}:${incidentId}`);
      window.location.reload();
    } catch {
      // ignore
    }
  }


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
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

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
  fetch(`/api/fn/getTimelineEventsV1?orgId=${orgId}&incidentId=${incidentId}&limit=50`)
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
  const [autoChecks, setAutoChecks] = useState<CheckState | null>(null);
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

      const inc = bundle?.incident || bundle?.doc || bundle?.data || null;

      const title = String(inc?.title || "").trim();
      const startTime = inc?.startTime || inc?.createdAt || null;
      out.baselineOk = !!(incidentId && title && startTime);
      out.notes.push(out.baselineOk ? "Baseline OK: title + startTime present." : "Baseline missing: add title + startTime (Intake).");

      // Timeline check: meta or events exist
      const timelineMeta = bundle?.timelineMeta || inc?.timelineMeta || null;
      const eventCount = Number(timelineMeta?.eventCount || 0);
      if (eventCount > 0) {
        out.timelineOk = true;
        out.notes.push(`Timeline OK: ${eventCount} events (meta).`);
      } else {
        const tUrl =
          `/api/fn/getTimelineEventsV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=1`;
        const tRes = await fetch(tUrl, { method: "GET" });
        const tTxt = await tRes.text();
        const tParsed = safeParseJson(tTxt || "");
        const docs = tParsed.ok ? (tParsed.value?.docs || tParsed.value?.events || []) : [];
        out.timelineOk = Array.isArray(docs) && docs.length > 0;
        out.notes.push(out.timelineOk ? "Timeline OK: events exist." : "Timeline missing: run Generate Timeline.");
      }

      // Filings check: filingsMeta or filings array
      const filingsMeta = inc?.filingsMeta || null;
      const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
      out.filingsOk = !!(filingsMeta?.generatedAt || filings.length > 0);
      out.notes.push(out.filingsOk ? `Filings OK: ${filings.length || "meta"} present.` : "Filings missing: run Generate Filings.");

      // Packet check: packetMeta present on incident (earned export)
      const packetMeta = inc?.packetMeta || bundle?.packetMeta || null;
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
      setAutoChecks(c);

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
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#fff" }}>Workflow</span>
          <span style={{ fontSize: 10, color: "#555" }}>{donePct}%</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={resetLocalWorkflow} style={{ border: "1px solid #1a1a1a", background: "transparent", borderRadius: 4, padding: "4px 8px", fontSize: 10, fontWeight: 600, cursor: "pointer", color: "#555" }} title="Reset local cache">Reset</button>
          <button onClick={refreshAll} disabled={busy || autoBusy} style={{ ...pill(false), padding: "4px 8px", fontSize: 10 }}>{(busy || autoBusy) ? "…" : "Re-check"}</button>
        </div>
      </div>
{workflowMissingDerived && (
  <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: 4, background: "rgba(234,179,8,0.06)", border: "1px solid rgba(234,179,8,0.2)", fontSize: 10, color: "#eab308" }}>
    Manual mode — workflow engine not active.
  </div>
)}

      {autoChecks && (
        <div style={{ marginTop: 12, border: "1px solid #1a1a1a", borderRadius: 8, background: "#050505", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #111" }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: "#fff" }}>Status Checks</span>
            <span style={{ fontSize: 10, color: "#444" }}>{new Date().toLocaleTimeString()}</span>
          </div>

          {[
            { label: "Baseline", desc: "Title and start time present", ok: autoChecks.baselineOk },
            { label: "Timeline", desc: "Timeline events generated", ok: autoChecks.timelineOk },
            { label: "Filings", desc: "Filing records generated", ok: autoChecks.filingsOk },
            { label: "Packet", desc: "Export packet ready for download", ok: autoChecks.packetOk },
          ].map((row) => (
            <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderBottom: "1px solid #111" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#ddd" }}>{row.label}</div>
                <div style={{ fontSize: 10, color: "#555", marginTop: 1 }}>{row.desc}</div>
              </div>
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "3px 8px",
                borderRadius: 4,
                background: row.ok ? "rgba(34,197,94,0.12)" : "rgba(234,179,8,0.10)",
                border: row.ok ? "1px solid rgba(34,197,94,0.25)" : "1px solid rgba(234,179,8,0.25)",
                color: row.ok ? "#4ade80" : "#fbbf24",
              }}>
                {row.ok ? "DONE" : "MISSING"}
              </span>
            </div>
          ))}

          <details style={{ padding: "8px 14px" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 10, color: "#444" }}>
              History ({hist.length})
            </summary>
            {hist.length === 0 ? (
              <div style={{ marginTop: 6, fontSize: 10, color: "#333" }}>No actions yet.</div>
            ) : (
              <div style={{ marginTop: 6, display: "grid", gap: 3 }}>
                {hist.slice().reverse().slice(0, 10).map((h, i) => (
                  <div key={String(h.ts) + ":" + i} style={{ fontSize: 10, color: "#555" }}>
                    <span style={{ color: "#888" }}>{h.mode}</span> {h.stepKey} → <span style={{ color: "#888" }}>{h.to}</span>
                    {h.from ? <span> (was {h.from})</span> : null}
                  </div>
                ))}
              </div>
            )}
          </details>
        </div>
      )}

      {err && !workflowMissingDerived && (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 6, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5", fontSize: 12 }}>
          {err}
        </div>
      )}

      {!err && steps.length > 0 && (
        <div style={{ marginTop: 8, border: "1px solid #1a1a1a", borderRadius: 6, overflow: "hidden" }}>
          {steps.map((s, idx) => {
            const st = s.status || "TODO";
            const key = String(s.key || idx);
            const isExpanded = expandedStep === key;
            return (
              <div key={key} style={{ borderBottom: idx < steps.length - 1 ? "1px solid #111" : "none", background: "#050505" }}>
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 12px", cursor: "pointer" }}
                  onClick={() => setExpandedStep(isExpanded ? null : key)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 3, background: statusAccent(st as any), flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: st === "DONE" ? "#C8A84E" : st === "DOING" ? "#eab308" : "#888" }}>
                      {s.title || s.key}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: st === "DONE" ? "#4ade80" : st === "DOING" ? "#eab308" : "#444" }}>
                      {st}
                    </span>
                    <span style={{ fontSize: 9, color: "#333", transition: "transform 0.15s", transform: isExpanded ? "rotate(90deg)" : "none" }}>&#9654;</span>
                  </div>
                </div>
                {isExpanded && (
                  <div style={{ padding: "4px 12px 8px", display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#555", marginRight: 4 }}>Override:</span>
                    {(["TODO", "DOING", "DONE"] as StepStatus[]).map((opt) => (
                      <button
                        key={opt}
                        onClick={() => { setStatus(key, opt); setExpandedStep(null); }}
                        style={{
                          padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer",
                          border: st === opt ? "1px solid rgba(200,168,78,0.3)" : "1px solid #1a1a1a",
                          background: st === opt ? "rgba(200,168,78,0.12)" : "transparent",
                          color: st === opt ? "#C8A84E" : "#666",
                        }}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Compact audit trail */}
      {hist.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#444" }}>
            Activity ({hist.length})
          </summary>
          <div style={{ marginTop: 4, display: "grid", gap: 2, maxHeight: 120, overflowY: "auto" }}>
            {hist.slice().reverse().slice(0, 15).map((h, i) => (
              <div key={String(h.ts) + ":" + i} style={{ fontSize: 10, color: "#555", padding: "2px 0" }}>
                <span style={{ color: h.mode === "AUTO" ? "#4ade80" : "#C8A84E" }}>{h.mode}</span>{" "}
                {h.stepKey} → {h.to}
                <span style={{ color: "#333", marginLeft: 6 }}>{new Date(h.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
