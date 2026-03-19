#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp -v "$FILE" "$FILE.bak_$ts" >/dev/null
echo "✅ backup: $FILE.bak_$ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
state_vars = [
  "evidenceDocs",
  "evidenceCount",
  "busyEvidence",
  "evidenceErr",
]
for v in state_vars:
  # Match: const [evidenceDocs, setEvidenceDocs] = useState...
  pat = re.compile(rf'^\s*const\s*\[\s*{re.escape(v)}\s*,\s*set{re.escape(v[0].upper()+v[1:])}\s*\]\s*=\s*useState[^\n]*\n', re.M)
  matches = list(pat.finditer(s))
  if len(matches) > 1:
    # remove all but first
    for m in reversed(matches[1:]):
      s = s[:m.start()] + s[m.end():]

# Also guard against variants where setter name differs (more permissive)
for v in state_vars:
  pat = re.compile(rf'^\s*const\s*\[\s*{re.escape(v)}\s*,\s*set[A-Za-z0-9_]+\s*\]\s*=\s*useState[^\n]*\n', re.M)
  matches = list(pat.finditer(s))
  if len(matches) > 1:
    for m in reversed(matches[1:]):
      s = s[:m.start()] + s[m.end():]
pat_fn = re.compile(r'^\s*const\s+loadEvidenceLocker\s*=\s*async\s*\(\s*\)\s*=>\s*\{\s*\n', re.M)
starts = [m.start() for m in pat_fn.finditer(s)]
if len(starts) > 1:
  # remove later ones by finding their block end via brace counting
  def remove_one_at(idx_start, text):
    i = idx_start
    # find opening brace after =>
    brace_i = text.find("{", i)
    if brace_i == -1:
      return text
    depth = 0
    j = brace_i
    while j < len(text):
      ch = text[j]
      if ch == "{": depth += 1
      elif ch == "}":
        depth -= 1
        if depth == 0:
          # eat trailing ; and whitespace/newlines
          k = j + 1
          while k < len(text) and text[k] in " \t\r\n":
            k += 1
          if k < len(text) and text[k] == ";":
            k += 1
          while k < len(text) and text[k] in " \t\r\n":
            k += 1
          return text[:idx_start] + text[k:]
      j += 1
    return text

  # keep first, remove the rest from last->first
  for idx in reversed(starts[1:]):
    s = remove_one_at(idx, s)
panel_start = s.find('<PanelCard title="Evidence Locker"')
if panel_start == -1:
  panel_start = s.find("<PanelCard title='Evidence Locker'")
if panel_start != -1:
  # find the matching </PanelCard> after it (simple scan)
  end_tag = "</PanelCard>"
  panel_end = s.find(end_tag, panel_start)
  if panel_end != -1:
    panel_end += len(end_tag)
    clean_panel = r'''<PanelCard title="Evidence Locker">
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
</PanelCard>'''
    s = s[:panel_start] + clean_panel + s[panel_end:]
else:
  # no panel found; leave file alone aside from de-dupes
  pass
if "const [evidenceDocs" not in s:
  # insert after bundle state if present, else after 'useState' imports usage
  anchor = "const [bundle, setBundle]"
  i = s.find(anchor)
  if i != -1:
    line_start = s.rfind("\n", 0, i) + 1
    insert_at = line_start
  else:
    # fallback: after first occurrence of "useState"
    i = s.find("useState")
    insert_at = s.rfind("\n", 0, i) + 1 if i != -1 else 0

  block = r'''
  // Evidence Locker state
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");

  const loadEvidenceLocker = async () => {
    try {
      setBusyEvidence(true);
      setEvidenceErr("");

      // assumes you already have orgId + incidentId in scope (you do in this page)
      const qs = new URLSearchParams({
        orgId: String(orgId || ""),
        incidentId: String(incidentId || ""),
        limit: "25",
      }).toString();

      const r = await fetch(`${process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE}/listEvidenceLocker?${qs}`);
      const j = await r.json();
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
  s = s[:insert_at] + block + s[insert_at:]

# Ensure loadEvidenceLocker exists at least once
if "const loadEvidenceLocker" not in s:
  raise SystemExit("Could not ensure loadEvidenceLocker exists—manual check needed.")

p.write_text(s)
print("✅ Evidence Locker dedup + panel rewrite complete")
PY

echo "==> quick sanity: show evidence-related declarations count"
rg -n "const \[evidenceDocs|const \[evidenceCount|const loadEvidenceLocker" "$FILE" || true
