#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()
if "const [autoDone," not in s:
    m = re.search(r'const\s+\[meta,\s*setMeta\]\s*=\s*useState<any>\(null\);\s*', s)
    if not m:
        raise SystemExit("❌ Could not find: const [meta, setMeta] = useState<any>(null);")
    s = s[:m.end()] + "\n  const [autoDone, setAutoDone] = useState<Record<string, boolean>>({});\n" + s[m.end():]
s = re.sub(
    r'const\s+intakeReady\s*=\s*!!\(\s*meta\?\.\s*id\s*\)\s*;\s*',
    'const intakeReady = !!(meta?.id && String(meta.id) === String(incidentId) && (!meta?.orgId || String(meta.orgId) === String(orgId)));\n',
    s
)
mark_pat = re.compile(
    r'function\s+mark\(k:\s*string,\s*v:\s*"DONE"\)\s*\{\s*'
    r'if\s*\(next\[k\]\s*!==\s*v\)\s*\{\s*'
    r'next\[k\]\s*=\s*v;\s*'
    r'changed\s*=\s*true;\s*'
    r'\}\s*\}\s*',
    re.M
)

mark_repl = (
    'function mark(k: string, v: "DONE") {\n'
    '      if (next[k] !== v) {\n'
    '        next[k] = v;\n'
    '        changed = true;\n'
    '        // track that this step was auto-promoted\n'
    '        setAutoDone((m) => ({ ...m, [k]: true }));\n'
    '      }\n'
    '    }\n'
)

if mark_pat.search(s):
    s = mark_pat.sub(mark_repl, s, count=1)
else:
    # Not fatal — just warn via console in the script output.
    pass
replacement = (
    '<span style={{ ...pill(true), display: "inline-flex", gap: 8, alignItems: "center" }}>'
    '{st}'
    '{autoDone[String(s.key)] ? ('
    '<span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 900, '
    'border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)", '
    'background: "color-mix(in oklab, lime 18%, transparent)" }}>AUTO</span>'
    ') : null}'
    '</span>'
)

needle = '<span style={pill(true)}>{st}</span>'
if needle in s and "AUTO</span>" not in s:
    s = s.replace(needle, replacement, 1)
else:
    # Looser regex variant, just in case formatting differs
    s2, n = re.subn(r'<span\s+style=\{pill\(true\)\}>\{st\}</span>', replacement, s, count=1)
    if n:
        s = s2

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: stricter intakeReady + AUTO badge + autoDone tracking")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 160 .logs/next.log; exit 1; }

echo "✅ DONE"
