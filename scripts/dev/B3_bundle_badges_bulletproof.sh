#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TAG="a1-one-true-stack-stable"
FILE='next-app/src/app/admin/incidents/[id]/bundle/page.tsx'

echo "==> B3: Bulletproof bundle badges (restore + single bootstrap) "
echo "    file: $FILE"
echo "    tag : $TAG"
echo

# Safety backup of current working copy
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/bundle_page_pre_B3_$(date +%Y%m%d_%H%M%S).tsx" 2>/dev/null || true
echo "✅ backup saved in scripts/dev/_bak/"
echo

echo "==> (1) Restore from tag (known-good baseline)"
git show "${TAG}:${FILE}" > "$FILE"
echo "✅ restored from tag"
echo

echo "==> (2) Patch: remove any existing badge-bootstrap effects + insert ONE canonical effect after incidentId"
node <<'NODE'
const fs = require("fs");

const file = 'next-app/src/app/admin/incidents/[id]/bundle/page.tsx';
let s = fs.readFileSync(file, "utf8");

// Remove any useEffect blocks that look like "badge bootstrap":
// (they call loadPacketMeta + hydrateZipVerification + hydrateLock in one effect)
s = s.replace(
  /\n\s*\/\/\s*BOOTSTRAP_BADGES[^\n]*\n\s*useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\);\s*\n/g,
  "\n"
);

s = s.replace(
  /\n\s*useEffect\(\(\)\s*=>\s*\{[\s\S]*?loadPacketMeta\(\)\s*;[\s\S]*?hydrateZipVerification\(\)\s*;[\s\S]*?hydrate(?:Incident)?Lock\(\)\s*;[\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\);\s*\n/g,
  "\n"
);

// Find incidentId declaration line and insert right after it
const reIncidentId = /^\s*const\s+incidentId\s*=\s*String\([^\n]*\);\s*$/m;
const m = s.match(reIncidentId);

if (!m) {
  console.error("❌ Could not find incidentId declaration to anchor bootstrap insertion.");
  process.exit(1);
}

const needle = m[0];
const insert = `
  // BOOTSTRAP_BADGES_BULLETPROOF: hydrate truth on mount/id change (after ids exist)
  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

`;

s = s.replace(needle, needle + "\n" + insert);

// Collapse insane blank runs
s = s.replace(/\n{5,}/g, "\n\n\n");

fs.writeFileSync(file, s, "utf8");
console.log("✅ bundle/page.tsx patched: single bootstrap effect inserted after incidentId");
NODE

echo
echo "==> (3) Restart Next (clean cache)"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
pkill -f "next dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
rm -f .logs/next.log
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (4) Smoke: bundle page should be 200"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 12 || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
