#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="${HOME}/peakops/my-app"
FILE="${ROOT}/next-app/src/app/admin/incidents/[id]/page.tsx"

test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak.${ts}"
echo "✅ backup: $FILE.bak.${ts}"

python3 - <<'PY'
import re
from pathlib import Path

p = Path.home() / "peakops" / "my-app" / "next-app" / "src" / "app" / "admin" / "incidents" / "[id]" / "page.tsx"
s = p.read_text()

# --- helpers
def strip_block(pattern: str, text: str) -> str:
    return re.sub(pattern, "", text, flags=re.M | re.S)

# 1) Remove any duplicate Evidence Locker state lines (anywhere)
state_vars = [
    r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState<.*?>\(\s*\[\]\s*\)\s*;\s*$',
    r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState<.*?>\(\s*0\s*\)\s*;\s*$',
    r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState<.*?>\(\s*false\s*\)\s*;\s*$',
    r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState<.*?>\(\s*""\s*\)\s*;\s*$',
]
for pat in state_vars:
    s = re.sub(pat, "", s, flags=re.M)

# 2) Remove any existing loadEvidenceLocker blocks (const loadEvidenceLocker = async ...)
s = strip_block(r'^\s*const\s+loadEvidenceLocker\s*=\s*async\s*\(\)\s*=>\s*\{\s*.*?^\s*\}\s*;\s*\n', s)

# 3) Find AdminIncidentDetail component (function or const arrow)
m = re.search(r'(function\s+AdminIncidentDetail\s*\([^\)]*\)\s*\{)|(const\s+AdminIncidentDetail\s*=\s*\([^\)]*\)\s*=>\s*\{)', s)
if not m:
    raise SystemExit("Could not find AdminIncidentDetail component")

# 4) Insert Evidence Locker state after the first cluster of state vars.
# Anchor after 'const [bundle, setBundle]' if present, else after first useState.
anchor = re.search(r'^\s*const\s*\[\s*bundle\s*,\s*setBundle\s*\]\s*=\s*useState.*?;\s*$', s, flags=re.M)
if not anchor:
    anchor = re.search(r'^\s*const\s*\[.*?\]\s*=\s*useState.*?;\s*$', s, flags=re.M)

if not anchor:
    raise SystemExit("Could not find a useState anchor to insert Evidence Locker state")

insert_state = """
  // Evidence Locker (UI state)
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");
""".rstrip() + "\n\n"

i = anchor.end()
s = s[:i] + "\n" + insert_state + s[i:]

# 5) Insert canonical loadEvidenceLocker BEFORE useEffect
m_use = re.search(r'^\s*useEffect\s*\(\s*\(\)\s*=>\s*\{', s, flags=re.M)
if not m_use:
    raise SystemExit("Could not find useEffect(() => { ... }) to insert loadEvidenceLocker before it")

insert_fn = """
  const loadEvidenceLocker = async () => {
    if (!orgId || !incidentId) { setEvidenceErr("Missing orgId/incidentId"); return; }
    setBusyEvidence(true);
    setEvidenceErr("");
    try {
      const j = await jfetch(`/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=25`);
      if (!j?.ok) throw new Error(j?.error || "listEvidenceLocker failed");
      setEvidenceDocs(Array.isArray(j.docs) ? j.docs : []);
      setEvidenceCount(Number(j.count || 0));
    } catch (e: any) {
      console.error("loadEvidenceLocker error:", e);
      setEvidenceErr(String(e?.message || e));
    } finally {
      setBusyEvidence(false);
    }
  };

""".lstrip("\n")

s = s[:m_use.start()] + insert_fn + s[m_use.start():]

# 6) Ensure useEffect calls loadEvidenceLocker
s = re.sub(r'(loadBundle\(\);\s*loadRil\(\);\s*)(?!loadEvidenceLocker\(\);)',
           r'\1loadEvidenceLocker(); ', s)

# Clean up extra blank lines
s = re.sub(r'\n{3,}', "\n\n", s)

p.write_text(s)
print("✅ Patched page.tsx: Evidence Locker state + loadEvidenceLocker are now in component scope.")
PY

echo "✅ patch applied"

echo "==> Restart Next cleanly on :3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
cd "$ROOT/next-app"
pnpm dev --port 3000
