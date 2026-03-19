#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"
FILE="$ROOT/next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

echo "==> 0) backup"
cp -v "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)" >/dev/null

echo "==> 1) patch page.tsx (Evidence Locker section + download fn)"
python3 - <<'PY'
from pathlib import Path
import re, sys

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# --- Ensure downloadEvidenceZip exists (only once) ---
if "const downloadEvidenceZip" not in s:
    # anchor after loadEvidenceLocker definition
    m = re.search(r"const\s+loadEvidenceLocker\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\};\s*\n", s)
    if not m:
        raise SystemExit("Could not find loadEvidenceLocker block to anchor downloadEvidenceZip insert")

    insert = r'''
  const downloadEvidenceZip = async () => {
    try {
      if (!orgId || !incidentId) return;
      const r = await fetch(`/api/fn/exportEvidenceLockerZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "exportEvidenceLockerZip failed");

      const b64 = String(j.zipBase64 || "");
      if (!b64) throw new Error("Empty zipBase64");
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/zip" });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = j.filename || `evidence_${incidentId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setBanner(`✅ Evidence ZIP downloaded (${j.count || 0} items)`);
    } catch (e:any) {
      console.error("downloadEvidenceZip error:", e);
      setBanner(`❌ Evidence ZIP export failed: ${String(e?.message || e)}`);
    }
  };

'''
    s = s[:m.end()] + insert + s[m.end():]

# --- Replace the entire Evidence Locker PanelCard block with a known-good version ---
# Find: <PanelCard title="Evidence Locker"> ... </PanelCard>
# We will replace only that block to avoid chasing partial corruptions.
blk = re.search(r'<PanelCard\s+title="Evidence Locker">[\s\S]*?</PanelCard>', s)
if not blk:
    raise SystemExit('Could not find <PanelCard title="Evidence Locker"> block')

replacement = r'''<PanelCard title="Evidence Locker">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <Button disabled={!!busyEvidence} onClick={loadEvidenceLocker}>
              {busyEvidence ? "Loading…" : "Refresh Evidence"}
            </Button>

            <Button
              disabled={!!busyEvidence || (evidenceCount || 0) === 0}
              onClick={downloadEvidenceZip}
            >
              Download ZIP
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

s = s[:blk.start()] + replacement + s[blk.end():]

p.write_text(s)
print("✅ Evidence Locker panel + downloadEvidenceZip patched cleanly")
PY

echo "==> 2) restart Next cleanly on :3000"
# kill whatever is on 3000 (safe)
lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
cd "$ROOT/next-app"
pnpm dev --port 3000
