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

echo "==> BEFORE (autoLevel occurrences)"
rg -n 'autoLevel' "$FILE" || true
echo "==> BEFORE (const autoLevel decls)"
rg -n '^\s*const\s+autoLevel\b' "$FILE" || true
echo "==> BEFORE (useState autoLevel decls)"
rg -n '\[\s*autoLevel\s*,\s*setAutoLevel\s*\]\s*=\s*useState' "$FILE" || true
echo

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# 1) Remove any standalone injected "const autoLevel ..." (NOT the hook tuple)
# Examples to remove:
#   const autoLevel: any = null;
#   const autoLevel = "WARN";
# but do NOT touch:
#   const [autoLevel, setAutoLevel] = useState<AutoLevel>("");

lines = s.splitlines(True)
out = []
for line in lines:
    if re.search(r'^\s*const\s+autoLevel\b', line) and not re.search(r'\[\s*autoLevel\s*,\s*setAutoLevel\s*\]', line):
        # drop this line
        continue
    out.append(line)
s = "".join(out)

# 2) If we somehow have multiple hook declarations for the same state, keep the first.
def dedupe_hook_tuple(code: str, var: str, setter: str) -> str:
    pat = re.compile(rf'^\s*const\s*\[\s*{re.escape(var)}\s*,\s*{re.escape(setter)}\s*\]\s*=\s*useState[^\n]*\n', re.M)
    matches = list(pat.finditer(code))
    if len(matches) <= 1:
        return code
    # keep first, remove others (from end to preserve indices)
    for m in reversed(matches[1:]):
        code = code[:m.start()] + "" + code[m.end():]
    return code

s = dedupe_hook_tuple(s, "autoLevel", "setAutoLevel")
s = dedupe_hook_tuple(s, "autoNotes", "setAutoNotes")
s = dedupe_hook_tuple(s, "autoBusy", "setAutoBusy")

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: removed standalone autoLevel + deduped hook tuples (if any)")
PY

echo
echo "==> AFTER (const autoLevel decls)"
rg -n '^\s*const\s+autoLevel\b' "$FILE" || true
echo "==> AFTER (useState autoLevel decls)"
rg -n '\[\s*autoLevel\s*,\s*setAutoLevel\s*\]\s*=\s*useState' "$FILE" || true
echo

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ still failing"; tail -n 200 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "✅ done"
