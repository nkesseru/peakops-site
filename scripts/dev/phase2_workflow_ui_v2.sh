#!/usr/bin/env bash
set -euo pipefail

INC_PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/_components"
CARD="$COMP_DIR/WorkflowStepCard.tsx"
PANEL="$COMP_DIR/WorkflowPanel.tsx"

if [ ! -f "$INC_PAGE" ]; then
  echo "❌ Missing: $INC_PAGE"
  exit 1
fi

mkdir -p "$COMP_DIR"

echo "==> (1) Ensure WorkflowStepCard exists (animated expand/collapse)"
if [ ! -f "$CARD" ]; then
cat > "$CARD" <<'TSX'
"use client";
import React, { useMemo, useState } from "react";

type StepStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED" | string;

export type WorkflowStep = {
  key: string;
  title: string;
  status: StepStatus;
  hint?: string;
};

function badgeStyle(status: StepStatus): React.CSSProperties {
  const s = String(status || "TODO").toUpperCase();
  if (s === "DONE") return { background: "color-mix(in oklab, lime 22%, transparent)", border: "1px solid color-mix(in oklab, lime 30%, transparent)" };
  if (s === "IN_PROGRESS") return { background: "color-mix(in oklab, dodgerblue 18%, transparent)", border: "1px solid color-mix(in oklab, dodgerblue 28%, transparent)" };
  if (s === "BLOCKED") return { background: "color-mix(in oklab, crimson 18%, transparent)", border: "1px solid color-mix(in oklab, crimson 28%, transparent)" };
  return { background: "color-mix(in oklab, CanvasText 8%, transparent)", border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)" };
}

export default function WorkflowStepCard(props: {
  step: WorkflowStep;
  index: number;
  onSetStatus?: (key: string, status: StepStatus) => void;
}) {
  const { step, index, onSetStatus } = props;
  const status = String(step.status || "TODO").toUpperCase();
  const [open, setOpen] = useState(false);

  const chevron = useMemo(() => (
    <svg width="14" height="14" viewBox="0 0 20 20" style={{ display: "block" }}>
      <path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ), []);

  return (
    <div style={{
      borderRadius: 14,
      border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
      background: "color-mix(in oklab, CanvasText 3%, transparent)",
      overflow: "hidden",
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          background: "transparent",
          color: "CanvasText",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{
            width: 34, height: 34, borderRadius: 12,
            display: "grid", placeItems: "center",
            border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
            background: "color-mix(in oklab, CanvasText 5%, transparent)",
            fontWeight: 900,
            fontFamily: "ui-monospace, Menlo, monospace",
            opacity: 0.9,
          }}>{index + 1}</div>

          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>{step.title}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{step.key}</div>
          </div>

          <div style={{
            marginLeft: 8,
            padding: "4px 10px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 900,
            ...badgeStyle(status),
          }}>{status}</div>
        </div>

        <div style={{
          opacity: 0.85,
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 180ms ease",
        }}>{chevron}</div>
      </button>

      <div style={{
        maxHeight: open ? 240 : 0,
        opacity: open ? 1 : 0,
        transition: "max-height 220ms ease, opacity 160ms ease",
        overflow: "hidden",
      }}>
        <div style={{ padding: "0 14px 14px 14px", display: "grid", gap: 10 }}>
          {step.hint && <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.35 }}>{step.hint}</div>}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            {status === "DONE" && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetStatus?.(step.key, "TODO"); }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
                  background: "transparent",
                  color: "CanvasText",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >Undo</button>
            )}

            {status !== "DONE" && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetStatus?.(step.key, "DONE"); }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, lime 30%, transparent)",
                  background: "color-mix(in oklab, lime 18%, transparent)",
                  color: "CanvasText",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >Mark done</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
TSX
  echo "✅ wrote: $CARD"
else
  echo "✅ exists: $CARD"
fi

echo "==> (2) Write WorkflowPanel (fetch + optimistic overrides + localStorage)"
cat > "$PANEL" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import WorkflowStepCard, { WorkflowStep } from "./WorkflowStepCard";

type WorkflowResponse = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  asOf?: string;
  workflow?: { version?: string; steps?: WorkflowStep[] };
  error?: string;
};

export default function WorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [data, setData] = useState<WorkflowResponse | null>(null);

  const storageKey = useMemo(() => `wf_steps:${orgId}:${incidentId}`, [orgId, incidentId]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setOverrides(JSON.parse(raw));
    } catch {}
  }, [storageKey]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(overrides)); } catch {}
  }, [overrides, storageKey]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
      const j = (await r.json()) as WorkflowResponse;
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setData(j);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const steps = useMemo(() => {
    const arr = (data?.workflow?.steps || []) as WorkflowStep[];
    return arr.map((s) => {
      const key = String(s.key || "");
      const override = key ? overrides[key] : undefined;
      return { ...s, status: override ?? s.status ?? "TODO" };
    });
  }, [data, overrides]);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 900 }}>Guided Workflow</div>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ display: "grid", gap: 10 }}>
        {steps.map((step, idx) => (
          <WorkflowStepCard
            key={String(step.key || idx)}
            step={step as any}
            index={idx}
            onSetStatus={(k, st) => setOverrides((prev) => ({ ...prev, [String(k)]: String(st) }))}
          />
        ))}
      </div>
    </div>
  );
}
TSX
echo "✅ wrote: $PANEL"

echo "==> (3) Patch incidents page using hard markers (safe + deterministic)"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

bak = p.with_suffix(p.suffix + ".bak_phase2_wfpanel")
bak.write_text(s)

# Ensure import
if "WorkflowPanel" not in s:
    # add after last import
    imports = list(re.finditer(r"^import .*?;\s*$", s, flags=re.M))
    if not imports:
        raise SystemExit("❌ no imports found to patch")
    last = imports[-1]
    s = s[:last.end()] + '\nimport WorkflowPanel from "../../_components/WorkflowPanel";\n' + s[last.end():]

start = "{/*__WF_PANEL_START__*/}"
end   = "{/*__WF_PANEL_END__*/}"

block = f"""
      {start}
      <div style={{ marginTop: 10 }}>
        <WorkflowPanel orgId={{orgId}} incidentId={{incidentId}} />
      </div>
      {end}
"""

if start in s and end in s:
    s = re.sub(re.escape(start) + r".*?" + re.escape(end), block.strip(), s, flags=re.S)
else:
    # Insert near "Guided Workflow" header if present; otherwise append near bottom.
    idx = s.find("Guided Workflow")
    if idx != -1:
        # insert after that line
        m = re.search(r"Guided Workflow.*?\n", s[idx:])
        ins = idx + (m.end() if m else 0)
        s = s[:ins] + block + s[ins:]
    else:
        # fallback append before final return close
        m = re.search(r"\n\s*return\s*\(", s)
        if not m:
            raise SystemExit("❌ could not find return( to place workflow panel")
        # place after return(
        ins = m.end()
        s = s[:ins] + "\n" + block + "\n" + s[ins:]

p.write_text(s)
print("✅ patched incidents page:", p)
print("✅ backup:", bak)
PY

echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo
echo "✅ Done. Open:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "If anything explodes, restore instantly with:"
echo "  cp \"next-app/src/app/admin/incidents/[id]/page.tsx.bak_phase2_wfpanel\" \"next-app/src/app/admin/incidents/[id]/page.tsx\""
