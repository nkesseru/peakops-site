#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$FILE" "scripts/dev/_bak/GuidedWorkflowPanel.tsx.bak_${TS}"
echo "✅ backup: scripts/dev/_bak/GuidedWorkflowPanel.tsx.bak_${TS}"

cat > "$FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";

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
    const next = { ...localStatus, [k]: status };
    setLocalStatus(next);
    writeLocal(storageKey, next);
  }

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
TSX

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
curl -fsS "$URL" >/dev/null && echo "✅ incidents page OK" || { echo "❌ incidents page fail"; tail -n 120 .logs/next.log; exit 1; }

echo "OPEN:"
echo "  $URL"
