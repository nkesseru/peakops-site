#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
BAK="${FILE}.bak_$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$BAK"
echo "✅ backup: $BAK"

# 1) Restore known-good baseline (the one you already used earlier)
GOOD="next-app/src/app/admin/incidents/[id]/page.tsx.bak_20260107_072845"
if [ -f "$GOOD" ]; then
  cp "$GOOD" "$FILE"
  echo "✅ restored from: $GOOD"
else
  echo "❌ expected baseline backup not found: $GOOD"
  echo "   List backups with: ls -la next-app/src/app/admin/incidents/[id]/page.tsx.bak_* | tail -n 20"
  exit 1
fi

# 2) Ensure GuidedWorkflowPanel component exists
mkdir -p next-app/src/app/admin/_components
cat > next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";

type Step = { key: string; title: string; status?: string; hint?: string };
type Workflow = { version?: string; steps?: Step[] };

function pill(active:boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 8%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 700,
    userSelect: "none",
  };
}

function box(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function readLocal(key: string): Record<string,string> {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}
function writeLocal(key: string, v: Record<string,string>) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;
  const storageKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<Workflow | null>(null);
  const [localStatus, setLocalStatus] = useState<Record<string,string>>(() => readLocal(storageKey));
  const [openKey, setOpenKey] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`, { method: "GET" });
      const t = await r.text();
      const j = JSON.parse(t);
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      const workflow = j.workflow || {};
      setWf(workflow);
      const first = (workflow.steps && workflow.steps[0] && workflow.steps[0].key) ? String(workflow.steps[0].key) : null;
      setOpenKey((k) => k ?? first);
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const steps: Step[] = (wf?.steps || []).map((s) => ({
    ...s,
    status: localStatus[String(s.key)] || s.status || "TODO",
  }));

  function setStatus(key: string, status: "TODO"|"DOING"|"DONE") {
    const k = String(key);
    const next = { ...localStatus, [k]: status };
    setLocalStatus(next);
    writeLocal(storageKey, next);
  }

  function StepCard({ step, idx }: { step: Step; idx: number }) {
    const k = String(step.key);
    const isOpen = openKey === k;

    return (
      <div style={{ ...box(), transition: "border-color 160ms ease" }}>
        <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"center" }}>
          <button
            onClick={() => setOpenKey(isOpen ? null : k)}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "grid",
              gap: 4,
              flex: 1,
            }}
          >
            <div style={{ display:"flex", gap:10, alignItems:"center" }}>
              <div style={{ fontWeight: 900 }}>{idx+1}. {step.title || step.key}</div>
              <span style={{ ...pill(false), opacity: 0.9 }}>{step.status}</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {step.hint || "Click to expand."}
            </div>
          </button>

          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button style={pill(step.status === "TODO")} onClick={() => setStatus(k, "TODO")}>TODO</button>
            <button style={pill(step.status === "DOING")} onClick={() => setStatus(k, "DOING")}>DOING</button>
            <button style={pill(step.status === "DONE")} onClick={() => setStatus(k, "DONE")}>DONE</button>
          </div>
        </div>

        <div
          style={{
            maxHeight: isOpen ? 240 : 0,
            overflow: "hidden",
            transition: "max-height 220ms ease",
          }}
        >
          <div style={{ paddingTop: 12, fontSize: 13, opacity: 0.85, lineHeight: 1.35 }}>
            {step.hint || "No extra details yet."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"grid", gap:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, flexWrap:"wrap" }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Local progress is saved on this device (per org + incident).
        </div>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div style={{ color:"crimson", fontWeight: 800, fontSize: 13 }}>
          {err}
        </div>
      )}

      {steps.length ? (
        <div style={{ display:"grid", gap:10 }}>
          {steps.map((s, i) => <StepCard key={String(s.key)} step={s} idx={i} />)}
        </div>
      ) : (
        <div style={{ opacity: 0.75 }}>No workflow steps yet.</div>
      )}
    </div>
  );
}
TSX
echo "✅ wrote: next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"

# 3) Patch incidents page safely INSIDE the return tree after Incident Summary
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Ensure import exists (next to other imports)
if "GuidedWorkflowPanel" not in s:
  s = re.sub(r'(from\s+"react";\s*\n)', r'\1import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\n', s, count=1)

START="/*__GUIDED_WORKFLOW_START__*/"
END="/*__GUIDED_WORKFLOW_END__*/"

block = f"""
{START}
<PanelCard title="Guided Workflow">
  <GuidedWorkflowPanel orgId={{orgId}} incidentId={{incidentId}} />
</PanelCard>
{END}
"""

# Remove previous marker blocks if any
s = re.sub(r"/\*__GUIDED_WORKFLOW_START__\*/[\s\S]*?/\*__GUIDED_WORKFLOW_END__\*/\s*", "", s)

# Insert after Incident Summary panel (inside JSX)
m = re.search(r'(<PanelCard\s+title="Incident Summary">[\s\S]*?</PanelCard>)', s)
if not m:
  raise SystemExit("❌ Could not find Incident Summary PanelCard in incidents page.")

insert_at = m.end()
s = s[:insert_at] + "\n" + block + "\n" + s[insert_at:]

p.write_text(s)
print("✅ inserted GuidedWorkflowPanel after Incident Summary")
PY

# 4) Restart Next + smoke
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
