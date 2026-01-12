#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak

INC_PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
GW="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
COMP_DIR="next-app/src/app/admin/_components"

cp "$INC_PAGE" "scripts/dev/_bak/incidents_page_${TS}.tsx"
cp "$GW" "scripts/dev/_bak/GuidedWorkflowPanel_${TS}.tsx"
echo "✅ backups saved to scripts/dev/_bak/"

mkdir -p "$COMP_DIR"

if [ ! -f "$COMP_DIR/TimelinePreviewMock.tsx" ]; then
cat > "$COMP_DIR/TimelinePreviewMock.tsx" <<'TSX'
"use client";

import React from "react";

export default function TimelinePreviewMock() {
  const rows = [
    { t: "T+0", title: "Incident created", sub: "Basic incident record exists." },
    { t: "T+5m", title: "Timeline generated", sub: "Events ordered oldest → newest." },
    { t: "T+10m", title: "Filings generated", sub: "DIRS / OE-417 / NORS / SAR / BABA payloads created." },
    { t: "T+15m", title: "Packet exported", sub: "ZIP + hashes produced for audit." },
  ];

  return (
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
        Timeline Preview (mock)
      </summary>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {rows.map((r) => (
          <div
            key={r.t}
            style={{
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              borderRadius: 12,
              background: "color-mix(in oklab, CanvasText 3%, transparent)",
              padding: 10,
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontWeight: 900 }}>{r.title}</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{r.sub}</div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{r.t}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
        Saved locally so techs don’t lose their place.
      </div>
    </details>
  );
}
TSX
echo "✅ wrote: $COMP_DIR/TimelinePreviewMock.tsx"
else
echo "↪︎ TimelinePreviewMock already exists (skipping)"
fi

if [ ! -f "$COMP_DIR/FilingMetaStub.tsx" ]; then
cat > "$COMP_DIR/FilingMetaStub.tsx" <<'TSX'
"use client";

import React from "react";

export default function FilingMetaStub(props: { incident?: any }) {
  const incident = props.incident || null;
  const filingsMeta = incident?.filingsMeta || null;
  const timelineMeta = incident?.timelineMeta || null;

  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        padding: 12,
        marginTop: 10,
      }}
    >
      <div style={{ fontWeight: 950, marginBottom: 6 }}>Packet State (stub)</div>

      <div style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}>
        <div>
          <span style={{ opacity: 0.7 }}>filingsMeta:</span>{" "}
          {filingsMeta ? "✅ present" : "—"}
        </div>
        <div>
          <span style={{ opacity: 0.7 }}>timelineMeta:</span>{" "}
          {timelineMeta ? "✅ present" : "—"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          (Stub) This becomes the canonical packet readiness panel.
        </div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
          View meta JSON
        </summary>
        <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
          {JSON.stringify({ filingsMeta, timelineMeta }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
TSX
echo "✅ wrote: $COMP_DIR/FilingMetaStub.tsx"
else
echo "↪︎ FilingMetaStub already exists (skipping)"
fi

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# Add a small helper to set a status (if not already present)
if "function setStatus(" not in s:
  raise SystemExit("❌ GuidedWorkflowPanel.tsx missing setStatus() — unexpected file shape.")
needle = "setWf(workflow);"
if needle not in s:
  raise SystemExit("❌ Could not find setWf(workflow); in GuidedWorkflowPanel.tsx")

if "__AUTO_INTAKE_DONE__" not in s:
  insert = """
      // __AUTO_INTAKE_DONE__
      // Auto-complete Intake only when backend confirms a real incident object exists.
      // (Prevents inc_TEST preview mode from auto-marking done.)
      if (j?.incident) {
        const k = "intake";
        const existing = readLocal(storageKey);
        const cur = existing.get(k) if hasattr(existing, "get") else existing.get(k) if False else None
      }
"""
insert = r'''
      // __AUTO_INTAKE_DONE__
      // Auto-complete Intake only when backend confirms a real incident object exists.
      // (Prevents inc_TEST preview mode from auto-marking done.)
      if (j?.incident) {
        const k = "intake";
        const existing = readLocal(storageKey);
        const cur = existing[String(k)] || localStatus[String(k)];
        if (cur !== "DONE") {
          const next = { ...existing, ...localStatus, [String(k)]: "DONE" as const };
          setLocalStatus(next);
          writeLocal(storageKey, next);
        }
      }
'''
  s = s.replace(needle, needle + insert)

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: auto-complete intake when j.incident exists")
PY

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

def drop_import(name: str):
  global s
  s = re.sub(rf'^\s*import\s+{name}\s+from\s+["\'][^"\']+{name}["\']\s*;\s*\n', '', s, flags=re.M)

for nm in ["TimelinePreviewMock", "FilingMetaStub"]:
  drop_import(nm)

m = re.search(r'^\s*import\s+React[^\n]*\n', s, flags=re.M)
if not m:
  raise SystemExit("❌ Could not find React import line in incidents page.")

insert = (
  'import TimelinePreviewMock from "../../_components/TimelinePreviewMock";\n'
  'import FilingMetaStub from "../../_components/FilingMetaStub";\n'
)
if insert.strip() not in s:
  s = s[:m.end()] + insert + s[m.end():]

# Remove visible markers if present
s = s.replace("/*__PHASE2_EXTRAS_START__*/", "")
s = s.replace("/*__PHASE2_EXTRAS_END__*/", "")

# Dedupe existing renders
s = re.sub(r'(?:/\*__PHASE2_EXTRAS_START__\*/|__PHASE2_EXTRAS_START__)', '', s)
s = re.sub(r'(?:/\*__PHASE2_EXTRAS_END__\*/|__PHASE2_EXTRAS_END__)', '', s)

# Remove duplicate TimelinePreviewMock components (keep first)
matches = list(re.finditer(r"<TimelinePreviewMock\s*/>", s))
if len(matches) > 1:
  for mm in reversed(matches[1:]):
    s = s[:mm.start()] + "" + s[mm.end():]

# Remove duplicate FilingMetaStub components (keep first)
m2 = list(re.finditer(r"<FilingMetaStub\b[^>]*/>", s))
if len(m2) > 1:
  for mm in reversed(m2[1:]):
    s = s[:mm.start()] + "" + s[mm.end():]

# Insert (if missing) right after GuidedWorkflowPanel render
# We look for <GuidedWorkflowPanel ... /> and insert AFTER it.
if "<TimelinePreviewMock" not in s or "<FilingMetaStub" not in s:
  anchor = re.search(r"<GuidedWorkflowPanel\b[^>]*/>", s)
  if anchor:
    extra = ""
    if "<TimelinePreviewMock" not in s:
      extra += "\n      <TimelinePreviewMock />\n"
    if "<FilingMetaStub" not in s:
      # wf?.incident is safe even if wf is null (if your page uses wf state)
      extra += "      <FilingMetaStub incident={wf?.incident} />\n"
    s = s[:anchor.end()] + extra + s[anchor.end():]
  else:
    # If we can't find GuidedWorkflowPanel render, do nothing (avoid breaking)
    pass

p.write_text(s)
print("✅ patched incidents page: ensured imports + single TimelinePreviewMock + FilingMetaStub")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 140 .logs/next.log || true
  exit 1
}

echo "✅ phase2 1a+2b+3c applied"
