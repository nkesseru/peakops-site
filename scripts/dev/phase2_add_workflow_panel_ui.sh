#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

APP="next-app/src/app"

echo "==> (1) Create WorkflowPanel component"
mkdir -p "$APP/admin/incidents/_components"

cat > "$APP/admin/incidents/_components/WorkflowPanel.tsx" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Step = {
  key: string;
  title: string;
  done?: boolean;
};

type WorkflowResp = {
  ok: boolean;
  error?: string;
  orgId?: string;
  incidentId?: string;
  workflowId?: string;
  status?: string;
  steps?: Step[];
};

function pillStyle(kind: "ok" | "warn" | "off") {
  const base: any = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
  };
  if (kind === "ok") {
    base.border = "1px solid color-mix(in oklab, #18a34a 40%, transparent)";
    base.background = "color-mix(in oklab, #18a34a 16%, transparent)";
  }
  if (kind === "warn") {
    base.border = "1px solid color-mix(in oklab, #f59e0b 45%, transparent)";
    base.background = "color-mix(in oklab, #f59e0b 16%, transparent)";
  }
  return base;
}

function btnStyle(disabled?: boolean) {
  return {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    fontWeight: 800,
    fontSize: 13,
  } as const;
}

export default function WorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<WorkflowResp | null>(null);

  async function load() {
    setErr(null);
    setBusy("load");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`, { cache: "no-store" });
      const j = (await r.json()) as WorkflowResp;
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setData(j);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setData(null);
    } finally {
      setBusy(null);
    }
  }

  // Optional: if you have computeWorkflowV1 route, we’ll call it. If not, we just refresh.
  async function recompute() {
    setErr(null);
    setBusy("recompute");
    try {
      const r = await fetch(`/api/fn/computeWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&persist=true`, { cache: "no-store" });
      // computeWorkflowV1 may not exist yet; treat 404 as “no-op” and just reload
      if (r.status !== 404) {
        const j = await r.json();
        if (!j?.ok) throw new Error(j?.error || "computeWorkflowV1 failed");
      }
      await load();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const steps = useMemo(() => (data?.steps || []), [data]);
  const doneCount = useMemo(() => steps.filter(s => !!s.done).length, [steps]);
  const pct = useMemo(() => (steps.length ? Math.round((doneCount / steps.length) * 100) : 0), [doneCount, steps.length]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={pillStyle(steps.length ? (pct === 100 ? "ok" : "warn") : "off")}>
            <span style={{ opacity: 0.8 }}>Progress</span>
            <span>{pct}%</span>
          </div>
          <div style={pillStyle("off")}>
            <span style={{ opacity: 0.8 }}>Stage</span>
            <span>{data?.status || "—"}</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {steps.length ? `${doneCount}/${steps.length} steps done` : "No workflow data yet"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button style={btnStyle(!!busy)} onClick={load} disabled={!!busy}>
            {busy === "load" ? "Loading…" : "Refresh"}
          </button>
          <button style={btnStyle(!!busy)} onClick={recompute} disabled={!!busy}>
            {busy === "recompute" ? "Computing…" : "Recompute"}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 10,
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
        background: "color-mix(in oklab, CanvasText 4%, transparent)",
        overflow: "hidden"
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: "color-mix(in oklab, CanvasText 30%, transparent)"
        }} />
      </div>

      {err && (
        <div style={{
          padding: 12,
          borderRadius: 12,
          border: "1px solid color-mix(in oklab, crimson 35%, transparent)",
          background: "color-mix(in oklab, crimson 10%, transparent)",
          color: "crimson",
          fontWeight: 800
        }}>
          {err}
        </div>
      )}

      {/* Steps */}
      <div style={{ display: "grid", gap: 10 }}>
        {steps.map((s) => (
          <div key={s.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              padding: 12,
              borderRadius: 14,
              border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
              background: "color-mix(in oklab, CanvasText 3%, transparent)",
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{
                width: 18, height: 18, borderRadius: 6,
                border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
                background: s.done ? "color-mix(in oklab, #18a34a 25%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)"
              }} />
              <div>
                <div style={{ fontWeight: 900 }}>{s.title}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>{s.key}</div>
              </div>
            </div>

            {/* Placeholder links (wire these later) */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Link
                href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`}
                style={{
                  fontSize: 12,
                  opacity: 0.9,
                  textDecoration: "none",
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
                  color: "CanvasText",
                }}
              >
                Open
              </Link>
            </div>
          </div>
        ))}

        {!busy && !err && steps.length === 0 && (
          <div style={{ padding: 12, opacity: 0.75 }}>
            No workflow steps found. (That’s okay — compute will create a default once your backend persists workflow docs.)
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Tip: this is the “pilot checklist” for operators. Keep it brutally simple — green checks, clear next action.
      </div>
    </div>
  );
}
TSX

echo "✅ wrote WorkflowPanel.tsx"

echo "==> (2) Patch incident detail page to include WorkflowPanel card"
FILE="$APP/admin/incidents/[id]/page.tsx"

if [ ! -f "$FILE" ]; then
  echo "❌ cannot find $FILE"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
imp = 'import WorkflowPanel from "../_components/WorkflowPanel";\n'
if imp not in s:
    # insert after "use client" or after first import block
    if '"use client"' in s or "'use client'" in s:
        lines = s.splitlines(True)
        out = []
        inserted = False
        for i, line in enumerate(lines):
            out.append(line)
            if (not inserted) and ("use client" in line):
                # insert after the directive line
                out.append("\n" + imp)
                inserted = True
        s = "".join(out)
    else:
        s = imp + s
needle = '<IncidentSummaryCard incident={incident} />'
if 'title="Guided Workflow"' not in s:
    if needle in s:
        block = f'''
        </PanelCard>

        <PanelCard title="Guided Workflow">
          <WorkflowPanel orgId={{{{orgId}}}} incidentId={{{{incidentId}}}} />
        </PanelCard>

        <PanelCard title="Filing Actions">
'''
        s = s.replace('</PanelCard>\n\n        <PanelCard title="Filing Actions">', block)
    else:
        # fallback: put near top of return, after first PanelCard
        marker = "<PanelCard"
        idx = s.find(marker)
        if idx != -1:
            insert = '\n        <PanelCard title="Guided Workflow">\n          <WorkflowPanel orgId={orgId} incidentId={incidentId} />\n        </PanelCard>\n'
            s = s[:idx] + insert + s[idx:]

p.write_text(s)
print("✅ patched incidents/[id]/page.tsx (import + Guided Workflow card)")
PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> (4) Quick smoke"
curl -fsS "http://127.0.0.1:3000" >/dev/null && echo "✅ Next OK" || (echo "❌ Next not responding" && tail -n 120 .logs/next.log && exit 1)

echo
echo "✅ Phase 2 UI patched."
echo "OPEN (example):"
echo "  http://localhost:3000/admin/incidents/<INCIDENT_ID>?orgId=org_001"
echo
echo "If /api/fn/getWorkflowV1 returns 404, your emulator isn't exporting it yet."
echo "Smoke:"
echo "  curl -sS 'http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST' | head -c 260; echo"
