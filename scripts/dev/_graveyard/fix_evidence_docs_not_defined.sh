#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

# Pick the file Next is actually building. (Your errors show src/app/... sometimes; other times next-app/src/...)
CANDIDATES=(
  "next-app/src/app/admin/incidents/[id]/page.tsx"
  "src/app/admin/incidents/[id]/page.tsx"
)

FILE=""
for f in "${CANDIDATES[@]}"; do
  if [ -f "$f" ]; then FILE="$f"; break; fi
done
[ -n "$FILE" ] || { echo "❌ could not find page.tsx in expected paths"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "${FILE}.bak_${ts}"
echo "✅ backup: ${FILE}.bak_${ts}"
echo "✅ patching: $FILE"

python3 - <<PY
from pathlib import Path
import re

p = Path("$FILE")
s = p.read_text()

# ---------- helpers ----------
def find_component_open(src: str):
  m = re.search(r'(function\\s+AdminIncidentDetail\\s*\\([^)]*\\)\\s*\\{)', src)
  if m: return m.end()
  m = re.search(r'(const\\s+AdminIncidentDetail\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{)', src)
  if m: return m.end()
  return None

start = find_component_open(s)
if start is None:
  raise SystemExit("❌ Could not find AdminIncidentDetail component declaration")

# Ensure useState is imported if used
if "useState" in s and not re.search(r'\\buseState\\b', s.split("\\n", 40)[0:40].__str__()):
  pass

# Remove any stray duplicate state definitions (anywhere) so we end with ONE inside component
state_line_pats = [
  r'^\\s*const\\s*\\[\\s*busyEvidence\\s*,\\s*setBusyEvidence\\s*\\]\\s*=\\s*useState<[^>]*>\\([^)]*\\);\\s*$',
  r'^\\s*const\\s*\\[\\s*evidenceErr\\s*,\\s*setEvidenceErr\\s*\\]\\s*=\\s*useState<[^>]*>\\([^)]*\\);\\s*$',
  r'^\\s*const\\s*\\[\\s*evidenceDocs\\s*,\\s*setEvidenceDocs\\s*\\]\\s*=\\s*useState<[^>]*>\\([^)]*\\);\\s*$',
  r'^\\s*const\\s*\\[\\s*evidenceCount\\s*,\\s*setEvidenceCount\\s*\\]\\s*=\\s*useState<[^>]*>\\([^)]*\\);\\s*$',
]
lines = s.splitlines(True)
out = []
for ln in lines:
  kill = any(re.match(pat, ln) for pat in state_line_pats)
  if not kill:
    out.append(ln)
s = "".join(out)

# Recompute component start after deletions
start = find_component_open(s)
if start is None:
  raise SystemExit("❌ Could not re-find AdminIncidentDetail after cleanup")

state_block = (
  "\\n  // Evidence Locker UI state\\n"
  "  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);\\n"
  "  const [evidenceErr, setEvidenceErr] = useState<string>(\\\"\\\");\\n"
  "  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);\\n"
  "  const [evidenceCount, setEvidenceCount] = useState<number>(0);\\n"
)

# Inject state at top of AdminIncidentDetail body
s = s[:start] + state_block + s[start:]

# Remove any previous loadEvidenceLocker defs (we’ll re-add one guaranteed-in-scope)
s = re.sub(r'^\\s*(async\\s+function\\s+loadEvidenceLocker\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\s*\\}\\s*)\\n', '', s, flags=re.M)
s = re.sub(r'^\\s*(const\\s+loadEvidenceLocker\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{[\\s\\S]*?^\\s*\\}\\s*;)\\s*\\n', '', s, flags=re.M)

fn_block = (
  "\\n  async function loadEvidenceLocker() {\\n"
  "    try {\\n"
  "      setBusyEvidence(true);\\n"
  "      setEvidenceErr(\\\"\\\");\\n"
  "      if (!orgId || !incidentId) {\\n"
  "        setEvidenceErr(\\\"Missing orgId/incidentId\\\");\\n"
  "        setEvidenceDocs([]);\\n"
  "        setEvidenceCount(0);\\n"
  "        return;\\n"
  "      }\\n"
  "      const qs = new URLSearchParams({\\n"
  "        orgId: String(orgId),\\n"
  "        incidentId: String(incidentId),\\n"
  "        limit: \\\"25\\\",\\n"
  "      });\\n"
  "      const r = await fetch(`${FN_BASE}/listEvidenceLocker?${qs.toString()}`);\\n"
  "      const j: any = await r.json().catch(() => ({}));\\n"
  "      if (!r.ok || j.ok !== true) throw new Error(j?.error || `listEvidenceLocker failed (${r.status})`);\\n"
  "      const docs = Array.isArray(j.docs) ? j.docs : [];\\n"
  "      setEvidenceDocs(docs);\\n"
  "      setEvidenceCount(Number(j.count || docs.length || 0));\\n"
  "    } catch (e: any) {\\n"
  "      console.error(\\\"loadEvidenceLocker error:\\\", e);\\n"
  "      setEvidenceErr(String(e?.message || e));\\n"
  "      setEvidenceDocs([]);\\n"
  "      setEvidenceCount(0);\\n"
  "    } finally {\\n"
  "      setBusyEvidence(false);\\n"
  "    }\\n"
  "  }\\n"
)

# Insert function right after the state block comment we just inserted
anchor = s.find("// Evidence Locker UI state")
if anchor == -1:
  raise SystemExit("❌ state block anchor missing unexpectedly")
insert_at = s.find("\\n", anchor)
s = s[:insert_at] + "\\n" + fn_block + s[insert_at:]

# Fix button usage if it references 'busy' instead of busyEvidence
s = s.replace("disabled={!!busy} onClick={loadEvidenceLocker}", "disabled={!!busyEvidence} onClick={loadEvidenceLocker}")

p.write_text(s)
print("✅ Patched evidence state + loader inside AdminIncidentDetail (guaranteed scope)")
PY

echo "==> sanity grep (should show exactly one set of state lines)"
rg -n "Evidence Locker UI state|\\[evidenceDocs|\\[evidenceCount|\\[busyEvidence|\\[evidenceErr|function loadEvidenceLocker" "$FILE" | head -n 80 || true

echo "✅ done"
