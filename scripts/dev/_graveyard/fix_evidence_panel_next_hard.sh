#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

echo "==> (0) sanity"
test -f "$FILE" || { echo "❌ missing $FILE (are you in repo root?)"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

echo "==> (1) restore file to last committed state (to remove broken insertions)"
git checkout -- "$FILE" || true

echo "==> (2) patch: add Evidence Locker state + loadEvidenceLocker + button wiring"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# --- find a stable place inside the component to insert state/function ---
# We anchor after the first occurrence of a "useState(" line inside AdminIncidentDetail.
m = re.search(r'function\s+AdminIncidentDetail\s*\([^)]*\)\s*\{', s)
if not m:
  raise SystemExit("Could not find AdminIncidentDetail function")

start = m.end()

# Find first useState line after component start
m2 = re.search(r'\n\s*const\s*\[[^\]]+\]\s*=\s*useState', s[start:])
if not m2:
  raise SystemExit("Could not find a useState() anchor inside AdminIncidentDetail")
insert_at = start + m2.start()

# Remove any prior evidence locker state + function if present (dedupe)
patterns = [
  r'^\s*//\s*Evidence\s+Locker[\s\S]*?^\s*const\s+loadEvidenceLocker[\s\S]*?^\s*\};\s*$',
  r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\][\s\S]*?^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\][\s\S]*?$',
]
for pat in patterns:
  s = re.sub(pat, "", s, flags=re.M)

block = r'''
  // ============================
  // Evidence Locker (UI state)
  // ============================
  const [busyEvidence, setBusyEvidence] = useState(false);
  const [evidenceErr, setEvidenceErr] = useState("");
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState(0);

  const loadEvidenceLocker = async () => {
    try {
      setBusyEvidence(true);
      setEvidenceErr("");

      // expects orgId + incidentId to exist in scope (same pattern as your other calls)
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

      // Uses your Next proxy route (you already created /api/fn/listEvidenceLocker)
      const r = await fetch(`/api/fn/listEvidenceLocker?${qs.toString()}`);
      if (!r.ok) throw new Error(`listEvidenceLocker failed (${r.status})`);

      const j = await r.json();
      const docs = Array.isArray(j?.docs) ? j.docs : [];
      const count = Number(j?.count || 0);

      setEvidenceDocs(docs);
      setEvidenceCount(count);
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

# Wire the button if it exists (best-effort replace)
s = s.replace('onClick={loadEvidenceLocker}', 'onClick={loadEvidenceLocker}')

p.write_text(s)
print("✅ Evidence locker state + loadEvidenceLocker inserted")
PY

echo "==> (3) restart Next"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
cd next-app
pnpm dev --port 3000
