"use client";

import React, { useEffect, useMemo, useState } from "react";

import BaselinePreview from "./BaselinePreview";
type StepStatus = "TODO" | "DOING" | "DONE";
type Step = { key: string; title?: string; hint?: string; status?: StepStatus };
type Workflow = { version?: string; steps?: Step[] };

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: "pointer",
    userSelect: "none",
  };
}

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

function readLocal(key: string): Record<string, StepStatus> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}

function writeLocal(key: string, v: Record<string, StepStatus>) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

function percentDone(steps: Step[]) {
  if (!steps.length) return 0;
  const done = steps.filter((s) => (s.status || "TODO") === "DONE").length;
  return Math.round((done / steps.length) * 100);
}

function safeParseJson(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;
  const storageKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<Workflow | null>(null);
  const [incident, setIncident] = useState<any>(null);

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

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();

      if (!text || !text.trim()) {
        throw new Error(`Workflow API returned empty body (HTTP ${r.status})`);
      }

      const parsed = safeParseJson(text);
      if (!parsed.ok) {
        // Usually means HTML error page or Next build output slipped through
        const sample = text.slice(0, 120).replace(/\s+/g, " ");
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status}): ${parsed.error} — ${sample}`);
      }

      const j = parsed.value;
      if (j?.ok === false) throw new Error(String(j?.error || "getWorkflowV1 failed"));

      const workflow: Workflow = j?.workflow || {};
      const incident = j?.incident ?? null;
      setWf(workflow);
      setIncident(incident);

      // ensure local storage is initialized once we have steps
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

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);



  useEffect(() => {
    // Auto-complete Intake when baseline is valid (set by BaselinePreview)
    const t = setTimeout(() => {
      try {
        const ok = (window as any)?.WF_BASELINE_OK === true;
        if (ok) markDoneOnce("intake");
      } catch {}
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf]);

  function setStatus(key: string, status: StepStatus) {
    const k = String(key);
    const next = { ...localStatus, [k]: status };
    setLocalStatus(next);
    writeLocal(storageKey, next);
  }

  function markDoneOnce(stepKey: string) {
    try {
      const k = String(stepKey);
      const current = localStatus[k] || "TODO";
      if (current === "DONE") return;
      setStatus(k, "DONE");
    } catch {}
  }


  const donePct = percentDone(steps);

return (
  <div style={card()}>
    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
      {steps.length} steps · {donePct}% complete
    </div>
      {err && (
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
              <div key={String(s.key || idx)} style={card()}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 950 }}>
                    {idx + 1}. {s.title || s.key}
                  </div>
                  <span style={pill(true)}>{st}</span>
                </div>

                {s.hint && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{s.hint}</div>}

                

                {String(s.key) === "intake" && (
                  <BaselinePreview orgId={orgId} incidentId={incidentId} />
                )}
<div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button style={pill(st === "TODO")} onClick={() => setStatus(String(s.key), "TODO")}>TODO</button>
                  <button style={pill(st === "DOING")} onClick={() => setStatus(String(s.key), "DOING")}>DOING</button>
                  <button style={pill(st === "DONE")} onClick={() => setStatus(String(s.key), "DONE")}>DONE</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* TIMELINE_PREVIEW_MOCK */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
          Timeline Preview (mock)
        </summary>
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {[
            { t: "T+0", title: "Incident created", note: "Basic incident record exists." },
            { t: "T+5m", title: "Timeline generated", note: "Events ordered oldest → newest." },
            { t: "T+10m", title: "Filings generated", note: "DIRS / OE-417 / NORS / SAR / BABA payloads created." },
            { t: "T+15m", title: "Packet exported", note: "ZIP + hashes produced for audit." },
          ].map((x, i) => (
            <div key={i} style={{ border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)", borderRadius: 12, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 900 }}>{x.title}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>{x.t}</div>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>{x.note}</div>
            </div>
          ))}
        </div>
      </details>


      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.7 }}>
        Saved locally so techs don’t lose their place.
      </div>

    </div>
  );
}
