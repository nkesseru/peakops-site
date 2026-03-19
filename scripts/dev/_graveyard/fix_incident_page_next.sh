#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FILE='next-app/src/app/admin/incidents/[id]/page.tsx'
echo "==> Fixing: $FILE"
test -f "$FILE" || { echo "❌ Missing $FILE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
cp -v "$FILE" "$FILE.bak.$TS" >/dev/null

echo "==> Searching git history for a known-good baseline of page.tsx…"
COMMITS="$(git rev-list -n 80 HEAD -- "$FILE" || true)"
if [[ -z "${COMMITS}" ]]; then
  echo "❌ No git history found for $FILE"
  exit 1
fi

GOOD=""
for h in $COMMITS; do
  # Pull candidate file from commit
  if ! git show "$h:$FILE" >/tmp/_page.tsx 2>/dev/null; then
    continue
  fi

  # Heuristic “goodness” checks: must have these core identifiers
  if grep -q "function AdminIncidentDetail" /tmp/_page.tsx \
  && grep -q "async function runFilings" /tmp/_page.tsx \
  && grep -q "async function runTimelineGen" /tmp/_page.tsx \
  && grep -qE "(function Button|const Button)" /tmp/_page.tsx \
  && grep -q "return (" /tmp/_page.tsx; then
    GOOD="$h"
    break
  fi
done

if [[ -z "$GOOD" ]]; then
  echo "❌ Could not auto-find a baseline commit. Showing last 15 commits for manual pick:"
  git log -n 15 --oneline -- "$FILE" || true
  echo ""
  echo "If you want to force a commit:"
  echo "  GOOD=<hash> bash scripts/dev/fix_incident_page_next.sh"
  exit 1
fi

# Allow manual override
if [[ "${GOOD_OVERRIDE:-}" != "" ]]; then GOOD="$GOOD_OVERRIDE"; fi

echo "✅ Using baseline commit: $GOOD"
git show "$GOOD:$FILE" > "$FILE"

echo "==> Applying clean Evidence Locker patch (idempotent)…"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# --- helpers
def has(pattern: str) -> bool:
    return re.search(pattern, s, flags=re.M|re.S) is not None

def insert_after(anchor_pat: str, insert_txt: str) -> str:
    m = re.search(anchor_pat, s, flags=re.M|re.S)
    if not m:
        raise SystemExit(f"Could not find anchor:\n{anchor_pat}")
    i = m.end()
    return s[:i] + insert_txt + s[i:]

# 1) Ensure Evidence Locker state exists (only once)
state_block = """
  // --- Evidence Locker state ---
  const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceCount, setEvidenceCount] = useState<number>(0);
  const [busyEvidence, setBusyEvidence] = useState<boolean>(false);
  const [evidenceErr, setEvidenceErr] = useState<string>("");
  // --- end Evidence Locker ---
"""

# anchor after bundle/timeline states (very common in your file)
anchor_state = r"const\s+\[bundle,\s*setBundle\]\s*=\s*useState<.*?>\([^)]*\);\s*\n"
if not has(r"const\s+\[evidenceDocs,\s*setEvidenceDocs\]"):
    s2 = s
    m = re.search(anchor_state, s2, flags=re.M|re.S)
    if m:
        s = s2[:m.end()] + state_block + s2[m.end():]
    else:
        # fallback: after first occurrence of "const [err, setErr]"
        m2 = re.search(r"const\s+\[err,\s*setErr\]\s*=", s2, flags=re.M)
        if not m2:
            raise SystemExit("Could not locate a safe place to insert Evidence Locker state.")
        s = s2[:m2.start()] + state_block + s2[m2.start():]

# 2) Ensure loadEvidenceLocker exists (only once)
fn_block = """
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

if not has(r"const\s+loadEvidenceLocker\s*=\s*async"):
    # Insert after loadBundle() function definition ends. We look for "async function loadBundle" then first closing "}"
    # Use a conservative anchor: after the line that defines loadBundle (we'll insert right after loadBundle block ends is hard),
    # so instead insert after jfetch() definition (safe and early).
    anchor = r"async function jfetch\([^\)]*\)\s*\{[\s\S]*?\}\s*\n"
    m = re.search(anchor, s, flags=re.M|re.S)
    if not m:
        raise SystemExit("Could not find jfetch() to anchor loadEvidenceLocker.")
    s = s[:m.end()] + "\n" + fn_block + s[m.end():]

# 3) Ensure Evidence Locker UI panel exists, and remove any existing one to avoid duplication.
panel_pat = r"<PanelCard title=\"Evidence Locker\">[\s\S]*?</PanelCard>"
s = re.sub(panel_pat, "", s, flags=re.M|re.S)

panel_block = """
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
"""

# Insert panel right after the "What Needs Attention" panel closes (if present), otherwise after the meta grid.
anchor_ui = r"<PanelCard title=\"What Needs Attention\">[\s\S]*?</PanelCard>\s*\)\}\s*</div>\s*"
m = re.search(anchor_ui, s, flags=re.M|re.S)
if m:
    s = s[:m.end()] + "\n" + panel_block + s[m.end():]
else:
    m2 = re.search(r"<PanelCard title=\"Timeline Meta\">[\s\S]*?</PanelCard>\s*</div>", s, flags=re.M|re.S)
    if not m2:
        raise SystemExit("Could not find a safe UI insertion point for Evidence Locker panel.")
    s = s[:m2.end()] + "\n" + panel_block + s[m2.end():]

# 4) Ensure Evidence auto-load happens with bundle load (optional; harmless)
if "loadEvidenceLocker();" not in s:
    s = re.sub(r"(loadBundle\(\);\s*loadRil\(\);\s*)", r"\1loadEvidenceLocker(); ", s)

p.write_text(s)
print("✅ Evidence Locker patch applied cleanly.")
PY

echo "==> Restarting Next cleanly on :3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
cd "$ROOT/next-app"
pnpm dev --port 3000
