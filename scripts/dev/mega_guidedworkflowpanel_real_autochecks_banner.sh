#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "${FILE}.bak_${TS}"
echo "✅ backup: ${FILE}.bak_${TS}"

cat > "$FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";

type StepStatus = "TODO" | "DOING" | "DONE";
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

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const storageKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const [wf, setWf] = useState<Workflow | null>(null);

  const [autoLevel, setAutoLevel] = useState<AutoLevel>("");
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
      // Baseline + meta signals via incident bundle
      const bUrl =
        `/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const bRes = await fetch(bUrl, { method: "GET" });
      const bTxt = await bRes.text();
      const bParsed = safeParseJson(bTxt || "");
      const bundle = bParsed.ok ? bParsed.value : null;

      const incident = bundle?.incident || bundle?.doc || bundle?.data || null;

      const title = String(incident?.title || "").trim();
      const startTime = incident?.startTime || incident?.createdAt || null;
      out.baselineOk = !!(incidentId && title && startTime);
      out.notes.push(out.baselineOk ? "Baseline OK: title + startTime present." : "Baseline missing: add title + startTime (Intake).");

      // Timeline check: meta or events exist
      const timelineMeta = bundle?.timelineMeta || incident?.timelineMeta || null;
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
      const filingsMeta = incident?.filingsMeta || null;
      const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
      out.filingsOk = !!(filingsMeta?.generatedAt || filings.length > 0);
      out.notes.push(out.filingsOk ? `Filings OK: ${filings.length || "meta"} present.` : "Filings missing: run Generate Filings.");

      // Packet check: HEAD download packet zip (no download)
      const pUrl =
        `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const pRes = await fetch(pUrl, { method: "HEAD" });
      out.packetOk = pRes.status === 200;
      out.notes.push(out.packetOk ? "Packet OK: download available." : "Packet not ready yet (or route failing).");

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
TSX

echo "✅ wrote: $FILE"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ still failing"; tail -n 200 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "✅ done"
