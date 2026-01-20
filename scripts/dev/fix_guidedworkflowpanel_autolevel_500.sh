#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "${FILE}.bak_${TS}"
echo "✅ backup: ${FILE}.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()
s2 = re.sub(r'(marginTop\s*:\s*8)\s*,\s*\{', r'\1,', s)
s = s2
refs_level = re.search(r'\bautoLevel\b', s) is not None
refs_notes = re.search(r'\bautoNotes\b', s) is not None
has_level = re.search(r'\bconst\s+autoLevel\b', s) is not None
has_notes = re.search(r'\bconst\s+autoNotes\b', s) is not None

if (refs_level and not has_level) or (refs_notes and not has_notes):
    m = re.search(r'\n\s*return\s*\(\s*\n', s)
    if not m:
        raise SystemExit("❌ Could not find `return (` anchor inside component.")
    inject = "\n  // --- AUTO banner safety defaults (prevents 500 if banner is present) ---\n"
    if refs_notes and not has_notes:
        inject += '  const autoNotes: string = "";\n'
    if refs_level and not has_level:
        inject += '  type AutoLevel = "" | "INFO" | "WARN" | "CRITICAL";\n'
        inject += '  const autoLevel: AutoLevel = "";\n'
    inject += "\n"
    s = s[:m.start()] + inject + s[m.start():]

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: defined missing autoLevel/autoNotes + cleaned marginTop injection")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ still failing"; tail -n 140 .logs/next.log; exit 1; }

echo "✅ done"
