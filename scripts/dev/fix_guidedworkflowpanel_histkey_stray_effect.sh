#!/usr/bin/env bash
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

# -------------------------------------------------------------------
# 1) Remove the stray module-scope histKey useEffect one-liner(s)
#    (This exact line has been showing at the bottom of your file.)
# -------------------------------------------------------------------
one_liner = r'useEffect\(\(\)\s*=>\s*\{\s*if\s*\(typeof\s+window\s*!==\s*"undefined"\)\s*setHist\(readHist\(histKey\)\);\s*\},\s*\[histKey\]\s*\);\s*'
s_new = re.sub(one_liner, "", s)

# Also remove any module-scope block that references histKey + setHist(readHist(histKey))
# (Just in case a multi-line variant exists outside the component.)
# We conservatively remove only blocks that look like useEffect(...) and mention both histKey and setHist/readHist.
block_pat = re.compile(r'\n\s*useEffect\([\s\S]{0,400}?\);\s*\n', re.M)
def kill_bad_blocks(txt: str) -> str:
  out = txt
  while True:
    m = block_pat.search(out)
    if not m: break
    chunk = m.group(0)
    if ("histKey" in chunk) and ("setHist" in chunk) and ("readHist" in chunk):
      out = out[:m.start()] + "\n" + out[m.end():]
    else:
      # skip this one; continue search after it
      out = out[:m.end()] + kill_bad_blocks(out[m.end():])
      break
  return out

s_new = kill_bad_blocks(s_new)

# -------------------------------------------------------------------
# 2) Ensure history is wired INSIDE the component (not module scope)
#    We anchor off: const histKey = useMemo(...)
# -------------------------------------------------------------------
# Find the histKey line that already exists in your file:
m_histkey = re.search(r'^\s*const\s+histKey\s*=\s*useMemo\([^\n]+\)\s*;\s*$', s_new, re.M)
if not m_histkey:
  raise SystemExit("❌ Could not find 'const histKey = useMemo(...)' inside component. (Anchor missing)")

# Check if hist state exists
has_hist_state = re.search(r'\[\s*hist\s*,\s*setHist\s*\]\s*=\s*useState', s_new) is not None

# Check if a *component-scope* effect already loads histKey
has_hist_effect = re.search(r'useEffect\([\s\S]{0,200}?setHist\s*\(\s*readHist\s*\(\s*histKey\s*\)\s*\)', s_new) is not None

insert_bits = ""

if not has_hist_state:
  insert_bits += "\n  const [hist, setHist] = useState<WfHistItem[]>([]);\n"

# Always ensure the effect exists inside component (only add if missing)
if not has_hist_effect:
  insert_bits += r'''
  // Load history (client only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setHist(readHist(histKey));
    } catch {
      // demo-safe: ignore storage errors
    }
  }, [histKey]);
''' + "\n"

if insert_bits.strip():
  # Insert right AFTER the histKey declaration line
  insert_at = m_histkey.end()
  s_new = s_new[:insert_at] + insert_bits + s_new[insert_at:]

# -------------------------------------------------------------------
# 3) Final cleanup: no dangling whitespace piles
# -------------------------------------------------------------------
s_new = re.sub(r'\n{4,}', "\n\n\n", s_new).rstrip() + "\n"

p.write_text(s_new)
print("✅ fixed: removed module-scope histKey useEffect + ensured in-component history wiring")
PY

echo
echo "==> quick check: any histKey references?"
rg -n 'histKey|setHist\\(|readHist\\(' "$FILE" || true

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
echo "✅ done"
