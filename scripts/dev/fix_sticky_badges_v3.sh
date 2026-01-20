#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }

mkdir -p "$ROOT/.logs" "$ROOT/scripts/dev"

cp "$PAGE" "$PAGE.bak_sticky_badges_v3_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_sticky_badges_v3_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Do NOT clear zipVerified during meta load (kills badge after refresh)
s = re.sub(r"\n\s*setZipVerified\(\s*false\s*\);\s*\n", "\n", s)

# 2) Ensure hydrateLock() exists (sets immutable from backend truth)
if "async function hydrateLock" not in s:
  m = re.search(r"async function loadPacketMeta\(\)\s*\{", s)
  if not m:
    raise SystemExit("❌ could not find loadPacketMeta() anchor to insert hydrateLock()")
  helper = r'''
  async function hydrateLock() {
    try {
      const u =
        `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(u, { method: "GET" });
      const j = await r.json().catch(() => null);
      if (j?.ok) setImmutable(!!j.immutable);
    } catch {
      // swallow
    }
  }

'''
  s = s[:m.start()] + helper + s[m.start():]

# 3) Ensure hydrateZipVerification() flips the badge
if "async function hydrateZipVerification" in s:
  # insert setZipVerified(true) right after `if (zm?.zipSha256) {` if missing
  hz = re.search(r"async function hydrateZipVerification\(\)\s*\{[\s\S]*?\n\}", s)
  if hz and "setZipVerified(true)" not in hz.group(0):
    s = re.sub(
      r"(if\s*\(\s*zm\?\.\s*zipSha256\s*\)\s*\{\s*)",
      r"\1\n    setZipVerified(true);\n",
      s,
      count=1
    )

# 4) Bootstrap useEffect: run meta + zip + lock on load (if not present)
if "Bootstrap: keep badges sticky across hard refresh" not in s:
  idx = s.find("const [packetMeta")
  if idx == -1:
    raise SystemExit("❌ could not find anchor for bootstrap useEffect")
  line_end = s.find("\n", idx)
  if line_end == -1:
    raise SystemExit("❌ unexpected formatting (no newline after anchor)")
  usefx = r'''

  // Bootstrap: keep badges sticky across hard refresh
  useEffect(() => {
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

'''
  s = s[:line_end+1] + usefx + s[line_end+1:]

p.write_text(s)
print("✅ wrote bundle page (sticky badges v3)")
PY

echo "<0001f9f9> clearing Next cache"
rm -rf "$ROOT/next-app/.next" 2>/dev/null || true

echo "🚀 restarting Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "✅ sanity: endpoints should be OK"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentLockV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 60 || true
curl -sS "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 120 || true

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" 2>/dev/null || true

echo
echo "NEXT:"
echo "  1) Hard refresh (Cmd+Shift+R)"
echo "  2) Immutable + ZIP Verified badges should stay ON"
echo "  Logs: tail -n 200 $ROOT/.logs/next.log"
