#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

# ----------------------------
# (0) Paths
# ----------------------------
INC_PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/_components"
WF_CARD="$COMP_DIR/WorkflowStepCard.tsx"
WF_PANEL="$COMP_DIR/GuidedWorkflowPanel.tsx"

mkdir -p scripts/dev/_bak "$COMP_DIR" .logs

ts="$(date +%Y%m%d_%H%M%S)"
cp "$INC_PAGE" "scripts/dev/_bak/incidents_id_page.${ts}.bak"
echo "✅ backup: scripts/dev/_bak/incidents_id_page.${ts}.bak"

# ----------------------------
# (1) Write WorkflowStepCard (animated expand/collapse)
# ----------------------------
cat > "$WF_CARD" <<'TSX'
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type StepStatus = "TODO" | "DOING" | "DONE" | string;

export default function WorkflowStepCard(props: {
  step: any;
  index?: number;
  defaultOpen?: boolean;
  statusOverride?: StepStatus;
  onSetStatus?: (key: string, next: StepStatus) => void;
}) {
  const { step, defaultOpen, statusOverride, onSetStatus } = props;
  const key = String(step?.key ?? props.index ?? "");
  const title = String(step?.title ?? step?.key ?? "Step");
  const hint = String(step?.hint ?? "");
  const rawStatus = String(statusOverride ?? step?.status ?? "TODO");
  const status: StepStatus = rawStatus as any;

  const [open, setOpen] = useState(!!defaultOpen);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxH, setMaxH] = useState<number>(0);

  const badge = useMemo(() => {
    const base: React.CSSProperties = {
      fontSize: 11,
      fontWeight: 900,
      padding: "4px 10px",
      borderRadius: 999,
      border: "1px solid color-mix(in oklab, CanvasText 16%, transparent)",
      background: "color-mix(in oklab, CanvasText 6%, transparent)",
      opacity: 0.92,
      letterSpacing: 0.2,
    };

    if (status === "DONE") return { ...base, background: "color-mix(in oklab, lime 22%, transparent)", border: "1px solid color-mix(in oklab, lime 35%, transparent)" };
    if (status === "DOING") return { ...base, background: "color-mix(in oklab, gold 22%, transparent)", border: "1px solid color-mix(in oklab, gold 35%, transparent)" };
    return base;
  }, [status]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const measure = () => {
      const h = el.scrollHeight || 0;
      setMaxH(open ? h : 0);
    };

    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const cycle = () => {
    const next: StepStatus = status === "TODO" ? "DOING" : status === "DOING" ? "DONE" : "TODO";
    onSetStatus?.(key, next);
  };

  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: 14,
          background: "transparent",
          border: "none",
          color: "CanvasText",
          cursor: "pointer",
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 950 }}>{title}</div>
            <span style={badge}>{String(status)}</span>
          </div>
          {hint ? <div style={{ fontSize: 12, opacity: 0.75 }}>{hint}</div> : null}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); cycle(); }}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              fontWeight: 800,
              fontSize: 12,
              cursor: "pointer",
            }}
            title="Cycle status (TODO → DOING → DONE)"
          >
            Toggle
          </button>

          <div style={{ fontSize: 12, opacity: 0.7 }}>{open ? "Hide" : "Show"}</div>
        </div>
      </button>

      <div
        style={{
          maxHeight: maxH,
          transition: "max-height 220ms ease",
          overflow: "hidden",
          borderTop: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        }}
      >
        <div ref={innerRef} style={{ padding: 14, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            {/* Placeholder “details” area you can enrich later */}
            Key: <b>{key}</b>
          </div>

          {step?.details ? (
            <pre style={{ margin: 0, fontSize: 12, opacity: 0.9, whiteSpace: "pre-wrap" }}>
              {typeof step.details === "string" ? step.details : JSON.stringify(step.details, null, 2)}
            </pre>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              No details yet — we’ll wire actions here next (Generate Timeline / Generate Filings / Export Packet).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
TSX

echo "✅ wrote $WF_CARD"

# ----------------------------
# (2) Write GuidedWorkflowPanel (optimistic + localStorage)
# ----------------------------
cat > "$WF_PANEL" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import WorkflowStepCard from "./WorkflowStepCard";

type StepStatus = "TODO" | "DOING" | "DONE" | string;

function safeJson(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const storeKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [workflow, setWorkflow] = useState<any>(null);
  const [localMap, setLocalMap] = useState<Record<string, StepStatus>>({});

  function loadLocal() {
    try {
      const raw = localStorage.getItem(storeKey);
      if (!raw) return {};
      const j = JSON.parse(raw);
      return (j && typeof j === "object") ? j : {};
    } catch {
      return {};
    }
  }

  function saveLocal(m: Record<string, StepStatus>) {
    try {
      localStorage.setItem(storeKey, JSON.stringify(m));
    } catch {}
  }

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(
        `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
        { method: "GET" }
      );
      const text = await r.text();
      if (!text || !text.trim()) {
        setWorkflow(null);
        setErr(`Workflow API empty (HTTP ${r.status})`);
        return;
      }
      const parsed = safeJson(text);
      if (!parsed.ok) {
        setWorkflow(null);
        setErr(`Workflow API non-JSON (HTTP ${r.status}): ${parsed.error}`);
        return;
      }
      const j = parsed.value;
      if (j?.ok === false) {
        setWorkflow(null);
        setErr(String(j?.error || "getWorkflowV1 failed"));
        return;
      }
      setWorkflow(j?.workflow || j);
    } catch (e: any) {
      setWorkflow(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const m = loadLocal();
    setLocalMap(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  const steps = workflow?.steps || [];

  const onSetStatus = (key: string, next: StepStatus) => {
    // optimistic local update
    setLocalMap((prev) => {
      const m = { ...(prev || {}) };
      m[key] = next;
      saveLocal(m);
      return m;
    });

    // also reflect in UI list
    setWorkflow((w: any) => {
      if (!w?.steps) return w;
      return {
        ...w,
        steps: w.steps.map((s: any) => String(s?.key) === String(key) ? { ...s, status: next } : s),
      };
    });
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 950 }}>Guided Workflow</div>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "7px 12px",
            borderRadius: 999,
            border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            fontWeight: 800,
            fontSize: 12,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err ? <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div> : null}

      {steps?.length ? (
        <div style={{ display: "grid", gap: 10 }}>
          {steps.map((step: any, idx: number) => {
            const k = String(step?.key ?? idx);
            const override = localMap[k];
            return (
              <WorkflowStepCard
                key={k}
                step={step}
                index={idx}
                defaultOpen={idx === 0}
                statusOverride={override}
                onSetStatus={onSetStatus}
              />
            );
          })}
        </div>
      ) : (
        <div style={{ opacity: 0.75, fontSize: 12 }}>No workflow steps yet.</div>
      )}
    </div>
  );
}
TSX

echo "✅ wrote $WF_PANEL"

# ----------------------------
# (3) Fix incidents page: remove stray Guided Workflow blocks + insert clean PanelCard INSIDE return
# ----------------------------
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Ensure imports exist
if 'GuidedWorkflowPanel' not in s:
    # insert after other _components imports if possible
    m = re.search(r'(from\s+"../../_components/[^"]+"\s*;\s*\n)+', s)
    if m:
        s = s[:m.end()] + 'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\n' + s[m.end():]
    else:
        # fallback: after react import
        m2 = re.search(r'import\s+React[^\n]*\n', s)
        if m2:
            s = s[:m2.end()] + 'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\n' + s[m2.end():]

# Remove any stray PanelCard blocks that contain GuidedWorkflowPanel (often injected outside return)
s = re.sub(
    r'\n\s*<PanelCard\s+title="Guided Workflow">[\s\S]*?</PanelCard>\s*\n',
    "\n",
    s,
    flags=re.M
)

# Now insert inside return: right BEFORE the closing of the main content grid
# We look for the big grid close: first occurrence of "\n      </div>\n    </div>\n\n  );"
anchor = re.search(r'\n\s*</div>\s*\n\s*</div>\s*\n\s*\n\s*\);\s*\n', s)
if not anchor:
    # fallback: insert before "\n  );"
    anchor = re.search(r'\n\s*\);\s*\n', s)
if not anchor:
    raise SystemExit("Could not find return close to insert Guided Workflow PanelCard")

panel = r'''
        <PanelCard title="Guided Workflow">
          <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
        </PanelCard>
'''

insert_at = anchor.start()
s = s[:insert_at] + panel + s[insert_at:]

# Save
p.write_text(s)
print("✅ patched incidents page: inserted Guided Workflow PanelCard inside return")
PY

# ----------------------------
# (4) Restart Next + smoke
# ----------------------------
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null; then
  echo "✅ incidents page compiles + loads"
else
  echo "❌ still failing; FIRST parser error:"
  awk '/Parsing ecmascript source code failed/{p=1} p{print} /Unexpected token/{exit}' .logs/next.log | head -n 80
  echo
  echo "---- tail of incidents page ----"
  # bash-safe (no glob)
  set -f
  nl -ba next-app/src/app/admin/incidents/\[id\]/page.tsx | tail -n 80 || true
  set +f
  exit 1
fi

echo
echo "✅ DONE"
echo "Open:"
echo "  $URL"
