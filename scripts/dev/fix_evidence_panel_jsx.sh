#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_jsxfix_$TS"
echo "✅ backup -> $FILE.bak_jsxfix_$TS"

python3 - <<'PY'
from pathlib import Path
import re, sys

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Find the Evidence Locker panel start
m_start = re.search(r'<PanelCard\s+title="Evidence Locker"\s*>', s)
if not m_start:
  print("❌ Could not find Evidence Locker <PanelCard title=\"Evidence Locker\">")
  sys.exit(1)

# Find the matching </PanelCard> AFTER that start (take the first close after start)
m_end = re.search(r'</PanelCard>', s[m_start.start():])
if not m_end:
  print("❌ Could not find closing </PanelCard> for Evidence Locker")
  sys.exit(1)

start = m_start.start()
end = m_start.start() + m_end.end()

replacement = r'''<PanelCard title="Evidence Locker">
  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
    <Button disabled={busyEvidence} onClick={loadEvidenceLocker}>
      {busyEvidence ? "Loading…" : "Refresh Evidence"}
    </Button>

    <Button
      disabled={busyEvidence || evidenceCount === 0}
      onClick={downloadEvidenceZip}
    >
      Download ZIP
    </Button>

    <div style={{ opacity: 0.75 }}>
      Count: <b>{evidenceCount}</b>
    </div>

    {!!evidenceErr && (
      <div style={{ color: "#ff6b6b" }}>{evidenceErr}</div>
    )}
  </div>

  {(!evidenceDocs || evidenceDocs.length === 0) ? (
    <div style={{ opacity: 0.75 }}>No evidence yet.</div>
  ) : (
    <div style={{ display: "grid", gap: 10 }}>
      {evidenceDocs.map((d: any) => (
        <div
          key={d.id}
          style={{
            padding: 10,
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10
          }}
        >
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", opacity: 0.9 }}>
            <b>{d.kind}</b>
            <span>{d.filingType}</span>
            <span style={{ opacity: 0.7 }}>job: {d.jobId}</span>
            <span style={{ opacity: 0.7 }}>bytes: {d.payloadBytes}</span>
          </div>

          {!!d.payloadPreview && (
            <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", opacity: 0.9 }}>
              {d.payloadPreview}
            </pre>
          )}
        </div>
      ))}
    </div>
  )}
</PanelCard>'''

out = s[:start] + replacement + s[end:]
p.write_text(out)
print("✅ Evidence Locker PanelCard replaced (JSX normalized)")
PY

echo "==> quick typecheck-ish (tsx parse) via tsc not required; rely on next build"
echo "==> Restart Next on :3000"
lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
cd next-app
pnpm dev --port 3000
