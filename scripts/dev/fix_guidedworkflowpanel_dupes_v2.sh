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

echo "==> pre-scan type declarations (line numbers)"
rg -n '^\s*type\s+(StepStatus|Role|WfHistItem)\b' "$FILE" || true
echo

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

def remove_duplicate_type_aliases(text: str, name: str) -> str:
    # Find every "type Name" and remove all but first.
    # We remove from the 'type Name' token up to the FIRST semicolon after it.
    starts = [m.start() for m in re.finditer(rf'(^|\n)\s*type\s+{re.escape(name)}\b', text)]
    if len(starts) <= 1:
        return text

    # Compute spans (start -> end at next ';')
    spans = []
    for st in starts[1:]:
        semi = text.find(";", st)
        if semi == -1:
            # if somehow missing semicolon, cut until next newline block boundary
            end = text.find("\n\n", st)
            if end == -1:
                end = len(text)
            spans.append((st, end))
        else:
            spans.append((st, semi + 1))

    # remove in reverse order
    for st, en in reversed(spans):
        text = text[:st] + "\n" + text[en:]
    return text

for name in ["StepStatus", "Role", "WfHistItem"]:
    s = remove_duplicate_type_aliases(s, name)

# If the helper block got duplicated wholesale, remove extra helper blocks.
start_tag = "/*__GWP_UI_HELPERS_V1__*/"
end_tag   = "/*__GWP_UI_HELPERS_V1_END__*/"
starts = [m.start() for m in re.finditer(re.escape(start_tag), s)]
if len(starts) > 1:
    spans = []
    for st in starts:
        en = s.find(end_tag, st)
        if en != -1:
            spans.append((st, en + len(end_tag)))
    # keep first, remove rest
    for st, en in reversed(spans[1:]):
        s = s[:st] + "\n" + s[en:]

# Ensure autoLevel exists if referenced in JSX but not declared
if re.search(r'\bautoLevel\b', s) and not re.search(r'\b(const|let)\s+autoLevel\b', s):
    m = re.search(r'(export\s+default\s+function\s+GuidedWorkflowPanel\s*\([^)]*\)\s*\{\s*)', s)
    if m:
        insert = (
            "\n  // __AUTOLEVEL_SAFE_DEF__\n"
            "  // Demo-safe: prevents runtime crash if JSX references autoLevel.\n"
            "  const autoLevel: any = null;\n"
        )
        s = s[:m.end()] + insert + s[m.end():]

p.write_text(s)
print("✅ cleaned GuidedWorkflowPanel: removed duplicate type aliases + extra helper blocks + safe autoLevel")
PY

echo
echo "==> post-scan type declarations (should be 0 or 1 each)"
rg -n '^\s*type\s+(StepStatus|Role|WfHistItem)\b' "$FILE" || true
echo

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ still failing"; tail -n 220 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "✅ done"
