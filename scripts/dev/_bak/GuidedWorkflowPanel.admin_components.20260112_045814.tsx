"use client";

import React, { useEffect, useMemo, useState } from "react";

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


type StepStatus = "TODO" | "DOING" | "DONE";
type Step = { key: string; title?: string; hint?: string; status?: StepStatus };
type Workflow = { version?: string; steps?: Step[] };

function frame(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

function statusTone(status: StepStatus) {
  // subtle but obvious: gray / amber / green
  if (status === "DONE") return { fg: "color-mix(in oklab, lime 65%, CanvasText)", bg: "color-mix(in oklab, lime 18%, transparent)", bd: "color-mix(in oklab, lime 28%, transparent)" };
  if (status === "DOING") return { fg: "color-mix(in oklab, gold 70%, CanvasText)", bg: "color-mix(in oklab, gold 16%, transparent)", bd: "color-mix(in oklab, gold 26%, transparent)" };
  return { fg: "CanvasText", bg: "transparent", bd: "color-mix(in oklab, CanvasText 18%, transparent)" };
}

function pillBase(): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: "pointer",
    userSelect: "none",
    lineHeight: "16px",
  };
}

function statusBadge(status: StepStatus): React.CSSProperties {
  const t = statusTone(status);
  return {
    ...pillBase(),
    border: `1px solid ${t.bd}`,
    background: t.bg,
    color: t.fg,
  };
}

function statusButton(active: boolean, status: StepStatus): React.CSSProperties {
  const t = statusTone(status);
  return {
    ...pillBase(),
    border: `1px solid ${active ? t.bd : "color-mix(in oklab, CanvasText 18%, transparent)"}`,
    background: active ? t.bg : "transparent",
    color: active ? t.fg : "CanvasText",
    opacity: active ? 1 : 0.92,
  };
}

function neutralButton(): React.CSSProperties {
  return {
    ...pillBase(),
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
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


  const [meta, setMeta] = useState<any>(null);
  
  const [autoDone, setAutoDone] = useState<Record<string, boolean>>({});
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

  async function exportNow() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&limit=200`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error(`Export API returned empty body (HTTP ${r.status})`);

      const parsed = (typeof safeParseJson === "function")
        ? safeParseJson(text)
        : (typeof safeJson === "function" ? safeJson(text) : { ok:false, err:"No JSON parser helper" });

      if (!(parsed as any).ok) {
        const sample = text.slice(0, 120).replace(/\s+/g, " ");
        throw new Error(`Export API returned non-JSON (HTTP ${r.status}): ${(parsed as any).error || (parsed as any).err} — ${sample}`);
      }

      const j = (parsed as any).value ?? (parsed as any).v;
      if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 failed"));

      // Merge any returned packetMeta into meta so exportReady can flip immediately
      setMeta((m: any) => ({ ...(m || {}), ...(j || {}), packetMeta: j?.packetMeta || (m?.packetMeta) || null }));

      // Refresh workflow/meta from backend
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

      const parsed = safeParseJson(text);
      if (!parsed.ok) {
        const sample = text.slice(0, 120).replace(/\s+/g, " ");
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status}): ${parsed.error} — ${sample}`);
      }

      const j = parsed.value;
      const incidentMeta = j?.incident || null;
      setMeta(incidentMeta);
      if (j?.ok === false) throw new Error(String(j?.error || "getWorkflowV1 failed"));

      const workflow: Workflow = j?.workflow || {};
      setWf(workflow);

      
      setMeta(j);
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

  function setStatus(key: string, status: StepStatus) {
    const k = String(key);
    const next = { ...localStatus, [k]: status };
    setLocalStatus(next);
    writeLocal(storageKey, next);
  }

  
  // Auto-advance steps based on backend-derived meta (while keeping tech override via localStorage)
  useEffect(() => {
    if (!meta) return;

    const next = { ...localStatus };
    let changed = false;

    const timelineReady =
      !!(meta?.timelineMeta && (meta.timelineMeta.eventCount > 0 || meta.timelineMeta.generatedAt));
    const filingsReady = !!(meta?.filingsMeta && (meta.filingsMeta.count > 0 || (meta.filingsMeta.schemas && meta.filingsMeta.schemas.length)));
    const exportReady = !!(meta?.packetMeta && (meta.packetMeta.packetHash || meta.packetMeta.hash));
    // optional baseline heuristic (safe): if incident exists + has id, treat intake as done
    const intakeReady = !!(meta?.id && String(meta.id) === String(incidentId) && (!meta?.orgId || String(meta.orgId) === String(orgId)));
function mark(k: string, v: "DONE") {
      if (next[k] !== v) {
        next[k] = v;
        changed = true;
        // track that this step was auto-promoted
        setAutoDone((m) => ({ ...m, [k]: true }));
      }
    }
// Only promote to DONE (never auto-demote)
    if (intakeReady) mark("intake", "DONE");
    if (timelineReady) mark("timeline", "DONE");
    if (filingsReady) mark("filings", "DONE");
    if (exportReady) mark("export", "DONE");

    if (changed) {
      setLocalStatus(next);
      writeLocal(storageKey, next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  const donePct = percentDone(steps);

  return (
    <div style={frame()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 950 }}>Guided Workflow</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {steps.length} steps · {donePct}% complete
          </div>
        </div>

        <button onClick={load} disabled={busy} style={neutralButton()}>
          {busy ? "Loading…" : "Refresh"}
        </button>
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
            const st = (s.status || "TODO") as StepStatus;
            return (
              <div key={String(s.key || idx)} style={frame()}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 950 }}>
                    {idx + 1}. {s.title || s.key}
                  </div>
                  <span style={statusBadge(st)}>{st}</span>
                </div>

                {s.hint && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{s.hint}</div>}

                
                {String(s.key) === "export" && (
                  <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      style={pill(false)}
                      onClick={() => void exportNow()}
                      disabled={busy}
                      title="Generate the immutable packet + hashes (read-only export)"
                    >
                      {busy ? "Exporting…" : "Export Packet"}
                    </button>

                    {exportReady && (
                      <span style={{ fontSize: 12, opacity: 0.8 }}>
                        ✅ packetMeta present
                      </span>
                    )}
                  </div>
                )}
<div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button style={statusButton(st === "TODO", "TODO")} onClick={() => setStatus(String(s.key), "TODO")}>TODO</button>
                  <button style={statusButton(st === "DOING", "DOING")} onClick={() => setStatus(String(s.key), "DOING")}>DOING</button>
                  <button style={statusButton(st === "DONE", "DONE")} onClick={() => setStatus(String(s.key), "DONE")}>DONE</button>
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
