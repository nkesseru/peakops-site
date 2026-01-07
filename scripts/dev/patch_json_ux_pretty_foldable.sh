#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app

echo "==> (1) Create JsonViewer component"
mkdir -p next-app/src/app/admin/_components
cat > next-app/src/app/admin/_components/JsonViewer.tsx <<'TSX'
"use client";

import React, { useMemo, useState } from "react";

type Json = any;

function isObject(x: any) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function tokenColor(val: any) {
  if (val === null) return "color-mix(in oklab, CanvasText 55%, transparent)";
  if (typeof val === "string") return "color-mix(in oklab, #6ee7b7 65%, CanvasText)"; // mint
  if (typeof val === "number") return "color-mix(in oklab, #60a5fa 70%, CanvasText)"; // blue
  if (typeof val === "boolean") return "color-mix(in oklab, #f59e0b 70%, CanvasText)"; // amber
  return "CanvasText";
}

function pretty(v: any) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function copyText(s: string) {
  navigator.clipboard?.writeText(s).catch(() => {});
}

function NodeRow({
  k,
  v,
  depth,
  defaultExpandDepth,
}: {
  k: string | null;
  v: any;
  depth: number;
  defaultExpandDepth: number;
}) {
  const [open, setOpen] = useState(depth < defaultExpandDepth);

  const pad = depth * 14;

  const isArr = Array.isArray(v);
  const isObj = isObject(v);
  const isColl = isArr || isObj;

  const headLabel = isArr ? `Array(${v.length})` : isObj ? `Object(${Object.keys(v).length})` : null;

  return (
    <div style={{ marginLeft: pad, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        {isColl ? (
          <button
            onClick={() => setOpen(!open)}
            style={{
              width: 18,
              height: 18,
              borderRadius: 6,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              cursor: "pointer",
              padding: 0,
              display: "grid",
              placeItems: "center",
              opacity: 0.85,
            }}
            title={open ? "Collapse" : "Expand"}
          >
            {open ? "−" : "+"}
          </button>
        ) : (
          <div style={{ width: 18 }} />
        )}

        {k !== null && (
          <span style={{ color: "color-mix(in oklab, CanvasText 70%, transparent)" }}>
            "{k}"
            <span style={{ color: "color-mix(in oklab, CanvasText 35%, transparent)" }}>:</span>
          </span>
        )}

        {!isColl ? (
          <span style={{ color: tokenColor(v) }}>
            {typeof v === "string" ? `"${v}"` : String(v)}
          </span>
        ) : (
          <span style={{ color: "color-mix(in oklab, CanvasText 65%, transparent)" }}>
            {headLabel}
          </span>
        )}
      </div>

      {isColl && open && (
        <div style={{ marginTop: 4, marginBottom: 6 }}>
          {isArr &&
            v.map((item: any, idx: number) => (
              <NodeRow key={idx} k={String(idx)} v={item} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
            ))}
          {isObj &&
            Object.keys(v)
              .sort()
              .map((key) => (
                <NodeRow key={key} k={key} v={v[key]} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
              ))}
        </div>
      )}
    </div>
  );
}

export default function JsonViewer({
  value,
  title = "JSON",
  defaultExpandDepth = 2,
}: {
  value: Json;
  title?: string;
  defaultExpandDepth?: number;
}) {
  const [wrap, setWrap] = useState(true);
  const [mode, setMode] = useState<"tree" | "code">("tree");

  const raw = useMemo(() => pretty(value ?? {}), [value]);

  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 13, opacity: 0.9 }}>{title}</div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            onClick={() => setMode(mode === "tree" ? "code" : "tree")}
            style={{
              padding: "6px 10px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 800,
              opacity: 0.9,
            }}
            title="Toggle Tree/Code"
          >
            {mode === "tree" ? "Code" : "Tree"}
          </button>

          <button
            onClick={() => setWrap(!wrap)}
            style={{
              padding: "6px 10px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 800,
              opacity: 0.9,
            }}
            title="Toggle wrapping"
          >
            {wrap ? "No wrap" : "Wrap"}
          </button>

          <button
            onClick={() => copyText(raw)}
            style={{
              padding: "6px 10px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 800,
              opacity: 0.9,
            }}
            title="Copy JSON"
          >
            Copy
          </button>
        </div>
      </div>

      {mode === "tree" ? (
        <div style={{ padding: 12 }}>
          <NodeRow k={null} v={value ?? {}} depth={0} defaultExpandDepth={defaultExpandDepth} />
        </div>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 12,
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: wrap ? "pre-wrap" : "pre",
            overflow: "auto",
            opacity: 0.95,
          }}
        >
{raw}
        </pre>
      )}
    </div>
  );
}
TSX
echo "✅ wrote admin/_components/JsonViewer.tsx"

echo "==> (2) Patch pages to use JsonViewer instead of raw <pre> JSON"
python3 - <<'PY'
from pathlib import Path
import re

files = [
  Path("next-app/src/app/admin/contracts/[id]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx"),
]

def add_import(src: str, import_path: str):
  if "JsonViewer" in src:
    return src
  # insert after "use client" if present, else top
  if '"use client";' in src:
    parts = src.split('"use client";', 1)
    return parts[0] + '"use client";\n\nimport JsonViewer from "' + import_path + '";\n' + parts[1]
  return 'import JsonViewer from "' + import_path + '";\n' + src

def replace_pre_blocks(src: str):
  # replace common patterns that render payload/preview JSON
  src = re.sub(
    r"<pre[^>]*>\s*{\s*JSON\.stringify\(([^)]*)\)\s*}\s*</pre>",
    r'<JsonViewer title="JSON" value={\1} />',
    src,
    flags=re.DOTALL
  )
  return src

for f in files:
  if not f.exists():
    continue
  s = f.read_text()

  # path to admin/_components from each file
  p = str(f)
  if p.endswith("/admin/contracts/[id]/page.tsx"):
    imp = "../../_components/JsonViewer"
  elif p.endswith("/admin/contracts/[id]/payloads/page.tsx"):
    imp = "../../../_components/JsonViewer"
  elif p.endswith("/admin/contracts/[id]/payloads/[payloadId]/page.tsx"):
    imp = "../../../../_components/JsonViewer"
  elif p.endswith("/admin/contracts/[id]/packet/page.tsx"):
    imp = "../../../_components/JsonViewer"
  else:
    imp = "../../_components/JsonViewer"

  s2 = add_import(s, imp)
  s2 = replace_pre_blocks(s2)

  # Also upgrade any custom inline preview panel: replace JSON.stringify(d.payload...) blocks
  s2 = re.sub(
    r"<pre[^>]*>\s*{JSON\.stringify\(([^)]*)\)\s*,\s*null\s*,\s*2\)\s*}\s*</pre>",
    r'<JsonViewer title="Preview" value={\1} />',
    s2,
    flags=re.DOTALL
  )

  if s2 != s:
    f.write_text(s2)
    print("✅ patched", f)

PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "✅ done"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001"
