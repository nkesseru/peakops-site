#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

echo "==> (0) backup GuidedWorkflowPanel"
PANEL="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$PANEL" "$PANEL.bak_${TS}"
echo "✅ backup: $PANEL.bak_${TS}"

echo "==> (1) write BaselinePreview.tsx (collapsible)"
cat > next-app/src/app/admin/_components/BaselinePreview.tsx <<'TSX'
"use client";

import React, { useMemo, useState } from "react";

export default function BaselinePreview(props: { orgId: string; incidentId: string; incident: any }) {
  const { orgId, incidentId, incident } = props;
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    return [
      { k: "orgId", v: orgId },
      { k: "incidentId", v: incidentId },
      { k: "incident", v: incident ? "loaded" : "null" },
    ];
  }, [orgId, incidentId, incident]);

  return (
    <div
      style={{
        marginTop: 10,
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "10px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          background: "transparent",
          color: "CanvasText",
          border: "none",
          cursor: "pointer",
        }}
      >
        <div>
          <div style={{ fontWeight: 950 }}>Baseline Fields</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {incident ? "Incident loaded" : "Preview mode (incident not wired yet)"}
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{open ? "Hide" : "Show"}</div>
      </button>

      {open && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 6, fontSize: 12 }}>
            {rows.map((r) => (
              <React.Fragment key={r.k}>
                <div style={{ opacity: 0.7 }}>{r.k}</div>
                <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{String(r.v)}</div>
              </React.Fragment>
            ))}
          </div>

          {!incident && (
            <div style={{ marginTop: 8, fontSize: 11, opacity: 0.65 }}>
              This becomes real once we wire an Incident read endpoint — UI stays stable.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
TSX
echo "✅ wrote BaselinePreview.tsx"

echo "==> (2) patch GuidedWorkflowPanel.tsx: remove per-step footer + add single footer"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# Ensure BaselinePreview import exists
if 'import BaselinePreview from "./BaselinePreview";' not in s:
  s = re.sub(
    r'(import React, \{[^}]*\} from "react";\s*\n)',
    r'\1import BaselinePreview from "./BaselinePreview";\n',
    s,
    count=1
  )

# 1) Remove the per-step footer line block
#    <div style={{ marginTop: 8 ... }}>Saved locally ...</div>
s = re.sub(
  r'\n\s*<div style=\{\{\s*marginTop:\s*8,\s*fontSize:\s*11,\s*opacity:\s*0\.7\s*\}\}>\s*Saved locally so techs don[’\']t lose their place\.\s*</div>\s*\n',
  '\n',
  s
)

# 2) Ensure BaselinePreview injection exists and pass incident from response if available.
# We'll add a lightweight incident extraction.
# Find where workflow is set from JSON; we can also capture incident.
if "const incident =" not in s:
  # After 'const workflow: Workflow = j?.workflow || {};'
  s = s.replace(
    "const workflow: Workflow = j?.workflow || {};",
    "const workflow: Workflow = j?.workflow || {};\n      const incident = j?.incident ?? null;"
  )

# Add incident state if not present
if "const [incident," not in s:
  # Put after wf state
  s = s.replace(
    "const [wf, setWf] = useState<Workflow | null>(null);",
    "const [wf, setWf] = useState<Workflow | null>(null);\n  const [incident, setIncident] = useState<any>(null);"
  )

# After setWf(workflow); also setIncident(incident);
if "setIncident(" not in s:
  s = s.replace("setWf(workflow);", "setWf(workflow);\n      setIncident(incident);")

# Ensure BaselinePreview is rendered in intake step block
if "BaselinePreview orgId" not in s:
  anchor = r'\{s\.hint && <div style=\{\{ marginTop: 6, fontSize: 12, opacity: 0\.85 \}\}>\{s\.hint\}</div>\}\s*'
  m = re.search(anchor, s)
  if not m:
    raise SystemExit("❌ Could not find hint anchor in GuidedWorkflowPanel.tsx")
  inject = '''
                {String(s.key) === "intake" && (
                  <BaselinePreview orgId={orgId} incidentId={incidentId} incident={incident} />
                )}
'''
  s = s[:m.end()] + "\n" + inject + s[m.end():]

# 3) Add single footer line once at the bottom of the panel, just before closing </div> of root
# Find the last occurrence of '</div>\n  );\n}' in this component and insert footer above it.
if "Saved locally so techs don’t lose their place." not in s:
  footer = '''
      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.7 }}>
        Saved locally so techs don’t lose their place.
      </div>
'''
  # Insert before the final closing of the root card div (the one that closes the return)
  # We'll insert before the last '\n    </div>\n  );'
  idx = s.rfind("\n    </div>\n  );")
  if idx == -1:
    raise SystemExit("❌ Could not find return closing anchor to insert footer.")
  s = s[:idx] + footer + s[idx:]

p.write_text(s)
print("✅ patched GuidedWorkflowPanel.tsx (collapse + single footer)")
PY

echo "==> (3) restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (4) smoke incidents page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
curl -fsS "$URL" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ incidents failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  $URL"
