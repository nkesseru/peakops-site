#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

# zsh/glob safety if you run via zsh
set +o nomatch 2>/dev/null || true

test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
s = re.sub(
  r'^\s*catch\s*\(\s*e\s*:\s*any\s*\)\s*\{[\s\S]*?\n\s*\}\s*;\s*',
  "",
  s,
  flags=re.M
)

state_defs = [
  r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState<[^>]*>\([^)]*\);\s*$',
]
for pat in state_defs:
  s = re.sub(pat, "", s, flags=re.M)
s = re.sub(
  r'^\s*const\s+loadEvidenceLocker\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;\s*$',
  "",
  s,
  flags=re.M
)
m = re.search(r'function\s+AdminIncidentDetail\s*\([^)]*\)\s*\{', s)
if not m:
  raise SystemExit("❌ Could not find function AdminIncidentDetail(...) {")

insert_at = m.end()

block = r'''
  // ==========================
  // Evidence Locker UI state
  // ==========================
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);

  const loadEvidenceLocker = async () => {
    try {
      setBusyEvidence(true);
      setEvidenceErr("");

      // orgId + incidentId must be in scope in this page already.
      if (!orgId || !incidentId) {
        setEvidenceErr("Missing orgId/incidentId");
        setEvidenceDocs([]);
        setEvidenceCount(0);
        return;
      }

      const qs = new URLSearchParams({
        orgId: String(orgId),
        incidentId: String(incidentId),
        limit: "25",
      });

      // Next API proxy route (you already use /api/fn/* patterns)
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
s = s.replace('disabled={!!busy} onClick={loadEvidenceLocker}', 'disabled={!!busyEvidence} onClick={loadEvidenceLocker}')

p.write_text(s)
print("✅ patched: inserted evidence state + loadEvidenceLocker inside AdminIncidentDetail")
PY

echo "==> quick grep (should show exactly one of each)"
rg -n "const \\[busyEvidence|const \\[evidenceErr|const \\[evidenceDocs|const \\[evidenceCount|const loadEvidenceLocker" "$FILE" || true

echo "==> restart Next on 3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
cd next-app
pnpm dev --port 3000
