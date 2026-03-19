#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Remove prior partial inserts
patterns = [
  r'^\s*//\s*Evidence Locker UI state.*(?:\n.*){0,160}\n',
  r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s+loadEvidenceLocker\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;\s*',
  r'^\s*async\s+function\s+loadEvidenceLocker\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}\s*',
  r'^\s*catch\s*\(\s*e\s*:\s*any\s*\)\s*\{[\s\S]*?\n\s*\}\s*',
]
for pat in patterns:
  s = re.sub(pat, "", s, flags=re.M)

# Find AdminIncidentDetail
m = re.search(r'function\s+AdminIncidentDetail\s*\([^)]*\)\s*\{', s)
if not m:
  raise SystemExit("❌ Could not find `function AdminIncidentDetail(...) {`")

insert_at = m.end()

block = r'''
  // Evidence Locker UI state
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);

  const loadEvidenceLocker = async () => {
    try {
      setBusyEvidence(true);
      setEvidenceErr("");

      if (!orgId || !incidentId) {
        setEvidenceErr("Missing orgId/incidentId");
        setEvidenceDocs([]);
        setEvidenceCount(0);
        return;
      }

      const qs = new URLSearchParams({ orgId, incidentId, limit: "25" });
      const r = await fetch(`/api/fn/listEvidenceLocker?${qs.toString()}`);
      if (!r.ok) throw new Error(`listEvidenceLocker failed (${r.status})`);
      const j = await r.json();

      setEvidenceDocs(Array.isArray(j?.docs) ? j.docs : []);
      setEvidenceCount(Number(j?.count || 0));
    } catch (e: any) {
      console.error("loadEvidenceLocker error:", e);
      setEvidenceErr(String(e?.message || e));
      setEvidenceDocs([]);
      setEvidenceCount(0);
    } finally {
      setBusyEvidence(false);
    }
  };
'''
s = s[:insert_at] + block + s[insert_at:]
p.write_text(s)
print("✅ Evidence Locker state + loadEvidenceLocker inserted cleanly")
PY

echo "==> verify symbols exist once"
rg -n "const \\[busyEvidence|const \\[evidenceErr|const \\[evidenceDocs|const \\[evidenceCount|const loadEvidenceLocker" "$FILE" || true

echo "==> restart Next on 3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
cd next-app
pnpm dev --port 3000
