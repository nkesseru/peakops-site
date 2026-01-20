#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
set +H

REPO="$(pwd)"
NEXT_DIR="$REPO/next-app"
COMP_DIR="$NEXT_DIR/src/app/admin/_components"
COMP_FILE="$COMP_DIR/PrettyJson.tsx"

PACKET_PAGE="$NEXT_DIR/src/app/admin/contracts/[id]/packet/page.tsx"
PAYLOAD_EDITOR_PAGE="$NEXT_DIR/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"

echo "==> (0) Install JSON viewer dep"
pnpm -C "$NEXT_DIR" add @uiw/react-json-view

echo "==> (1) Write PrettyJson component"
mkdir -p "$COMP_DIR"
cat > "$COMP_FILE" <<'TSX'
"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";

const JsonView = dynamic(() => import("@uiw/react-json-view").then((m: any) => m.default ?? m), { ssr: false });

type Props = {
  /** Either provide `value` (object) OR `text` (string). */
  value?: any;
  text?: string;
  collapsed?: number | boolean;
  /** If true, render in a compact single-line-ish mode (still readable). */
  dense?: boolean;
};

function safeParse(text?: string) {
  if (!text) return { ok: false, value: null as any };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null as any };
  }
}

export default function PrettyJson({ value, text, collapsed = 1, dense = false }: Props) {
  const parsed = useMemo(() => safeParse(text), [text]);
  const data = value !== undefined ? value : (parsed.ok ? parsed.value : null);

  // If we got text but couldn't parse, show raw text in a nice pre.
  if (value === undefined && text !== undefined && !parsed.ok) {
    return (
      <pre style={{
        whiteSpace: "pre-wrap",
        fontSize: 12,
        lineHeight: 1.5,
        opacity: 0.95,
        fontFamily: "ui-monospace, Menlo, monospace",
        margin: 0,
      }}>
{text}
      </pre>
    );
  }

  return (
    <div style={{ margin: 0 }}>
      <JsonView
        value={data ?? {}}
        collapsed={collapsed}
        displayDataTypes={false}
        displayObjectSize={false}
        enableClipboard={false}
        shortenTextAfterLength={dense ? 40 : 120}
        style={{
          backgroundColor: "transparent",
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: dense ? 12 : 13,
          lineHeight: 1.55,
          padding: 0,
        }}
      />
    </div>
  );
}
TSX

echo "✅ wrote: $COMP_FILE"

echo "==> (2) Patch Packet Preview right panel to use PrettyJson"
python3 - <<PY
from pathlib import Path

p = Path("$PACKET_PAGE")
s = p.read_text()

# Ensure import exists
imp = 'import PrettyJson from "../../_components/PrettyJson";'
if imp not in s:
  # insert after last import
  lines = s.splitlines()
  last_import_idx = max([i for i,l in enumerate(lines) if l.strip().startswith("import ")], default=-1)
  if last_import_idx >= 0:
    lines.insert(last_import_idx+1, imp)
    s = "\n".join(lines) + "\n"

# Replace the first <pre ...>{...}</pre> inside the Preview panel
# We'll swap ANY pre block that contains "preview" variable-ish content.
# Common patterns we handle:
#  - <pre> {previewText} </pre>
#  - <pre>{selectedText}</pre>
#  - <pre>{text}</pre>
import re

pre_pat = re.compile(r"<pre[^>]*>\\s*\\{([^}]+)\\}\\s*</pre>", re.M)
m = pre_pat.search(s)
if not m:
  print("⚠️ Could not find <pre>{...}</pre> in packet page; skipping replacement.")
else:
  expr = m.group(1).strip()
  repl = f"<PrettyJson text={{String({expr} ?? \"\")}} collapsed={{1}} />"
  s = s[:m.start()] + repl + s[m.end():]
  print("✅ replaced Packet Preview pre with PrettyJson (expr:", expr, ")")

p.write_text(s)
PY

echo "==> (3) Patch Payload Editor right-side panels to use PrettyJson"
python3 - <<PY
from pathlib import Path
import re

p = Path("$PAYLOAD_EDITOR_PAGE")
s = p.read_text()

imp = 'import PrettyJson from "../../../_components/PrettyJson";'
if imp not in s:
  lines = s.splitlines()
  last_import_idx = max([i for i,l in enumerate(lines) if l.strip().startswith("import ")], default=-1)
  if last_import_idx >= 0:
    lines.insert(last_import_idx+1, imp)
    s = "\n".join(lines) + "\n"

# Replace "Metadata" pre block(s) and "Parsed Payload" pre block(s) if present.
# We target <pre> that contains JSON.stringify(metadata...) OR JSON.stringify(parsed...)
s2 = s

# metadata
meta_pat = re.compile(r"<pre[^>]*>\\s*\\{\\s*JSON\\.stringify\\(([^\\)]+)\\,\\s*null\\,\\s*2\\)\\s*\\}\\s*</pre>", re.M)
matches = list(meta_pat.finditer(s2))
if matches:
  # replace first occurrence with PrettyJson value={...}
  m = matches[0]
  expr = m.group(1).strip()
  repl = f"<PrettyJson value={{({expr}) ?? {{}}}} collapsed={{1}} />"
  s2 = s2[:m.start()] + repl + s2[m.end():]
  print("✅ replaced one JSON.stringify pre with PrettyJson value={...}")

# parsed payload panel (often JSON.stringify(parsed || {}, null, 2))
matches2 = list(meta_pat.finditer(s2))
if matches2:
  # replace another occurrence if still present
  m = matches2[0]
  expr = m.group(1).strip()
  repl = f"<PrettyJson value={{({expr}) ?? {{}}}} collapsed={{1}} />"
  s2 = s2[:m.start()] + repl + s2[m.end():]
  print("✅ replaced second JSON.stringify pre with PrettyJson value={...}")

p.write_text(s2)
PY

echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$REPO/.logs/next.log" 2>&1 ) &

sleep 1
echo "✅ Next restarted"

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 80 .logs/next.log"
