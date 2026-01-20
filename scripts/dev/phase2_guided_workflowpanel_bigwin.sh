#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

INC_PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/incidents/_components"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$INC_PAGE" "scripts/dev/_bak/incidents_id_page.${ts}.bak"
echo "✅ backup: scripts/dev/_bak/incidents_id_page.${ts}.bak"

mkdir -p "$COMP_DIR"

# -------------------------------
# 1) useWorkflowState.ts
# -------------------------------
cat > "$COMP_DIR/useWorkflowState.ts" <<'TS'
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type WorkflowStatus = "TODO" | "DOING" | "DONE";

export type WorkflowStep = {
  key: string;
  title: string;
  hint?: string;
  status?: WorkflowStatus; // backend may send, but we override with local
};

export type WorkflowV1 = {
  version: string;
  steps: WorkflowStep[];
};

type ApiResp = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  workflow?: WorkflowV1;
  error?: string;
};

function storageKey(orgId: string, incidentId: string) {
  return `wf:${orgId}:${incidentId}:v1`;
}

function safeParseJSON(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function useWorkflowState(orgId: string, incidentId: string) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [workflow, setWorkflow] = useState<WorkflowV1 | null>(null);

  const localMap = useMemo(() => {
    if (typeof window === "undefined") return {};
    const m = safeParseJSON(localStorage.getItem(storageKey(orgId, incidentId)));
    return (m && typeof m === "object") ? m : {};
  }, [orgId, incidentId]);

  const merged = useMemo(() => {
    if (!workflow) return null;
    const steps = (workflow.steps || []).map(s => {
      const k = String(s.key);
      const local = localMap[k] as WorkflowStatus | undefined;
      return { ...s, status: local || (s.status as WorkflowStatus) || "TODO" };
    });
    return { ...workflow, steps };
  }, [workflow, localMap]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const url = `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      let j: ApiResp | null = null;
      try { j = JSON.parse(text); } catch {
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status})`);
      }
      if (!j?.ok) throw new Error(j?.error || "getWorkflowV1 failed");
      setWorkflow(j.workflow || { version: "v1", steps: [] });
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [orgId, incidentId]);

  useEffect(() => { refresh(); }, [refresh]);

  const setLocalStatus = useCallback((stepKey: string, status: WorkflowStatus) => {
    try {
      const k = storageKey(orgId, incidentId);
      const cur = safeParseJSON(localStorage.getItem(k)) || {};
      cur[String(stepKey)] = status;
      localStorage.setItem(k, JSON.stringify(cur));
    } catch {}
    // optimistic override in UI immediately by patching workflow state too
    setWorkflow(prev => {
      if (!prev?.steps) return prev;
      return {
        ...prev,
        steps: prev.steps.map(s =>
          String(s.key) === String(stepKey) ? { ...s, status } : s
        )
      };
    });
  }, [orgId, incidentId]);

  return { busy, err, workflow: merged, refresh, setLocalStatus };
}
TS
echo "✅ wrote: $COMP_DIR/useWorkflowState.ts"

# -------------------------------
# 2) WorkflowStepCard.tsx
# -------------------------------
cat > "$COMP_DIR/WorkflowStepCard.tsx" <<'TS'
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowStatus, WorkflowStep } from "./useWorkflowState";

const pill = (bg: string, fg: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  background: bg,
  color: fg,
  border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
});

const btn = (active: boolean): React.CSSProperties => ({
  padding: "7px 10px",
  borderRadius: 10,
  border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
  background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
  color: "CanvasText",
  fontWeight: 800,
  cursor: "pointer",
});

function statusMeta(s: WorkflowStatus) {
  if (s === "DONE") return { label: "DONE", bg: "color-mix(in oklab, lime 22%, transparent)", fg: "CanvasText" };
  if (s === "DOING") return { label: "DOING", bg: "color-mix(in oklab, gold 24%, transparent)", fg: "CanvasText" };
  return { label: "TODO", bg: "color-mix(in oklab, CanvasText 10%, transparent)", fg: "CanvasText" };
}

export default function WorkflowStepCard(props: {
  step: WorkflowStep;
  index: number;
  defaultOpen?: boolean;
  onSetStatus: (key: string, status: WorkflowStatus) => void;
}) {
  const { step, index, defaultOpen, onSetStatus } = props;
  const [open, setOpen] = useState(!!defaultOpen);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState<number>(0);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.scrollHeight));
    ro.observe(el);
    setH(el.scrollHeight);
    return () => ro.disconnect();
  }, []);

  const s = (step.status || "TODO") as WorkflowStatus;
  const meta = useMemo(() => statusMeta(s), [s]);

  return (
    <div
      style={{
        borderRadius: 16,
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: "transparent",
          border: "none",
          color: "CanvasText",
          cursor: "pointer",
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 950, fontSize: 15 }}>
              {index + 1}. {step.title || step.key}
            </div>
            <span style={pill(meta.bg, meta.fg)}>{meta.label}</span>
          </div>
          {!!step.hint && (
            <div style={{ opacity: 0.8, fontSize: 13, lineHeight: 1.25 }}>{step.hint}</div>
          )}
        </div>

        <div style={{ opacity: 0.7, fontWeight: 900 }}>
          {open ? "–" : "+"}
        </div>
      </button>

      <div
        style={{
          maxHeight: open ? h + 20 : 0,
          opacity: open ? 1 : 0,
          transition: "max-height 260ms ease, opacity 220ms ease",
          overflow: "hidden",
        }}
      >
        <div ref={bodyRef} style={{ padding: "0 14px 14px 14px", display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btn(s === "TODO")} onClick={() => onSetStatus(step.key, "TODO")}>TODO</button>
            <button style={btn(s === "DOING")} onClick={() => onSetStatus(step.key, "DOING")}>DOING</button>
            <button style={btn(s === "DONE")} onClick={() => onSetStatus(step.key, "DONE")}>DONE</button>
          </div>

          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Saved locally so techs don’t lose their place.
          </div>
        </div>
      </div>
    </div>
  );
}
TS
echo "✅ wrote: $COMP_DIR/WorkflowStepCard.tsx"

# -------------------------------
# 3) GuidedWorkflowPanel.tsx
# -------------------------------
cat > "$COMP_DIR/GuidedWorkflowPanel.tsx" <<'TS'
"use client";

import React, { useMemo } from "react";
import { useWorkflowState } from "./useWorkflowState";
import WorkflowStepCard from "./WorkflowStepCard";

export default function GuidedWorkflowPanel(props: {
  orgId: string;
  incidentId: string;
}) {
  const { orgId, incidentId } = props;
  const { busy, err, workflow, refresh, setLocalStatus } = useWorkflowState(orgId, incidentId);

  const steps = workflow?.steps || [];
  const pct = useMemo(() => {
    if (!steps.length) return 0;
    const done = steps.filter(s => String(s.status) === "DONE").length;
    return Math.round((done / steps.length) * 100);
  }, [steps]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontWeight: 950, letterSpacing: -0.2 }}>Guided Workflow</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {steps.length ? `${steps.length} steps · ${pct}% complete` : "No steps yet."}
          </div>
        </div>

        <button
          onClick={refresh}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            fontWeight: 900,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {!!err && (
        <div style={{
          padding: 12,
          borderRadius: 12,
          border: "1px solid color-mix(in oklab, red 28%, transparent)",
          background: "color-mix(in oklab, red 10%, transparent)",
          color: "crimson",
          fontWeight: 900,
          fontSize: 13
        }}>
          {err}
        </div>
      )}

      {steps.length ? (
        <div style={{ display: "grid", gap: 10 }}>
          {steps.map((s, idx) => (
            <WorkflowStepCard
              key={String(s.key || idx)}
              step={s}
              index={idx}
              defaultOpen={idx === 0}
              onSetStatus={(key, st) => setLocalStatus(String(key), st)}
            />
          ))}
        </div>
      ) : (
        <div style={{ padding: 12, opacity: 0.75 }}>No workflow steps.</div>
      )}
    </div>
  );
}
TS
echo "✅ wrote: $COMP_DIR/GuidedWorkflowPanel.tsx"

# -------------------------------
# 4) Patch incidents/[id]/page.tsx safely
#    - remove old stepcard blocks / WorkflowPanel duplicates
#    - ensure a single PanelCard titled Guided Workflow that renders <GuidedWorkflowPanel/>
# -------------------------------
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 0) remove obvious poison tokens from past injections
s = s.replace("'''", "").replace('"""', "")

# 1) ensure imports exist (only once)
def ensure_import(line: str):
    nonlocal_s = globals().get('s')
    if line in nonlocal_s:
        return nonlocal_s
    # insert after "use client" and first import block
    m = re.search(r'("use client";\s*\n)', nonlocal_s)
    if m:
        ins = m.end()
        return nonlocal_s[:ins] + "\n" + line + "\n" + nonlocal_s[ins:]
    # fallback: prepend
    return line + "\n" + nonlocal_s

globals()['s'] = s
s = ensure_import('import GuidedWorkflowPanel from "../_components/GuidedWorkflowPanel";')
s = globals()['s'] = s

# 2) remove old workflow stepcards block if present (common markers)
patterns = [
    r"\{\s*/\*\s*Step\s+cards\s*\(Phase\s*2\)\s*\*/[\s\S]*?\}\s*",
    r"\{\s*workflow\?\.[\s\S]*?No workflow steps\.[\s\S]*?\}\s*",
    r"/\*\s*__WF_PANEL_START__\s*\*/[\s\S]*?/\*\s*__WF_PANEL_END__\s*\*/",
]
for pat in patterns:
    s = re.sub(pat, "", s, flags=re.M)

# 3) remove any existing duplicate PanelCard title="Guided Workflow" blocks, keep the first one
#    We'll rebuild exactly one canonical block.
blocks = list(re.finditer(r'<PanelCard\s+title="Guided Workflow">[\s\S]*?</PanelCard>\s*', s))
if blocks:
    # keep the first occurrence; drop the rest
    keep = blocks[0].group(0)
    s = re.sub(r'<PanelCard\s+title="Guided Workflow">[\s\S]*?</PanelCard>\s*', "", s)
    # re-insert later (canonical)
else:
    keep = ""

canonical = """
<PanelCard title="Guided Workflow">
  <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
</PanelCard>
"""

# 4) insert canonical panel near Incident Summary (best UX) OR before final return close.
if 'title="Incident Summary"' in s:
    # insert AFTER the Incident Summary PanelCard closes
    m = re.search(r'<PanelCard\s+title="Incident Summary">[\s\S]*?</PanelCard>\s*', s)
    if m:
        ins = m.end()
        s = s[:ins] + "\n\n" + canonical + "\n" + s[ins:]
    else:
        # fallback
        tail = s.rfind("\n  );")
        s = s[:tail] + "\n\n" + canonical + "\n" + s[tail:]
else:
    tail = s.rfind("\n  );")
    s = s[:tail] + "\n\n" + canonical + "\n" + s[tail:]

# 5) sanity: remove accidental double quotes like  <PanelCard ...>">
s = s.replace('<PanelCard title="Guided Workflow">">', '<PanelCard title="Guided Workflow">')

p.write_text(s)
print("✅ incidents page patched: single GuidedWorkflowPanel inserted")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: getWorkflowV1 via Next proxy"
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 220; echo

echo "==> smoke: incident page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ incidents page still failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "✅ DONE"
echo "Open:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
