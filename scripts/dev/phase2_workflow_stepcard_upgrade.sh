#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(pwd)"
FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/_components"
COMP_FILE="$COMP_DIR/WorkflowStepCard.tsx"

if [ ! -f "$FILE" ]; then
  echo "❌ missing file: $FILE"
  exit 1
fi

mkdir -p "$COMP_DIR"

echo "==> (1) Write WorkflowStepCard component"
cat > "$COMP_FILE" <<'TSX'
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
  if (s === "DONE") return { background: "color-mix(in oklab, lime 25%, transparent)", border: "1px solid color-mix(in oklab, lime 35%, transparent)", color: "CanvasText" };
  if (s === "IN_PROGRESS") return { background: "color-mix(in oklab, dodgerblue 20%, transparent)", border: "1px solid color-mix(in oklab, dodgerblue 35%, transparent)", color: "CanvasText" };
  if (s === "BLOCKED") return { background: "color-mix(in oklab, crimson 22%, transparent)", border: "1px solid color-mix(in oklab, crimson 35%, transparent)", color: "CanvasText" };
  return { background: "color-mix(in oklab, CanvasText 10%, transparent)", border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)", color: "CanvasText" };
}

export default function WorkflowStepCard(props: {
  step: WorkflowStep;
  index: number;
  onSetStatus?: (key: string, status: StepStatus) => void;
}) {
  const { step, index, onSetStatus } = props;

  const status = String(step.status || "TODO").toUpperCase();
  const [open, setOpen] = useState(false);

  const canMarkDone = status !== "DONE";
  const canUndo = status === "DONE";

  const chevron = useMemo(() => {
    // tiny inline chevron (no deps)
    return (
      <svg width="14" height="14" viewBox="0 0 20 20" style={{ display: "block" }}>
        <path
          d="M6 8l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }, []);

  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      {/* header */}
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
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "color-mix(in oklab, CanvasText 5%, transparent)",
              fontWeight: 900,
              opacity: 0.9,
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
            title={`Step ${index + 1}`}
          >
            {index + 1}
          </div>

          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>{step.title}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{step.key}</div>
          </div>

          <div
            style={{
              marginLeft: 8,
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 800,
              ...badgeStyle(status),
            }}
          >
            {status}
          </div>
        </div>

        <div
          style={{
            opacity: 0.85,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 180ms ease",
          }}
        >
          {chevron}
        </div>
      </button>

      {/* animated body */}
      <div
        style={{
          maxHeight: open ? 220 : 0,
          opacity: open ? 1 : 0,
          transition: "max-height 220ms ease, opacity 160ms ease",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "0 14px 14px 14px", display: "grid", gap: 10 }}>
          {step.hint && (
            <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.35 }}>
              {step.hint}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            {canUndo && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSetStatus?.(step.key, "TODO");
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
                  background: "transparent",
                  color: "CanvasText",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Undo
              </button>
            )}

            {canMarkDone && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSetStatus?.(step.key, "DONE");
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, lime 30%, transparent)",
                  background: "color-mix(in oklab, lime 18%, transparent)",
                  color: "CanvasText",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                Mark done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
TSX

echo "✅ wrote: $COMP_FILE"

echo "==> (2) Patch incidents page to use WorkflowStepCard + optimistic overrides"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Safety backup
bak = p.with_suffix(p.suffix + ".bak_phase2_stepcard")
bak.write_text(s)

# Ensure import exists
if "WorkflowStepCard" not in s:
    # Insert after existing imports block (best-effort)
    # find last import line
    m = list(re.finditer(r"^import .*?;\s*$", s, flags=re.M))
    if not m:
        raise SystemExit("❌ Could not find import block to insert WorkflowStepCard import.")
    last = m[-1]
    insert_at = last.end()
    s = s[:insert_at] + "\nimport WorkflowStepCard from \"../../_components/WorkflowStepCard\";\n" + s[insert_at:]

# Ensure React hooks include useEffect (for localStorage)
# (Many files already import useEffect; handle lightly)
if re.search(r"from\s+\"react\";", s):
    # If react import exists but missing useEffect, add it
    def add_hook(match):
        inside = match.group(1)
        if "useEffect" in inside:
            return match.group(0)
        # insert useEffect after { 
        inside2 = inside.strip()
        # normalize commas
        parts = [x.strip() for x in inside2.split(",") if x.strip()]
        parts.append("useEffect")
        # keep stable-ish ordering
        # Move useEffect near the front if possible
        parts = sorted(set(parts), key=lambda x: ["useEffect","useMemo","useState"].index(x) if x in ["useEffect","useMemo","useState"] else 99)
        return f"import {{ {', '.join(parts)} }} from \"react\";"
    s = re.sub(r'import\s*\{\s*([^}]+)\s*\}\s*from\s*"react";', add_hook, s)

# Inject optimistic state near workflow state usage.
# We'll add a block once, keyed by a marker comment.
marker = "/* PHASE2_WORKFLOW_STEP_OVERRIDES */"
if marker not in s:
    # Try to place after: const [workflow, setWorkflow] = useState(...)
    m = re.search(r"const\s*\[\s*workflow\s*,\s*setWorkflow\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*", s)
    if not m:
        # fallback: after any 'useState' declaration block
        m = re.search(r"const\s*\[\s*workflow\s*,\s*setWorkflow\s*\]\s*=\s*useState\([^)]*\);\s*", s)
    if not m:
        raise SystemExit("❌ Could not find workflow state declaration to anchor optimistic overrides.")
    insert_at = m.end()

    inject = f"""
{marker}
  // Optimistic per-step status overrides (UI-only). Persisted in localStorage by orgId+incidentId.
  const [stepOverrides, setStepOverrides] = useState<Record<string, string>>({{}});
  const stepKey = useMemo(() => `wf_steps:${{orgId}}:${{incidentId}}`, [orgId, incidentId]);

  useEffect(() => {{
    try {{
      const raw = localStorage.getItem(stepKey);
      if (raw) setStepOverrides(JSON.parse(raw));
    }} catch {{}}
  }}, [stepKey]);

  useEffect(() => {{
    try {{
      localStorage.setItem(stepKey, JSON.stringify(stepOverrides));
    }} catch {{}}
  }}, [stepOverrides, stepKey]);

  const stepsResolved = useMemo(() => {{
    const arr = (workflow?.steps || []) as any[];
    return arr.map((st:any) => {{
      const k = String(st.key ?? "");
      const override = (k && (stepOverrides as any)[k]) ? (stepOverrides as any)[k] : null;
      return {{ ...st, status: override ?? st.status ?? "TODO" }};
    }});
  }}, [workflow, stepOverrides]);
"""
    s = s[:insert_at] + inject + s[insert_at:]

# Replace the existing workflow steps rendering with cards.
# Best-effort: find a ".steps.map(" block and replace only that portion.
# We'll replace the first occurrence inside Guided Workflow panel area by searching around "Guided Workflow".
guided_idx = s.find("Guided Workflow")
if guided_idx == -1:
    raise SystemExit("❌ Could not find 'Guided Workflow' section in incidents page (string not found).")

window = s[guided_idx:guided_idx+8000]

# Find a map block like: workflow.steps.map(...)
m = re.search(r"workflow\.steps\s*\.\s*map\s*\([^)]*\)\s*=>\s*\(", window)
if not m:
    # maybe stepsResolved exists already? look for workflow.steps?.map
    m = re.search(r"workflow\?\.\s*steps\s*\?\.\s*map\s*\([^)]*\)\s*=>\s*\(", window)
if not m:
    # If we can't find it, we will insert a card list just below the "Guided Workflow" heading.
    # This is less risky than guessing JSX boundaries.
    insert_point = guided_idx
    # find the next line after the Guided Workflow header text
    line_m = re.search(r"Guided Workflow.*?\n", s[guided_idx:])
    if not line_m:
        raise SystemExit("❌ Could not locate insertion point after Guided Workflow header.")
    insert_at = guided_idx + line_m.end()

    add = """
      {/* Step cards (Phase 2) */}
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {stepsResolved.map((step:any, idx:number) => (
          <WorkflowStepCard
            key={String(step.key || idx)}
            step={step}
            index={idx}
            onSetStatus={(key, status) => setStepOverrides(prev => ({ ...prev, [key]: String(status) }))}
          />
        ))}
      </div>
"""
    s = s[:insert_at] + add + s[insert_at:]
else:
    # Replace the entire list content between the opening map and its closing parenthesis/brace.
    # We'll do a simpler replace: replace "workflow.steps.map(...)" expression with "stepsResolved.map(...)"
    # and replace any <WorkflowStepCard ...> name if it was previously used.
    s = s.replace("workflow.steps", "stepsResolved")

# Write back
p.write_text(s)
print(f"✅ patched: {p}")
print(f"✅ backup: {bak}")
PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> OPEN"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 80 .logs/next.log"
