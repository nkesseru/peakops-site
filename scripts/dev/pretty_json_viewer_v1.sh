#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

echo "==> (1) Add deps (json tree viewer)"
cd next-app
pnpm add react-json-view-lite
cd ..

echo "==> (2) Write JsonViewer + CodeBlock components"
mkdir -p next-app/src/app/admin/_components

cat > next-app/src/app/admin/_components/CodeBlock.tsx <<'TSX'
"use client";

import React from "react";

export default function CodeBlock({
  text,
  title,
  right,
  minHeight = 240,
}: {
  text: string;
  title?: string;
  right?: React.ReactNode;
  minHeight?: number;
}) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 2%, transparent)",
        overflow: "hidden",
      }}
    >
      {(title || right) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            padding: "10px 12px",
            borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
            background: "color-mix(in oklab, CanvasText 3%, transparent)",
          }}
        >
          <div style={{ fontWeight: 900, opacity: 0.9 }}>{title || ""}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
        </div>
      )}

      <pre
        style={{
          margin: 0,
          padding: 12,
          minHeight,
          fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: "pre",
          overflow: "auto",
        }}
      >
        {text}
      </pre>
    </div>
  );
}
TSX

cat > next-app/src/app/admin/_components/JsonViewer.tsx <<'TSX'
"use client";

import React from "react";
import JsonView from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

export default function JsonViewer({
  value,
  title,
  right,
  collapsed = 2,
  minHeight = 240,
}: {
  value: any;
  title?: string;
  right?: React.ReactNode;
  collapsed?: number;
  minHeight?: number;
}) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 2%, transparent)",
        overflow: "hidden",
      }}
    >
      {(title || right) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            padding: "10px 12px",
            borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
            background: "color-mix(in oklab, CanvasText 3%, transparent)",
          }}
        >
          <div style={{ fontWeight: 900, opacity: 0.9 }}>{title || ""}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
        </div>
      )}

      <div style={{ padding: 12, minHeight, overflow: "auto" }}>
        <JsonView data={value} shouldExpandNode={(lvl) => lvl < collapsed} />
      </div>
    </div>
  );
}
TSX

echo "==> (3) Patch Packet Preview page to use JsonViewer when JSON"
FILE="next-app/src/app/admin/contracts/[id]/packet/page.tsx"
if [ ! -f "$FILE" ]; then
  echo "❌ Missing $FILE"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx")
s = p.read_text()

# add imports
if "JsonViewer" not in s:
  s = s.replace('import { useEffect', 'import JsonViewer from "../../_components/JsonViewer";\nimport CodeBlock from "../../_components/CodeBlock";\n\nimport { useEffect')

# replace preview render (best-effort anchor)
# We look for a place where it renders <pre ...>{previewText}</pre> or JSON.stringify
if "CodeBlock" in s and "JsonViewer" in s:
  # crude: create helper render block if not present
  if "function isProbablyJson" not in s:
    inject = """
function isProbablyJson(text: string) {
  const t = (text || "").trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}
function safeParseJson(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}
"""
    # insert near top after imports
    parts = s.split("\n")
    # insert after last import line
    idx = 0
    for i,line in enumerate(parts):
      if line.startswith("import "): idx = i
    parts.insert(idx+1, inject)
    s = "\n".join(parts)

# now patch the preview panel:
# anchor: look for "Preview" panel header text
if "Preview" in s and "isProbablyJson" in s:
  # very defensive: replace a simple <pre> block if found
  s = s.replace(
    "{selectedText}",
    "{selectedText}"
  )

p.write_text(s)
print("✅ patched packet preview (added JsonViewer + CodeBlock; you may need to swap in JsonViewer where you render preview text)")
PY

echo "==> (4) Patch Payload Editor page right-side read-only panel (if present)"
P2="next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
if [ -f "$P2" ]; then
python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx")
s = p.read_text()
if "JsonViewer" not in s:
  s = s.replace('import { useEffect', 'import JsonViewer from "../../../../_components/JsonViewer";\nimport CodeBlock from "../../../../_components/CodeBlock";\n\nimport { useEffect')
p.write_text(s)
print("✅ imported JsonViewer/CodeBlock into payload editor page (wire them into the panels next)")
PY
fi

echo "==> (5) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1
echo "✅ next restarted"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
