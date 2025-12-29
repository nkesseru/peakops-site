#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "${FILE}.bak_${ts}"
echo "✅ backup: ${FILE}.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
state_patterns = [
  r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
]
lines = s.splitlines(True)
seen = {i: False for i in range(len(state_patterns))}
out = []
for ln in lines:
  removed = False
  for i, pat in enumerate(state_patterns):
    if re.match(pat, ln):
      if seen[i]:
        removed = True
      else:
        seen[i] = True
    if removed:
      break
  if not removed:
    out.append(ln)
s = "".join(out)
need_state = not all(seen.values())
if need_state:
  insert_block = (
    "  // Evidence Locker UI state\n"
    "  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);\n"
    "  const [evidenceErr, setEvidenceErr] = useState<string>(\"\");\n"
    "  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);\n"
    "  const [evidenceCount, setEvidenceCount] = useState<number>(0);\n"
    "\n"
  )

  # Find a reasonable place: after the LAST useState(...) near top of component
  m = list(re.finditer(r'^\s*const\s*\[.*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$', s, flags=re.M))
  if m:
    last = m[-1].end()
    s = s[:last] + "\n" + insert_block + s[last:]
  else:
    # fallback: after "useState" import usage if found
    s = insert_block + s
if "async function loadEvidenceLocker" not in s and "const loadEvidenceLocker = async" not in s:
  fn_block = (
    "\n  // Evidence Locker fetch\n"
    "  const loadEvidenceLocker = async () => {\n"
    "    try {\n"
    "      setBusyEvidence(true);\n"
    "      setEvidenceErr(\"\");\n"
    "      setEvidenceDocs([]);\n"
    "      setEvidenceCount(0);\n"
    "\n"
    "      if (!orgId || !incidentId) {\n"
    "        setEvidenceErr(\"Missing orgId/incidentId\");\n"
    "        return;\n"
    "      }\n"
    "\n"
    "      // Calls Functions via your existing /api/fn proxy.\n"
    "      const qs = new URLSearchParams({ orgId, incidentId, limit: \"25\" }).toString();\n"
    "      const r = await fetch(`/api/fn/listEvidenceLocker?${qs}`);\n"
    "      const j = await r.json().catch(() => null);\n"
    "      if (!j || j.ok !== true) {\n"
    "        setEvidenceErr(j?.error || `listEvidenceLocker failed (${r.status})`);\n"
    "        return;\n"
    "      }\n"
    "      setEvidenceDocs(Array.isArray(j.docs) ? j.docs : []);\n"
    "      setEvidenceCount(Number(j.count || (j.docs?.length || 0)));\n"
    "    } finally {\n"
    "      setBusyEvidence(false);\n"
    "    }\n"
    "  };\n"
  )

  # Insert after getIncidentBundle loader or near other load* functions
  anchor = re.search(r'const\s+loadIncidentBundle\s*=\s*async\s*\(\)\s*=>\s*{', s)
  if anchor:
    # insert after that function ends? too hard safely; instead insert right BEFORE anchor
    idx = anchor.start()
    s = s[:idx] + fn_block + "\n" + s[idx:]
  else:
    # fallback: put near top of component, after state
    m2 = re.search(r'// Evidence Locker UI state', s)
    if m2:
      # insert after that block (a few lines)
      idx = s.find("\n\n", m2.start())
      if idx != -1:
        s = s[:idx] + fn_block + s[idx:]
      else:
        s = s + fn_block
    else:
      s = s + fn_block
s = s.replace("onClick={loadEvidenceLocker}", "onClick={loadEvidenceLocker}")

p.write_text(s)
print("✅ Evidence Locker runtime patch applied")
PY

echo "==> quick grep (should show exactly 1 of each)"
rg -n "busyEvidence|evidenceErr|evidenceDocs|evidenceCount|loadEvidenceLocker" "$FILE" | head -n 60
