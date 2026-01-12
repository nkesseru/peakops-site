#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

INC_PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/_components"
STEP="$COMP_DIR/WorkflowStepCard.tsx"
PANEL="$COMP_DIR/GuidedWorkflowPanel.tsx"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak "$COMP_DIR"

echo "==> backup incidents page"
cp "$INC_PAGE" "scripts/dev/_bak/incidents_id_page_${ts}.tsx"

echo "==> write WorkflowStepCard"
cat > "$STEP" <<'TSX'
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export type WFStatus = "TODO" | "DOING" | "DONE";

export type WFStep = {
  key: string;
  title: string;
  hint?: string;
  status?: WFStatus;
  actions?: Array<{ id: string; label: string }>;
};

function pill(status: WFStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 900,
    padding: "5px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    letterSpacing: 0.3,
  };
  if (status === "DOING") return { ...base, background: "color-mix(in oklab, gold 20%, transparent)" };
  if (status === "DONE") return { ...base, background: "color-mix(in oklab, lime 16%, transparent)" };
  return base;
}

function btn(primary?: boolean): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: primary
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "color-mix(in oklab, CanvasText 5%, transparent)",
    color: "CanvasText",
    fontWeight: 800,
    cursor: "pointer",
  };
}

export default function WorkflowStepCard(props: {
  step: WFStep;
  index: number;
  status: WFStatus;
  isOpen: boolean;
  onToggle: () => void;
  onSetStatus: (s: WFStatus) => void;
}) {
  const { step, index, status, isOpen, onToggle, onSetStatus } = props;

  const innerRef = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState<number>(0);

  // Measure content height for smooth expand/collapse
  useEffect(() => {
    if (!innerRef.current) return;
    const el = innerRef.current;

    const measure = () => setH(el.scrollHeight || 0);
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const headerStyle: React.CSSProperties = useMemo(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "12px 14px",
      borderRadius: 14,
      border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
      background: "color-mix(in oklab, CanvasText 3%, transparent)",
      cursor: "pointer",
      userSelect: "none",
    }),
    []
  );

  const bodyWrapStyle: React.CSSProperties = useMemo(
    () => ({
      overflow: "hidden",
      maxHeight: isOpen ? h + 24 : 0,
      transition: "max-height 220ms ease",
      borderRadius: 14,
      border: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
      background: "color-mix(in oklab, CanvasText 2%, transparent)",
      marginTop: 10,
    }),
    [isOpen, h]
  );

  const contentStyle: React.CSSProperties = useMemo(
    () => ({
      padding: 14,
      display: "grid",
      gap: 10,
    }),
    []
  );

  return (
    <div>
      <div style={headerStyle} onClick={onToggle} role="button" aria-expanded={isOpen}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.75, width: 26 }}>{index + 1}.</div>
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <div style={{ fontWeight: 950, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {step.title}
            </div>
            {step.hint ? <div style={{ fontSize: 12, opacity: 0.75 }}>{step.hint}</div> : null}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={pill(status)}>{status}</span>
          <span style={{ fontSize: 18, opacity: 0.7, transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 160ms ease" }}>
            ›
          </span>
        </div>
      </div>

      <div style={bodyWrapStyle}>
        <div ref={innerRef} style={contentStyle}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={btn()} onClick={() => onSetStatus("TODO")}>TODO</button>
            <button style={btn()} onClick={() => onSetStatus("DOING")}>DOING</button>
            <button style={btn(true)} onClick={() => onSetStatus("DONE")}>DONE</button>
          </div>

          {step.actions?.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 900, opacity: 0.85 }}>Actions</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {step.actions.map(a => (
                  <button key={a.id} style={btn()} onClick={() => { /* wire later */ }}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
TSX

echo "==> write GuidedWorkflowPanel"
cat > "$PANEL" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import WorkflowStepCard, { WFStatus, WFStep } from "./WorkflowStepCard";

type WorkflowResp = {
  ok: boolean;
  orgId: string;
  incidentId: string;
  workflow?: { version?: string; steps?: Array<{ key: string; title: string; hint?: string; status?: WFStatus }> };
  error?: string;
};

function panel(title: string): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 16,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 2%, transparent)",
  };
}

function rowMeta(label: string, value: string): React.CSSProperties {
  return { display: "flex", gap: 8, fontSize: 12, opacity: 0.85 };
}

function storageKey(orgId: string, incidentId: string) {
  return `wf:${orgId}:${incidentId}`;
}

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [steps, setSteps] = useState<WFStep[]>([]);
  const [openKey, setOpenKey] = useState<string>("");

  const [localStatus, setLocalStatus] = useState<Record<string, WFStatus>>({});

  // load local status
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(orgId, incidentId));
      const m = raw ? JSON.parse(raw) : {};
      setLocalStatus(m || {});
    } catch {
      setLocalStatus({});
    }
  }, [orgId, incidentId]);

  // persist local status
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(orgId, incidentId), JSON.stringify(localStatus || {}));
    } catch {}
  }, [orgId, incidentId, localStatus]);

  const mergedSteps = useMemo(() => {
    return (steps || []).map(s => ({
      ...s,
      status: localStatus[String(s.key)] || s.status || "TODO",
    }));
  }, [steps, localStatus]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url = `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url);
      const text = await r.text();
      if (!text || !text.trim()) throw new Error(`Workflow API empty (HTTP ${r.status})`);
      const j: WorkflowResp = JSON.parse(text);

      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");

      const apiSteps = j.workflow?.steps || [];
      const mapped: WFStep[] = apiSteps.map((x) => ({
        key: String(x.key),
        title: String(x.title || x.key),
        hint: x.hint ? String(x.hint) : "",
        status: (x.status as WFStatus) || "TODO",
        actions: [],
      }));

      setSteps(mapped);

      if (!openKey && mapped.length) setOpenKey(String(mapped[0].key));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  function setStatus(stepKey: string, status: WFStatus) {
    setLocalStatus(prev => ({ ...(prev || {}), [String(stepKey)]: status }));
  }

  return (
    <div style={panel("Guided Workflow")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 950 }}>Guided Workflow</div>
          <div style={rowMeta("org", orgId)}>
            <span><b>org:</b> {orgId}</span>
            <span>·</span>
            <span><b>incident:</b> {incidentId}</span>
          </div>
        </div>

        <button
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            color: "CanvasText",
            fontWeight: 900,
            cursor: "pointer"
          }}
          onClick={load}
          disabled={busy}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err ? (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        {mergedSteps.length ? mergedSteps.map((s, idx) => (
          <WorkflowStepCard
            key={String(s.key)}
            step={s}
            index={idx}
            status={(s.status as WFStatus) || "TODO"}
            isOpen={openKey === String(s.key)}
            onToggle={() => setOpenKey(openKey === String(s.key) ? "" : String(s.key))}
            onSetStatus={(st) => setStatus(String(s.key), st)}
          />
        )) : (
          <div style={{ padding: 10, opacity: 0.75 }}>No workflow steps.</div>
        )}
      </div>
    </div>
  );
}
TSX

echo "==> patch incidents page (safe marker insert)"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Ensure import exists
imp = 'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\n'
if "GuidedWorkflowPanel" not in s:
  # insert after first import block
  m = re.search(r'(import[^\n]*\n)+', s)
  if m:
    s = s[:m.end()] + imp + s[m.end()]
  else:
    s = imp + s

START = "{/*__GUIDED_WF_START__*/}"
END   = "{/*__GUIDED_WF_END__*/}"

block = f"""
      {START}
      <GuidedWorkflowPanel orgId={{orgId}} incidentId={{incidentId}} />
      {END}
"""

# If markers exist, replace inner content
if START in s and END in s:
  s = re.sub(re.escape(START) + r"[\s\S]*?" + re.escape(END), START + "\n      <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />\n      " + END, s)
else:
  # Insert after a header that contains "Guided Workflow" if present
  anchor = re.search(r'Guided Workflow', s)
  if anchor:
    # insert right AFTER the line containing that text, at the next newline
    nl = s.find("\n", anchor.start())
    if nl != -1:
      s = s[:nl+1] + block + s[nl+1:]
    else:
      s += "\n" + block + "\n"
  else:
    # fallback: insert near top of return body by finding first "<PanelCard" occurrence
    m2 = re.search(r'<PanelCard[^>]*>', s)
    if m2:
      s = s[:m2.start()] + block + "\n" + s[m2.start():]
    else:
      s += "\n" + block + "\n"

p.write_text(s)
print("✅ patched incidents page with GuidedWorkflowPanel markers")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke compile"
curl -fsSI "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 5
echo
echo "✅ Phase 2 GuidedWorkflowPanel installed."
echo "Open:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
