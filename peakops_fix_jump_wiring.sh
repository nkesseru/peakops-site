#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
INC="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
TP="$(find "$ROOT/next-app" -type f -name 'TimelinePanel.tsx' | head -n 1 || true)"

echo "== sanity =="
echo "IncidentClient: $INC"
echo "TimelinePanel:  $TP"

if [[ ! -f "$INC" ]]; then
  echo "❌ IncidentClient.tsx not found"
  exit 1
fi

if [[ -z "${TP:-}" || ! -f "$TP" ]]; then
  echo "❌ TimelinePanel.tsx not found"
  exit 1
fi

echo
echo "== kill port 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${PIDS:-}" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== back up files =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$INC" "$INC.bak_jump_$TS"
cp "$TP"  "$TP.bak_jump_$TS"

echo
echo "== inspect current jump-related symbols =="
rg -n "Jump|jumpToEvidence|handleJump|onJump|onJumpToEvidence|onEvidenceJump|TimelinePanel" "$INC" "$TP" || true

echo
echo "== patch TimelinePanel wiring in IncidentClient if possible =="

python3 <<'PY'
from pathlib import Path
import re
import sys

inc = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
tp_candidates = list((Path.home() / "peakops/my-app/next-app").rglob("TimelinePanel.tsx"))
if not tp_candidates:
    print("❌ TimelinePanel.tsx not found")
    sys.exit(1)

tp = tp_candidates[0]

inc_text = inc.read_text(encoding="utf-8")
tp_text = tp.read_text(encoding="utf-8")

prop_candidates = ["onJumpToEvidence", "onJump", "onEvidenceJump"]
handler_candidates = ["jumpToEvidence", "handleJumpToEvidence", "handleEvidenceJump", "onJumpToEvidence"]

prop = next((p for p in prop_candidates if re.search(rf'\b{re.escape(p)}\b', tp_text)), None)
handler = next((h for h in handler_candidates if re.search(rf'\b{re.escape(h)}\b', inc_text)), None)

if not prop:
    print("⚠️ Could not detect a jump prop in TimelinePanel.tsx")
    sys.exit(2)

if not handler:
    print(f"⚠️ Found TimelinePanel prop '{prop}', but no matching handler in IncidentClient.tsx")
    sys.exit(3)

# Find TimelinePanel usage
m = re.search(r'<TimelinePanel\b(?P<body>.*?)/>', inc_text, re.S)
if not m:
    print("⚠️ Could not find self-closing <TimelinePanel ... /> usage in IncidentClient.tsx")
    sys.exit(4)

full = m.group(0)
body = m.group("body")

if re.search(rf'\b{re.escape(prop)}\s*=', full):
    print(f"ℹ️ {prop} is already wired on <TimelinePanel />")
    sys.exit(0)

patched = full[:-2] + f'\n        {prop}={{{handler}}}\n      />'
new_text = inc_text.replace(full, patched, 1)

if new_text == inc_text:
    print("⚠️ Patch made no changes")
    sys.exit(5)

inc.write_text(new_text, encoding="utf-8")
print(f"✅ Wired TimelinePanel prop: {prop}={{{handler}}}")
PY
PATCH_STATUS=$?

echo
echo "== results =="
if [[ "$PATCH_STATUS" -eq 0 ]]; then
  echo "Patch applied or already wired"
else
  echo "Patch script could not safely auto-wire. Dumping useful snippets..."
fi

echo
echo "-- IncidentClient TimelinePanel usage --"
python3 <<'PY'
from pathlib import Path
import re
p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
m = re.search(r'<TimelinePanel\b.*?/>', s, re.S)
print(m.group(0) if m else "NOT FOUND")
PY

echo
echo "-- TimelinePanel jump lines --"
rg -n "Jump|jump|onJump|onJumpToEvidence|onEvidenceJump" "$TP" || true

echo
echo "-- IncidentClient jump handler lines --"
rg -n "jumpToEvidence|handleJump|onJumpToEvidence|handleEvidenceJump" "$INC" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next"

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) open Timeline"
echo "  2) click Jump"
echo "  3) confirm it switches/scrolls instead of doing nothing"
