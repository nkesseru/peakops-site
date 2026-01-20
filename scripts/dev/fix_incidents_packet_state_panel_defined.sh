#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

echo "==> backup"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Remove any existing PACKET_STATE_STUB blocks (clean slate)
s = re.sub(r"\{\s*/\*\s*PACKET_STATE_STUB\s*\*/\s*\}[\s\S]*?(?=\n\s*\{\s*/\*|\n\s*<Panel|\n\s*<PanelCard|\n\s*<div|\n\s*</div|\n\s*</Panel|\n\s*</PanelCard|$)", "", s)

has_panel_fn = bool(re.search(r"\bfunction\s+Panel\s*\(", s))
has_panelcard = bool(re.search(r"<PanelCard\b|\bfunction\s+PanelCard\s*\(", s))

wrapper = "Panel" if has_panel_fn else ("PanelCard" if has_panelcard else "Panel")

# 2) If no Panel helper exists and we're going to use Panel, define it once near the top (after imports)
if wrapper == "Panel" and not has_panel_fn:
    # Only insert if not already defined (extra safety)
    if "function Panel(" not in s:
        insert_after = 0
        m = re.search(r'(^"use client";\s*\n)', s, re.M)
        if m:
            insert_after = m.end()
        # after imports if present
        m2 = re.search(r"(import[\s\S]+?;\s*\n)(?!import)", s)
        if m2:
            insert_after = m2.end()

        panel_def = r'''
function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        padding: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>{props.title}</div>
      {props.children}
    </div>
  );
}
'''.lstrip("\n")

        # Ensure React import includes React (needed for React.ReactNode)
        if re.search(r'import\s+\{\s*useEffect', s) and "import React" not in s:
            s = re.sub(r'import\s+\{\s*useEffect', 'import React, { useEffect', s, count=1)

        s = s[:insert_after] + "\n" + panel_def + "\n" + s[insert_after:]

# 3) Build the stub using the wrapper we know exists
stub = f'''
{{/* PACKET_STATE_STUB */}}
<{wrapper} title="Packet State (stub)">
  <div style={{{{ display:"grid", gap:6, fontSize: 13, opacity: 0.9 }}}}>
    <div><span style={{{{ opacity: 0.7 }}}}>filingsMeta:</span> {{incident?.filingsMeta ? "✅ present" : "—"}}</div>
    <div><span style={{{{ opacity: 0.7 }}}}>timelineMeta:</span> {{incident?.timelineMeta ? "✅ present" : "—"}}</div>
    <div style={{{{ fontSize: 12, opacity: 0.75 }}}}>
      (Stub) This becomes the canonical packet readiness panel.
    </div>
  </div>

  <details style={{{{ marginTop: 10 }}}}>
    <summary style={{{{ cursor:"pointer", fontWeight: 900, opacity: 0.9 }}}}>View meta JSON</summary>
    <pre style={{{{ marginTop: 10, whiteSpace:"pre-wrap", fontSize: 12, opacity: 0.9 }}}}>
{{JSON.stringify({{{{ filingsMeta: incident?.filingsMeta || null, timelineMeta: incident?.timelineMeta || null }}}}, null, 2)}}
    </pre>
  </details>
</{wrapper}>
'''.strip("\n")

# 4) Insert after a reliable existing anchor: Evidence Locker / Filing Meta / Timeline / Guided Workflow panel titles
anchors = [
    r'(<Panel\s+title="Evidence Locker">[\s\S]*?</Panel>\s*)',
    r'(<Panel\s+title="Filing Meta">[\s\S]*?</Panel>\s*)',
    r'(<Panel\s+title="Timeline">[\s\S]*?</Panel>\s*)',
    r'(<Panel\s+title="Guided Workflow">[\s\S]*?</Panel>\s*)',
    r'(<GuidedWorkflowPanel\b[\s\S]*?/\>\s*)',
]
m = None
for pat in anchors:
    m = re.search(pat, s)
    if m:
        break
if not m:
    raise SystemExit("❌ Could not find insertion anchor (Evidence Locker/Filing Meta/Timeline/Guided Workflow/GuidedWorkflowPanel).")

s = s[:m.end()] + "\n\n" + stub + "\n\n" + s[m.end():]
p.write_text(s)
print(f"✅ inserted Packet State stub using <{wrapper}>")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ incident page OK" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log
  exit 1
}

echo "✅ done"
echo "OPEN: $URL"
