#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/_components"

ts="$(date +%Y%m%d_%H%M%S)"
cp "$PAGE" "$PAGE.bak_${ts}"
echo "✅ backup: $PAGE.bak_${ts}"

mkdir -p "$COMP_DIR"

# -----------------------------
# (1) BackendBadge.tsx
# -----------------------------
cat > "$COMP_DIR/BackendBadge.tsx" <<'TSX'
"use client";

import React from "react";

export default function BackendBadge(props: { ok: boolean; label?: string }) {
  const { ok, label } = props;
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: ok
          ? "color-mix(in oklab, #22c55e 18%, transparent)"
          : "color-mix(in oklab, #ef4444 18%, transparent)",
        color: "CanvasText",
        fontSize: 12,
        fontWeight: 900,
        letterSpacing: 0.2,
        userSelect: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
      title={ok ? "Backend reachable" : "Backend not reachable"}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: ok ? "#22c55e" : "#ef4444",
          display: "inline-block",
        }}
      />
      {label || (ok ? "Backend OK" : "Backend DOWN")}
    </span>
  );
}
TSX

# -----------------------------
# (2) TimelinePreviewMock.tsx
# -----------------------------
cat > "$COMP_DIR/TimelinePreviewMock.tsx" <<'TSX'
"use client";

import React, { useMemo } from "react";

type Row = { title: string; desc: string; t: string };

export default function TimelinePreviewMock() {
  const rows: Row[] = useMemo(
    () => [
      { title: "Incident created", desc: "Basic incident record exists.", t: "T+0" },
      { title: "Timeline generated", desc: "Events ordered oldest → newest.", t: "T+5m" },
      { title: "Filings generated", desc: "DIRS / OE-417 / NORS / SAR / BABA payloads created.", t: "T+10m" },
      { title: "Packet exported", desc: "ZIP + hashes produced for audit.", t: "T+15m" },
    ],
    []
  );

  return (
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.95 }}>
        Timeline Preview (mock)
      </summary>

      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
        {rows.map((r) => (
          <div
            key={r.title}
            style={{
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              borderRadius: 14,
              background: "color-mix(in oklab, CanvasText 3%, transparent)",
              padding: 12,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
            }}
          >
            <div>
              <div style={{ fontWeight: 950 }}>{r.title}</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{r.desc}</div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{r.t}</div>
          </div>
        ))}
      </div>
    </details>
  );
}
TSX

# -----------------------------
# (3) FilingMetaStub.tsx
# -----------------------------
cat > "$COMP_DIR/FilingMetaStub.tsx" <<'TSX'
"use client";

import React from "react";

export default function FilingMetaStub(props: { incident?: any }) {
  const incident = props.incident || null;
  const filingsMeta = incident?.filingsMeta ?? null;
  const timelineMeta = incident?.timelineMeta ?? null;

  return (
    <div
      style={{
        marginTop: 10,
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        padding: 12,
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

echo "✅ wrote components into $COMP_DIR"

# -----------------------------
# Patch imports in incidents page.tsx
# -----------------------------
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Remove any stale/incorrect imports for these components
s = re.sub(r'^\s*import\s+FilingMetaStub\s+from\s+["\'][^"\']+FilingMetaStub["\']\s*;\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*import\s+TimelinePreviewMock\s+from\s+["\'][^"\']+TimelinePreviewMock["\']\s*;\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*import\s+BackendBadge\s+from\s+["\'][^"\']+BackendBadge["\']\s*;\s*\n', '', s, flags=re.M)

# Insert correct imports right after the React import line
m = re.search(r'^\s*import\s+React[^\n]*\n', s, flags=re.M)
if not m:
    raise SystemExit("❌ Could not find React import to anchor inserts.")

insert = (
  'import FilingMetaStub from "../../_components/FilingMetaStub";\n'
  'import TimelinePreviewMock from "../../_components/TimelinePreviewMock";\n'
  'import BackendBadge from "../../_components/BackendBadge";\n'
)

s = s[:m.end()] + insert + s[m.end():]

p.write_text(s)
print("✅ patched incidents imports to ../../_components/*")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ INCIDENTS PAGE GREEN"
  echo "OPEN: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi
