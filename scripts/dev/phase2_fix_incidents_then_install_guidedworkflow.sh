#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

INC_FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

echo "==> (0) Restore incidents page from most recent backup (or git) to get back to GREEN"
ts="$(date +%Y%m%d_%H%M%S)"

mkdir -p scripts/dev/_bak_incidents

# 0a) If we have a backup sitting next to the file, use the newest one
LATEST_SIDE_BAK="$(ls -1t "${INC_FILE}.bak_"* 2>/dev/null | head -n 1 || true)"

if [ -n "${LATEST_SIDE_BAK}" ]; then
  cp "${INC_FILE}" "scripts/dev/_bak_incidents/page.tsx.pre_restore.${ts}.tsx"
  cp "${LATEST_SIDE_BAK}" "${INC_FILE}"
  echo "✅ restored from side backup: ${LATEST_SIDE_BAK}"
else
  # 0b) Else try git restore (only works if file is tracked)
  if git ls-files --error-unmatch "${INC_FILE}" >/dev/null 2>&1; then
    cp "${INC_FILE}" "scripts/dev/_bak_incidents/page.tsx.pre_restore.${ts}.tsx" || true
    git checkout -- "${INC_FILE}"
    echo "✅ restored via git checkout -- ${INC_FILE}"
  else
    echo "❌ No side backup found and file not tracked by git."
    echo "   Run: ls -1t scripts/dev/_bak/*incidents* | head"
    exit 1
  fi
fi

echo "==> (1) Ensure GuidedWorkflowPanel component exists (clean, standalone)"
GW_COMP="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
mkdir -p "$(dirname "$GW_COMP")"

cat > "$GW_COMP" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";

type StepStatus = "TODO" | "DOING" | "DONE";
type Step = { key: string; title: string; hint?: string; status?: StepStatus };

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 4%, transparent)",
    fontSize: 12,
    fontWeight: 800,
    opacity: active ? 1 : 0.85,
    cursor: "pointer",
    userSelect: "none",
  };
}

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    overflow: "hidden",
  };
}

function row(): React.CSSProperties {
  return { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 12px" };
}

function tiny(): React.CSSProperties {
  return { fontSize: 12, opacity: 0.8 };
}

function usePersistKey(orgId: string, incidentId: string) {
  return useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);
}

function safeRead(key: string): Record<string, StepStatus> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function safeWrite(key: string, m: Record<string, StepStatus>) {
  try {
    localStorage.setItem(key, JSON.stringify(m));
  } catch {}
}

export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;
  const persistKey = usePersistKey(orgId, incidentId);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [openKey, setOpenKey] = useState<string>("");

  // Local optimistic overrides (persisted)
  const [override, setOverride] = useState<Record<string, StepStatus>>({});

  useEffect(() => {
    setOverride(safeRead(persistKey));
  }, [persistKey]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url = `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url, { method: "GET" });
      const txt = await r.text();
      if (!txt.trim()) throw new Error(`Workflow API empty (HTTP ${r.status})`);
      const j = JSON.parse(txt);
      if (j.ok === false) throw new Error(String(j.error || "getWorkflowV1 failed"));
      const serverSteps: Step[] = Array.isArray(j.workflow?.steps) ? j.workflow.steps : [];
      // merge persisted statuses
      const merged = serverSteps.map(s => ({ ...s, status: override[String(s.key)] || (s.status as StepStatus) || "TODO" }));
      setSteps(merged);
      if (!openKey && merged[0]?.key) setOpenKey(String(merged[0].key));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  function setStatus(k: string, st: StepStatus) {
    const key = String(k);
    const next = { ...override, [key]: st };
    setOverride(next);
    safeWrite(persistKey, next);

    setSteps(prev => prev.map(s => String(s.key) === key ? { ...s, status: st } : s));
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ fontWeight: 950 }}>Guided Workflow</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {busy ? <div style={tiny()}>Loading…</div> : null}
          <button onClick={load} style={pill(false)} disabled={busy}>Refresh</button>
        </div>
      </div>

      {err ? (
        <div style={{ color: "crimson", fontWeight: 800, fontSize: 12 }}>{err}</div>
      ) : null}

      {steps.length === 0 ? (
        <div style={{ opacity: 0.75, fontSize: 12 }}>No workflow steps.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {steps.map((s) => {
            const k = String(s.key);
            const isOpen = openKey === k;
            const st = (s.status || "TODO") as StepStatus;

            return (
              <div key={k} style={card()}>
                <div style={row()} onClick={() => setOpenKey(isOpen ? "" : k)}>
                  <div style={{ display: "grid" }}>
                    <div style={{ fontWeight: 900 }}>{s.title}</div>
                    {s.hint ? <div style={tiny()}>{s.hint}</div> : null}
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <div style={pill(st === "TODO")} onClick={(e) => { e.stopPropagation(); setStatus(k, "TODO"); }}>TODO</div>
                    <div style={pill(st === "DOING")} onClick={(e) => { e.stopPropagation(); setStatus(k, "DOING"); }}>DOING</div>
                    <div style={pill(st === "DONE")} onClick={(e) => { e.stopPropagation(); setStatus(k, "DONE"); }}>DONE</div>
                  </div>
                </div>

                <div
                  style={{
                    maxHeight: isOpen ? 140 : 0,
                    transition: "max-height 200ms ease",
                    overflow: "hidden",
                    borderTop: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
                    background: "color-mix(in oklab, CanvasText 2%, transparent)",
                  }}
                >
                  <div style={{ padding: "10px 12px", fontSize: 12, opacity: 0.9 }}>
                    {s.hint || "—"}
                    <div style={{ marginTop: 8, opacity: 0.8 }}>
                      Persisted locally for this incident (so techs don’t lose their place).
                    </div>
                  </div>
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

echo "✅ wrote: $GW_COMP"

echo "==> (2) Patch incidents page to include GuidedWorkflowPanel ONCE (marker-based, safe)"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Ensure import exists
if "GuidedWorkflowPanel" not in s:
  # Put near other imports (after React import if possible)
  m = re.search(r'^(import\s+React[^\n]*\n)', s, re.M)
  ins = 'import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";\n'
  if m:
    s = s[:m.end()] + ins + s[m.end():]
  else:
    s = ins + s

START = "/*__GUIDED_WORKFLOW_START__*/"
END   = "/*__GUIDED_WORKFLOW_END__*/"

block = f"""
{START}
<PanelCard title="Guided Workflow">
  <GuidedWorkflowPanel orgId={{orgId}} incidentId={{incidentId}} />
</PanelCard>
{END}
"""

# Remove any old guided workflow blocks/panels we previously injected (defensive)
s = re.sub(r"/\*__GUIDED_WORKFLOW_START__\*/[\s\S]*?/\*__GUIDED_WORKFLOW_END__\*/", "", s)

# Insert after "Incident Summary" panel if present, else before final return close.
anchor = re.search(r'<PanelCard\s+title="Incident Summary">[\s\S]*?</PanelCard>\s*', s)
if anchor and START not in s:
  insert_at = anchor.end()
  s = s[:insert_at] + "\n" + block + "\n" + s[insert_at:]
else:
  # fallback: before the last "return ("
  m2 = s.rfind("return (")
  if m2 != -1 and START not in s:
    # insert shortly after return (
    insert_at = s.find("\n", m2)
    s = s[:insert_at+1] + block + "\n" + s[insert_at+1:]

p.write_text(s)
print("✅ incidents page patched with GuidedWorkflowPanel (single, clean block)")
PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (4) Smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads (guided workflow installed)" \
  || { echo "❌ still failing — tail next.log"; tail -n 140 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
