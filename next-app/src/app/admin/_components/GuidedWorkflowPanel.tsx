"use client";


/**
 * GuidedWorkflowPanel
 *
 * Canonical workflow renderer (intentionally self-contained).
 * - Do NOT import external workflow state helpers (no useWorkflowState / WorkflowStepCard)
 * - Steps are driven by API response + localStorage only
 * - Keep edits small + surgical (this file is a stability anchor)
 */

import React, { useEffect, useMemo, useState } from "react";

type StepStatus = "TODO" | "DOING" | "DONE";
type Step = { key: string; title?: string; hint?: string; status?: StepStatus };
type Workflow = { version?: string; steps?: Step[] };

function pill(active: boolean, level: "NORMAL" | "DOING" = "NORMAL"): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: "pointer",
    userSelect: "none",
    display: "inline-flex",
    gap: 8,
    alignItems: "center",
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

function safeParseJson(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
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

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const storageKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<Workflow | null>(null);

  const [localStatus, setLocalStatus] = useState<Record<string, StepStatus>>(() =>
    typeof window === "undefined" ? {} : readLocal(storageKey)
  );

  // Derived backend readiness signals
  const intakeReady = true; // In your current stub world: orgId+incidentId exist => Intake valid
  const timelineReady = false; // becomes true when we wire incident+timeline meta as real state
  const filingsReady = false;
  const exportReady = false;

  // Track which steps were auto-advanced (so we can show AUTO badge and avoid fighting humans)
  const [autoDone, setAutoDone] = useState<Record<string, boolean>>({});

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

      if (!text || !text.trim()) throw new Error(`Workflow API returned empty body (HTTP ${r.status})`);

      const parsed = safeParseJson(text);
      if (!parsed.ok) {
        const sample = text.slice(0, 120).replace(/\s+/g, " ");
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status}): ${parsed.error} — ${sample}`);
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

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  function setStatus(key: string, status: StepStatus) {
    const k = String(key);

    // 1) Update the clicked step
    const next = { ...localStatus, [k]: status };

    // 2) Auto-advance: if user marks a step DONE, set the *next* step to DOING (only if it's still TODO)
    try {
      if (status === "DONE" && steps && steps.length) {
        const idx = steps.findIndex((x) => String(x?.key) === k);
        if (idx >= 0 && idx + 1 < steps.length) {
          const nextKey = String(steps[idx + 1]?.key || "");
          if (nextKey) {
            const current = next[nextKey] || steps[idx + 1]?.status || "TODO";
            if (current === "TODO") {
              next[nextKey] = "DOING";
            }
          }
        }
      }
    } catch {
      // never block UI
    }

    setLocalStatus(next);
    writeLocal(storageKey, next);
  }

  // ✅ Auto-advance steps 1-4 based on readiness, but never force backwards.
  useEffect(() => {
    if (!steps.length) return;

    const want: Record<string, StepStatus> = {};
    const auto: Record<string, boolean> = {};

    // Helper: only move forward
    const forward = (key: string, nextStatus: StepStatus, autoKey?: string) => {
      const cur = localStatus[key] || "TODO";
      const rank = (s: StepStatus) => (s === "TODO" ? 0 : s === "DOING" ? 1 : 2);
      if (rank(nextStatus) > rank(cur)) {
        want[key] = nextStatus;
        if (autoKey) auto[autoKey] = true;
      }
    };

    if (intakeReady) forward("intake", "DONE", "intake");
    if (timelineReady) forward("timeline", "DONE", "timeline");
    if (filingsReady) forward("filings", "DONE", "filings");
    if (exportReady) forward("export", "DONE", "export");

    if (Object.keys(want).length) {
      const next = { ...localStatus, ...want };
      setLocalStatus(next);
      writeLocal(storageKey, next);
      setAutoDone((m) => ({ ...m, ...auto }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length, intakeReady, timelineReady, filingsReady, exportReady]);

  async function exportNow() {
    setBusy(true);
    setErr("");
    try {
      // Kick export (safe even if backend just returns meta)
      const api =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(api, { method: "GET" });
      const txt = await r.text().catch(() => "");

      // If backend returns JSON ok:false, surface it. Otherwise ignore parse failures.
      try {
        const j = JSON.parse(txt || "{}");
        if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 failed"));
      } catch {
        // ignore non-JSON
      }

      // Always open bundle view (canonical artifact viewer)
      const bundleUrl =
        `/admin/incidents/${encodeURIComponent(incidentId)}` +
        `/bundle?orgId=${encodeURIComponent(orgId)}`;
      window.open(bundleUrl, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const donePct = percentDone(steps);

  return (
    <div style={card()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 950 }}>Guided Workflow</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {steps.length} steps · {donePct}% complete
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={load} disabled={busy} style={pill(false)}>
            {busy ? "Loading…" : "Refresh"}
          </button>

          <button
            style={pill(false)}
            onClick={() => void exportNow()}
            disabled={busy}
            title="Generate the immutable packet + hashes (read-only export)"
          >
            Export Bundle →
          </button>
        </div>
      </div>

      {err && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      {!err && steps.length === 0 && <div style={{ marginTop: 10, opacity: 0.75 }}>No workflow steps.</div>}

      {!err && steps.length > 0 && (
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {steps.map((s, idx) => {
            const st = s.status || "TODO";
            const auto = autoDone[String(s.key)];
            return (
              <div key={String(s.key || idx)} style={card()}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 950 }}>
                    {idx + 1}. {s.title || s.key}
                  </div>

                  <span style={pill(true)}>
                    {st}
                    {auto ? (
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 900,
                          border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                          background: "color-mix(in oklab, lime 18%, transparent)",
                        }}
                      >
                        AUTO
                      </span>
                    ) : null}
                  </span>
                </div>

                {s.hint && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{s.hint}</div>}

                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button style={pill(st === "TODO")} onClick={() => setStatus(String(s.key), "TODO")}>
                    TODO
                  </button>
                  <button style={pill(st === "DOING")} onClick={() => setStatus(String(s.key), "DOING")}>
                    DOING
                  </button>
                  <button style={pill(st === "DONE")} onClick={() => setStatus(String(s.key), "DONE")}>
                    DONE
                  </button>
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
