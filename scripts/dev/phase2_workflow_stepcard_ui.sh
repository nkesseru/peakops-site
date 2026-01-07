#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-$HOME/peakops/my-app}"
cd "$REPO"

NEXT_APP="next-app"
ADMIN_COMPONENTS="$NEXT_APP/src/app/admin/_components"
INCIDENT_PAGE="$NEXT_APP/src/app/admin/incidents/[id]/page.tsx"

echo "==> Phase 2 StepCard UI patch"
echo "repo: $REPO"
echo "incident page: $INCIDENT_PAGE"
echo

mkdir -p "$ADMIN_COMPONENTS"

echo "==> (1) Write WorkflowStepCard component"
cat > "$ADMIN_COMPONENTS/WorkflowStepCard.tsx" <<'TSX'
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export type WorkflowStepStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "ERROR";

export type WorkflowStep = {
  key: string;
  title: string;
  status: WorkflowStepStatus;
  hint?: string;
};

function pillStyle(status: WorkflowStepStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 800,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    letterSpacing: 0.2,
    opacity: 0.92,
  };

  // Keep colors subtle (Apple-ish), but still readable.
  const map: Record<WorkflowStepStatus, React.CSSProperties> = {
    TODO: { color: "color-mix(in oklab, CanvasText 88%, transparent)" },
    IN_PROGRESS: { color: "color-mix(in oklab, CanvasText 92%, transparent)" },
    DONE: { color: "color-mix(in oklab, CanvasText 92%, transparent)" },
    BLOCKED: { color: "color-mix(in oklab, crimson 70%, CanvasText 20%)" },
    ERROR: { color: "color-mix(in oklab, crimson 75%, CanvasText 15%)" },
  };

  return { ...base, ...map[status] };
}

function statusLabel(status: WorkflowStepStatus): string {
  switch (status) {
    case "IN_PROGRESS": return "IN PROGRESS";
    default: return status;
  }
}

export function WorkflowStepCard(props: {
  step: WorkflowStep;
  index: number;

  // Called when user clicks "Mark done" etc; we keep it flexible.
  onRun?: (stepKey: string) => Promise<void>;
  onMarkDone?: (stepKey: string) => Promise<void>;
  onReset?: (stepKey: string) => Promise<void>;
}) {
  const { step, index } = props;

  const [open, setOpen] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<WorkflowStepStatus>(step.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    // If parent refreshes data, sync down unless we’re busy.
    if (!busy) setOptimisticStatus(step.status);
  }, [step.status, busy]);

  // Animated collapse via maxHeight.
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxH, setMaxH] = useState<number>(0);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const update = () => setMaxH(open ? el.scrollHeight : 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const canRun = useMemo(() => !!props.onRun, [props.onRun]);
  const canDone = useMemo(() => !!props.onMarkDone, [props.onMarkDone]);
  const canReset = useMemo(() => !!props.onReset, [props.onReset]);

  async function optimisticWrap(nextStatus: WorkflowStepStatus, fn?: () => Promise<void>) {
    if (!fn) return;
    setErr("");
    setBusy(true);

    const prev = optimisticStatus;
    setOptimisticStatus(nextStatus);

    try {
      await fn();
      // stay optimistic; parent refresh will reconcile
    } catch (e: any) {
      setOptimisticStatus(prev);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const cardBorder = err
    ? "1px solid color-mix(in oklab, crimson 40%, transparent)"
    : "1px solid color-mix(in oklab, CanvasText 12%, transparent)";

  return (
    <div
      style={{
        border: cardBorder,
        borderRadius: 14,
        overflow: "hidden",
        background: "color-mix(in oklab, CanvasText 3.5%, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "CanvasText",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 10,
              display: "grid",
              placeItems: "center",
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              fontWeight: 900,
              fontSize: 12,
              flex: "0 0 auto",
              opacity: 0.9,
            }}
            title={`Step ${index + 1}`}
          >
            {index + 1}
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, lineHeight: 1.2 }}>
              {step.title}
            </div>
            {step.hint ? (
              <div style={{ opacity: 0.75, fontSize: 13, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {step.hint}
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" }}>
          <span style={pillStyle(optimisticStatus)}>{statusLabel(optimisticStatus)}</span>
          <span
            style={{
              opacity: 0.7,
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 180ms ease",
              fontWeight: 900,
            }}
            aria-hidden
          >
            ▾
          </span>
        </div>
      </button>

      <div
        style={{
          maxHeight: maxH,
          transition: "max-height 220ms ease",
          overflow: "hidden",
        }}
      >
        <div
          ref={innerRef}
          style={{
            padding: "0 14px 14px 14px",
            opacity: open ? 1 : 0,
            transform: open ? "translateY(0px)" : "translateY(-2px)",
            transition: "opacity 160ms ease, transform 160ms ease",
          }}
        >
          <div style={{ height: 10 }} />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {canRun ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  optimisticWrap("IN_PROGRESS", () => props.onRun?.(step.key) || Promise.resolve())
                }
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
                  background: "color-mix(in oklab, CanvasText 7%, transparent)",
                  color: "CanvasText",
                  cursor: busy ? "not-allowed" : "pointer",
                  fontWeight: 900,
                }}
              >
                {busy ? "Working…" : "Run step"}
              </button>
            ) : null}

            {canDone ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  optimisticWrap("DONE", () => props.onMarkDone?.(step.key) || Promise.resolve())
                }
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
                  background: "color-mix(in oklab, CanvasText 7%, transparent)",
                  color: "CanvasText",
                  cursor: busy ? "not-allowed" : "pointer",
                  fontWeight: 900,
                }}
              >
                Mark done
              </button>
            ) : null}

            {canReset ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  optimisticWrap("TODO", () => props.onReset?.(step.key) || Promise.resolve())
                }
                style={{
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
                  background: "transparent",
                  color: "color-mix(in oklab, CanvasText 86%, transparent)",
                  cursor: busy ? "not-allowed" : "pointer",
                  fontWeight: 800,
                  opacity: 0.9,
                }}
              >
                Reset
              </button>
            ) : null}

            <div style={{ flex: 1 }} />

            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                padding: "8px 12px",
                borderRadius: 12,
                border: "1px solid transparent",
                background: "transparent",
                color: "color-mix(in oklab, CanvasText 72%, transparent)",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Close
            </button>
          </div>

          {err ? (
            <div style={{ marginTop: 10, color: "crimson", fontWeight: 900, fontSize: 13 }}>
              {err}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
TSX

echo "✅ wrote: $ADMIN_COMPONENTS/WorkflowStepCard.tsx"
echo

if [ ! -f "$INCIDENT_PAGE" ]; then
  echo "❌ Could not find incident page at: $INCIDENT_PAGE"
  echo "   Adjust INCIDENT_PAGE in this script, then re-run."
  exit 1
fi

echo "==> (2) Patch incidents/[id]/page.tsx to use WorkflowStepCard"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Ensure import
if "WorkflowStepCard" not in s:
  # Put after "use client" block and existing imports.
  # Find first import line
  m = re.search(r'^(import .+)$', s, re.M)
  if not m:
    raise SystemExit("❌ No import block found to insert WorkflowStepCard import")
  insert_at = m.start()
  s = s[:insert_at] + 'import { WorkflowStepCard } from "../_components/WorkflowStepCard";\n' + s[insert_at:]

# Find Guided Workflow section header (very forgiving)
anchor = re.search(r'Guided Workflow', s)
if not anchor:
  raise SystemExit("❌ Could not find 'Guided Workflow' in incidents page. Patch manually.")

# Try to locate a steps rendering area near it; we’ll replace only the list body.
# Heuristic: look for something like workflow.steps.map(...) within 2000 chars after the anchor.
window = s[anchor.start():anchor.start()+2500]
m = re.search(r'workflow\.\s*steps\s*\.map\s*\(\s*\(\s*[^)]*\)\s*=>\s*\(', window)
if not m:
  # If we can’t locate a map, we still inject a safe render block right after the Guided Workflow title line.
  # Insert a new block after the first occurrence of the title text.
  s = s.replace("Guided Workflow", "Guided Workflow", 1)  # no-op, keep for clarity
  # Insert after the first occurrence of Guided Workflow header line break.
  insert_point = anchor.end()
  injected = r'''
{/* Step cards (Phase 2) */}
{workflow?.steps?.length ? (
  <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
    {workflow.steps.map((step: any, idx: number) => (
      <WorkflowStepCard
        key={String(step.key || idx)}
        step={step}
        index={idx}
        // Zero backend changes: these are optimistic UI only for now.
        onMarkDone={async () => {}}
      />
    ))}
  </div>
) : (
  <div style={{ opacity: 0.75 }}>No workflow steps yet.</div>
)}
'''
  s = s[:insert_point] + injected + s[insert_point:]
  p.write_text(s)
  print("✅ injected WorkflowStepCard block (fallback insert)")
  raise SystemExit(0)

# We found a map opening. Now we want to replace the whole existing steps list render with our StepCard grid.
# To do that reliably, locate the nearest enclosing braces around a block that includes workflow.steps.map.
# We'll do a more direct replace: replace "workflow.steps.map(...)" expression with our card rendering.
window2 = s[anchor.start():anchor.start()+4000]

# Replace the first "workflow.steps.map(...)" chunk up to matching close ")}" is hard by regex;
# Instead, swap the ".map" line to StepCard mapping and keep the surrounding structure.
# We'll target "workflow.steps.map((step" and replace the inner return with <WorkflowStepCard ...>.
pattern = re.compile(r'workflow\.steps\.map\(\(([^)]*)\)\s*=>\s*\((.*?)\)\s*\)', re.S)
m2 = pattern.search(window2)
if not m2:
  raise SystemExit("❌ Found workflow.steps.map but couldn't rewrite it (unexpected shape).")

full = m2.group(0)

replacement = r'''workflow.steps.map((step: any, idx: number) => (
  <WorkflowStepCard
    key={String(step.key || idx)}
    step={step}
    index={idx}
    // Zero backend changes: optimistic only (no API calls yet).
    onMarkDone={async () => {}}
  />
))'''

window2_new = window2.replace(full, replacement, 1)
s = s[:anchor.start()] + window2_new + s[anchor.start()+len(window2):]
p.write_text(s)
print("✅ rewired workflow.steps.map -> WorkflowStepCard")
PY

echo "✅ patched: $INCIDENT_PAGE"
echo

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo
echo "✅ Done. Open:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 120 .logs/next.log"
