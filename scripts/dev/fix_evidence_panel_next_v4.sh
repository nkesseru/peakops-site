#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE (run from ~/peakops/my-app)"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
import re
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
state_pats = [
  r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState<[^>]*>\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceDocs\s*,\s*setEvidenceDocs\s*\]\s*=\s*useState\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState<[^>]*>\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceCount\s*,\s*setEvidenceCount\s*\]\s*=\s*useState\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState<[^>]*>\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*busyEvidence\s*,\s*setBusyEvidence\s*\]\s*=\s*useState\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState<[^>]*>\([^;]*\);\s*$',
  r'^\s*const\s*\[\s*evidenceErr\s*,\s*setEvidenceErr\s*\]\s*=\s*useState\([^;]*\);\s*$',
]
for pat in state_pats:
  s = re.sub(pat, "", s, flags=re.M)
s = re.sub(r'^\s*async\s+function\s+loadEvidenceLocker\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}\s*\n', "", s, flags=re.M)
s = re.sub(r'^\s*const\s+loadEvidenceLocker\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;\s*\n', "", s, flags=re.M)
s = re.sub(
  r'\n\s*<PanelCard\s+title="Evidence Locker">\s*[\s\S]*?\n\s*</PanelCard>\s*\n',
  "\n",
  s,
  flags=re.M
)
state_block = r'''
  // --- Evidence Locker state ---
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");
'''

# anchor after banner state (stable in your file)
anchor = r'const \[banner,\s*setBanner\]\s*=\s*useState<.*?>\([^)]*\);\s*'
m = re.search(anchor, s)
if not m:
  raise SystemExit("Could not find banner useState anchor. Paste around your useState block and we’ll target a different anchor.")
insert_at = s.find("\n", m.end()) + 1
s = s[:insert_at] + state_block + s[insert_at:]

loader_block = r'''
  const loadEvidenceLocker = async () => {
    try {
      setBusyEvidence(true);
      setEvidenceErr("");

      if (!orgId || !incidentId) {
        setEvidenceDocs([]);
        setEvidenceCount(0);
        setEvidenceErr("Missing orgId/incidentId");
        return;
      }

      const url = `/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=25`;
      const j = await jfetch(url);

      if (!j || j.ok !== true) throw new Error(j?.error || "EVIDENCE_LOCKER_FAILED");

      setEvidenceDocs(Array.isArray(j.docs) ? j.docs : []);
      setEvidenceCount(Number(j.count || 0));
    } catch (e: any) {
      console.error("loadEvidenceLocker error:", e);
      setEvidenceErr(String(e?.message || e));
    } finally {
      setBusyEvidence(false);
    }
  };
'''

# insert loader after loadBundle() block (stable)
m2 = re.search(r'async function loadBundle\(\)\s*\{[\s\S]*?\n\s*\}\s*\n', s)
if not m2:
  raise SystemExit("Could not find loadBundle() block. Paste that section and we’ll target a different anchor.")
s = s[:m2.end()] + loader_block + s[m2.end():]
def inject_call(s: str) -> str:
  ue = re.search(r'useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[incidentId\]\s*\);', s)
  if not ue:
    return s
  block = s[ue.start():ue.end()]
  if "loadEvidenceLocker()" in block:
    return s
  # insert after loadBundle(); loadRil();
  block2 = block.replace("loadBundle(); loadRil();", "loadBundle(); loadRil(); loadEvidenceLocker();")
  return s[:ue.start()] + block2 + s[ue.end():]

s = inject_call(s)
panel_block = r'''
      <div style={{ marginTop: 16 }}>
        <PanelCard title="Evidence Locker">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <Button disabled={!!busyEvidence} onClick={loadEvidenceLocker}>
              {busyEvidence ? "Loading…" : "Refresh Evidence"}
            </Button>
            <div style={{ opacity: 0.75 }}>
              Count: <b>{evidenceCount}</b>
            </div>
            {!!evidenceErr && <div style={{ color: "#ff6b6b" }}>{evidenceErr}</div>}
          </div>

          {(!evidenceDocs || evidenceDocs.length === 0) ? (
            <div style={{ opacity: 0.75 }}>No evidence yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {evidenceDocs.map((d: any) => (
                <div key={d.id} style={{ padding: 10, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", opacity: 0.9 }}>
                    <b>{d.kind}</b>
                    <span>{d.filingType}</span>
                    <span style={{ opacity: 0.7 }}>job: {d.jobId}</span>
                    <span style={{ opacity: 0.7 }}>bytes: {d.payloadBytes}</span>
                  </div>
                  {!!d.payloadPreview && (
                    <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", opacity: 0.9 }}>{d.payloadPreview}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </PanelCard>
      </div>
'''

# Try to place right after the "What Needs Attention" panel section end
pos = s.find('title="What Needs Attention"')
if pos != -1:
  # insert after the closing </div> that wraps that section (best effort)
  after = s.find("</div>", pos)
  after2 = s.find("</div>", after + 6)
  insert_here = after2 + 6 if after2 != -1 else after + 6
  s = s[:insert_here] + "\n" + panel_block + s[insert_here:]
else:
  # fallback: insert before banner block
  m3 = re.search(r'\n\s*\{banner\s*&&\s*\(\s*\n', s)
  if not m3:
    # final fallback: just before return (
    m4 = re.search(r'\n\s*return\s*\(\s*\n', s)
    insert_here = m4.end() if m4 else 0
  else:
    insert_here = m3.start()
  s = s[:insert_here] + "\n" + panel_block + s[insert_here:]

# Clean up multiple blank lines
s = re.sub(r'\n{4,}', "\n\n\n", s)

p.write_text(s)
print("✅ Evidence Locker panel + state + loader normalized (v4)")
PY

echo "==> TypeScript parse check (should be clean)"
node -e "require('typescript').transpileModule(require('fs').readFileSync('$FILE','utf8'), { compilerOptions: { jsx: 2 } }); console.log('✅ ts transpile OK')"

echo "==> quick grep (each should appear once)"
rg -n "const \\[evidenceDocs|const \\[evidenceCount|const \\[busyEvidence|const \\[evidenceErr|loadEvidenceLocker" "$FILE" || true

echo "✅ done"
