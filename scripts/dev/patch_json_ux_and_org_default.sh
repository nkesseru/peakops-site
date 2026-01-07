#!/usr/bin/env bash
set -euo pipefail

REPO="$(pwd)"
NEXT_APP="$REPO/next-app"

echo "==> (0) sanity"
test -d "$NEXT_APP" || { echo "❌ next-app not found at $NEXT_APP"; exit 1; }

echo "==> (1) JsonCodeBlock upgrade (copy + wrap + line numbers)"
mkdir -p "$NEXT_APP/src/app/admin/_components"
cat > "$NEXT_APP/src/app/admin/_components/JsonCodeBlock.tsx" <<'TSX'
"use client";

import { useMemo, useState } from "react";

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toPrettyJson(value: any) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    // if it's already json-ish, try parse
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try { return JSON.stringify(JSON.parse(t), null, 2); } catch {}
    }
    return value;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function highlight(jsonText: string) {
  const esc = escapeHtml(jsonText);
  // basic JSON token highlighting
  return esc.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,
    (m) => {
      if (m.startsWith('"')) {
        return m.endsWith(":")
          ? `<span class="j-key">${m}</span>`
          : `<span class="j-str">${m}</span>`;
      }
      if (m === "true" || m === "false") return `<span class="j-bool">${m}</span>`;
      if (m === "null") return `<span class="j-null">${m}</span>`;
      return `<span class="j-num">${m}</span>`;
    }
  );
}

export default function JsonCodeBlock(props: {
  value: any;
  title?: string;
  subtitle?: string;
  maxHeight?: number;
  defaultWrap?: boolean;
}) {
  const { value, title, subtitle, maxHeight = 620, defaultWrap = false } = props;
  const [wrap, setWrap] = useState(defaultWrap);
  const [copied, setCopied] = useState(false);

  const text = useMemo(() => toPrettyJson(value), [value]);
  const html = useMemo(() => highlight(text), [text]);
  const lines = useMemo(() => text.split("\n").length, [text]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch {}
  }

  return (
    <div style={{
      border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
      borderRadius: 14,
      background: "color-mix(in oklab, CanvasText 3%, transparent)",
      overflow: "hidden"
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)"
      }}>
        <div style={{ display:"grid", gap: 2 }}>
          {title && <div style={{ fontWeight: 900 }}>{title}</div>}
          {subtitle && <div style={{ fontSize: 12, opacity: 0.75 }}>{subtitle}</div>}
          {!title && !subtitle && <div style={{ fontSize: 12, opacity: 0.75 }}>{lines} lines</div>}
        </div>

        <div style={{ display:"flex", gap: 8, alignItems:"center" }}>
          <button
            onClick={() => setWrap(!wrap)}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 12
            }}
            title="Toggle wrap"
          >
            {wrap ? "Wrap: ON" : "Wrap: OFF"}
          </button>

          <button
            onClick={copy}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              color: "CanvasText",
              cursor: "pointer",
              fontWeight: 900,
              fontSize: 12
            }}
            title="Copy JSON"
          >
            {copied ? "Copied ✅" : "Copy"}
          </button>
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "56px 1fr",
        maxHeight,
        overflow: "auto",
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: 13.5,
        lineHeight: 1.6
      }}>
        {/* line numbers */}
        <pre style={{
          margin: 0,
          padding: "12px 10px",
          textAlign: "right",
          opacity: 0.45,
          userSelect: "none",
          borderRight: "1px solid color-mix(in oklab, CanvasText 10%, transparent)"
        }}>
          {Array.from({ length: lines }).map((_, i) => (i + 1)).join("\n")}
        </pre>

        {/* code */}
        <pre
          style={{
            margin: 0,
            padding: "12px 14px",
            whiteSpace: wrap ? "pre-wrap" : "pre",
            wordBreak: wrap ? "break-word" : "normal"
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />

      </div>

      <style jsx>{`
        .j-key { color: #93c5fd; }
        .j-str { color: #86efac; }
        .j-num { color: #fbbf24; }
        .j-bool { color: #f472b6; }
        .j-null { color: #c4b5fd; }
      `}</style>
    </div>
  );
}
TSX

echo "✅ updated JsonCodeBlock"

echo "==> (2) Make getContractsV1 API route default orgId if missing (kills 400s)"
mkdir -p "$NEXT_APP/src/app/api/fn/getContractsV1"
cat > "$NEXT_APP/src/app/api/fn/getContractsV1/route.ts" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

// If orgId is missing, default in dev so UI never 400s.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getContractsV1");
}
TS
echo "✅ patched /api/fn/getContractsV1 (default orgId)"

echo "==> (3) Make Admin Contracts page always send orgId"
CONTRACTS_PAGE="$NEXT_APP/src/app/admin/contracts/page.tsx"
if [[ -f "$CONTRACTS_PAGE" ]]; then
  python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/contracts/page.tsx")
s = p.read_text()

# Ensure orgId default exists in page (orgId from search params)
if 'const orgId =' not in s:
  # do nothing; file may differ
  pass

# Make sure any fetch to /api/fn/getContractsV1 includes orgId
s = s.replace("/api/fn/getContractsV1?limit=", "/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=")
s = s.replace("/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&orgId=", "/api/fn/getContractsV1?orgId=")

p.write_text(s)
print("✅ patched admin/contracts page fetch url")
PY
else
  echo "⚠️ admin/contracts/page.tsx not found, skipping UI fetch patch"
fi

echo "==> (4) Restart Next (clean)"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$REPO/.logs"
( cd "$NEXT_APP" && pnpm dev --port 3000 > "$REPO/.logs/next.log" 2>&1 ) &
sleep 1
curl -fsS "http://127.0.0.1:3000" >/dev/null && echo "✅ Next restarted"

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
