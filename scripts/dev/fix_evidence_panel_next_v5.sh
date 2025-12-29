#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE (run from ~/peakops/my-app)"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Remove any broken / duplicate loadEvidenceLocker blocks (best-effort)
s = re.sub(
    r"\n\s*const\s+loadEvidenceLocker\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\};\n",
    "\n",
    s,
    flags=re.M,
)

state_names = ["evidenceDocs","evidenceCount","busyEvidence","evidenceErr"]
for name in state_names:
    # if multiple occurrences of the hook declaration, remove all but first
    pat = re.compile(rf"^\s*const\s*\[\s*{name}\s*,\s*set{name[0].upper()+name[1:]}\s*\]\s*=\s*useState.*?;\s*$", re.M)
    matches = list(pat.finditer(s))
    if len(matches) > 1:
        # remove from last to second
        for m in reversed(matches[1:]):
            s = s[:m.start()] + "" + s[m.end():]
state_block = """
  // --- Evidence Locker state ---
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");
  // --- end Evidence Locker ---
"""

if "const [evidenceDocs" not in s:
    anchor = re.search(r"const\s*\[\s*banner\s*,\s*setBanner\s*\].*?;\s*", s)
    if anchor:
        s = s[:anchor.end()] + "\n" + state_block + s[anchor.end():]
    else:
        # fallback: after first useState block
        first_us = re.search(r"const\s*\[[^\]]+\]\s*=\s*useState.*?;\s*", s)
        if not first_us:
            raise SystemExit("Could not find any useState() to anchor Evidence Locker state.")
        s = s[:first_us.end()] + "\n" + state_block + s[first_us.end():]
loader_block = r"""
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
"""

m = re.search(r"async function loadBundle\(\)\s*\{[\s\S]*?\n\s*\}\s*\n", s)
if not m:
    raise SystemExit("Could not find loadBundle() block to anchor loadEvidenceLocker().")

s = s[:m.end()] + "\n" + loader_block + "\n" + s[m.end():]
def inject_call(src: str) -> str:
    ue = re.search(r"useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[incidentId\]\s*\);", src)
    if not ue:
        return src
    block = src[ue.start():ue.end()]
    if "loadEvidenceLocker()" in block:
        return src
    block2 = block.replace("loadBundle(); loadRil();", "loadBundle(); loadRil(); loadEvidenceLocker();")
    return src[:ue.start()] + block2 + src[ue.end():]

s = inject_call(s)
if 'title="Evidence Locker"' not in s:
    panel_block = r'''
      <div style={{ marginTop: 16 }}>
        <PanelCard title="Evidence Locker">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <Button disabled={!!busyEvidence} onClick={loadEvidenceLocker}>
              {busyEvidence ? "Loading…" : "Refresh Evidence"}
            </Button>
            <div style={{ opacity: 0.75 }}>Count: <b>{evidenceCount}</b></div>
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
    pos = s.find('title="What Needs Attention"')
    if pos != -1:
        # insert after the next closing </div> after that section
        after = s.find("</div>", pos)
        after2 = s.find("</div>", after + 6)
        insert_here = after2 + 6 if after2 != -1 else after + 6
        s = s[:insert_here] + "\n" + panel_block + s[insert_here:]
    else:
        # fallback: before banner block
        m3 = re.search(r"\n\s*\{banner\s*&&\s*\(\s*\n", s)
        insert_here = m3.start() if m3 else len(s)
        s = s[:insert_here] + "\n" + panel_block + s[insert_here:]

# normalize excessive blank lines
s = re.sub(r"\n{4,}", "\n\n\n", s)

p.write_text(s)
print("✅ Evidence Locker: state + loader + useEffect call repaired (v5)")
PY

echo "==> quick grep (these should exist)"
rg -n "const \\[evidenceDocs|const \\[evidenceCount|const \\[busyEvidence|const \\[evidenceErr|const loadEvidenceLocker" "$FILE" | head -n 80 || true

echo "✅ done"
