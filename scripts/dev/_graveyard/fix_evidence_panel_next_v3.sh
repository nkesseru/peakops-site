#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE (run from ~/peakops/my-app)"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_evidence_${ts}"
echo "✅ backup: $FILE.bak_evidence_${ts}"

python3 - <<'PY'
import re
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
orphan = re.compile(
    r"""
    ^[ \t]*setEvidenceDocs\(\s*Array\.isArray\(j\.docs\)\s*\?\s*j\.docs\s*:\s*\[\]\s*\)\s*;\s*\n
    ^[ \t]*setEvidenceCount\(\s*Number\([^\)]*\)\s*\)\s*;\s*\n
    ^[ \t]*\}\s*catch\s*\(\s*e\s*:\s*any\s*\)\s*\{\s*\n
    [\s\S]*?
    ^[ \t]*\}\s*finally\s*\{\s*\n
    [\s\S]*?
    ^[ \t]*\}\s*;\s*$
    """,
    re.M | re.X
)
s, n0 = orphan.subn("", s)
state_pats = [
    r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState[^\n;]*;\s*$',
    r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState[^\n;]*;\s*$',
    r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState[^\n;]*;\s*$',
    r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState[^\n;]*;\s*$',
]
for pat in state_pats:
    s = re.sub(pat, "", s, flags=re.M)
s = re.sub(r'^\s*const\s+loadEvidenceLocker\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;\s*$', "", s, flags=re.M)
s = re.sub(r'^\s*async\s+function\s+loadEvidenceLocker\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}\s*$', "", s, flags=re.M)
anchor = "const [exportPurpose, setExportPurpose]"
idx = s.find(anchor)
if idx == -1:
    # fallback: place after banner state
    anchor = "const [banner, setBanner]"
    idx = s.find(anchor)
    if idx == -1:
        raise SystemExit("Could not find a safe anchor (exportPurpose or banner).")
line_end = s.find("\n", idx)
insert_at = line_end + 1

block = r'''
  // --- Evidence Locker (UI state) ---
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");

  const loadEvidenceLocker = async () => {
    // guard
    if (!orgId || !incidentId) {
      setEvidenceErr("Missing orgId/incidentId");
      setEvidenceDocs([]);
      setEvidenceCount(0);
      return;
    }

    setBusyEvidence(true);
    setEvidenceErr("");

    try {
      const qs = new URLSearchParams({
        orgId: String(orgId),
        incidentId: String(incidentId),
        limit: "25",
      });

      const r = await fetch(`/api/fn/listEvidenceLocker?${qs.toString()}`);
      if (!r.ok) throw new Error(`listEvidenceLocker failed (${r.status})`);
      const j = await r.json();

      const docs = Array.isArray(j?.docs) ? j.docs : [];
      const count = Number(j?.count ?? docs.length ?? 0);

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
  // --- end Evidence Locker ---
'''

s = s[:insert_at] + block + s[insert_at:]

s = re.sub(
    r'loadBundle\(\);\s*loadRil\(\);\s*loadEvidenceLocker\(\);\s*',
    'loadBundle(); loadRil(); loadEvidenceLocker(); ',
    s
)
usefx = re.search(r'useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[incidentId\]\s*\);\s*', s)
if usefx:
    chunk = usefx.group(0)
    if "loadEvidenceLocker()" not in chunk and "loadRil()" in chunk:
        chunk2 = chunk.replace("loadBundle(); loadRil();", "loadBundle(); loadRil(); loadEvidenceLocker();")
        s = s.replace(chunk, chunk2)

p.write_text(s)
print(f"✅ patched evidence locker: removed_orphan={n0} and reinserted canonical block")
PY

echo "==> quick sanity: evidence symbols should appear once"
rg -n "const \\[busyEvidence|const \\[evidenceErr|const \\[evidenceDocs|const \\[evidenceCount|const loadEvidenceLocker" "$FILE" || true

echo "==> restart Next on :3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
cd next-app
pnpm dev --port 3000
