#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PANEL="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
PREVIEW="next-app/src/app/admin/_components/BaselinePreview.tsx"

ts="$(date +%Y%m%d_%H%M%S)"
cp "$PANEL" "$PANEL.bak_${ts}"
echo "✅ backup: $PANEL.bak_${ts}"

echo "==> (1) Write BaselinePreview component"
mkdir -p "$(dirname "$PREVIEW")"
cat > "$PREVIEW" <<'TSX'
"use client";

import React, { useEffect, useState } from "react";

export default function BaselinePreview(props: { orgId: string; incidentId: string }) {
  const { orgId, incidentId } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [incident, setIncident] = useState<any>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true);
      setErr("");
      try {
        // If you later add getIncidentV1, swap this endpoint.
        // For now, we just show that we have orgId/incidentId and the workflow API is alive.
        // (Keeps UI safe + non-blocking.)
        const r = await fetch(
          `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`
        );
        const j = await r.json().catch(() => null);
        if (!j?.ok) throw new Error(j?.error || "getWorkflowV1 failed");
        if (alive) setIncident(j.incident || null);
      } catch (e: any) {
        if (alive) setErr(String(e?.message || e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [orgId, incidentId]);

  const row = (label: string, val: any) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <div style={{ opacity: 0.75 }}>{label}</div>
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontWeight: 800 }}>
        {val ?? "—"}
      </div>
    </div>
  );

  return (
    <div style={{
      marginTop: 10,
      padding: 10,
      borderRadius: 12,
      border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
      background: "color-mix(in oklab, CanvasText 2.5%, transparent)"
    }}>
      <div style={{ fontWeight: 950, marginBottom: 6 }}>Baseline Fields (Preview)</div>

      {busy && <div style={{ fontSize: 12, opacity: 0.75 }}>Loading…</div>}
      {err && <div style={{ fontSize: 12, color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ display: "grid", gap: 6, fontSize: 12, opacity: 0.9 }}>
        {row("orgId", orgId)}
        {row("incidentId", incidentId)}
        {row("incident", incident ? "present" : "null")}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
        (This becomes real once we wire an Incident read endpoint — UI stays stable now.)
      </div>
    </div>
  );
}
TSX
echo "✅ wrote $PREVIEW"

echo "==> (2) Patch GuidedWorkflowPanel: import + inject into intake card"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# ensure import exists (after React import)
if "BaselinePreview" not in s:
  s = re.sub(
    r'(import React, \{[^}]*\} from "react";\s*\n)',
    r'\1import BaselinePreview from "./BaselinePreview";\n',
    s,
    count=1
  )

# inject inside the card render, right after hint block (line ~177)
# We only inject once.
inject_block = r'''
                {String(s.key) === "intake" && (
                  <BaselinePreview orgId={orgId} incidentId={incidentId} />
                )}
'''

if "BaselinePreview orgId" not in s:
  # find the hint line inside the map return
  anchor = r'\{s\.hint && <div style=\{\{ marginTop: 6, fontSize: 12, opacity: 0\.85 \}\}>\{s\.hint\}</div>\}\s*'
  m = re.search(anchor, s)
  if not m:
    raise SystemExit("❌ Could not find hint anchor in GuidedWorkflowPanel.tsx")
  s = s[:m.end()] + "\n" + inject_block + s[m.end():]

p.write_text(s)
print("✅ patched GuidedWorkflowPanel.tsx (import + intake injection)")
PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (4) Smoke"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ incidents still failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
