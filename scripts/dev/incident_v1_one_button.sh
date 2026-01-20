#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

NEXT_DIR="next-app"
LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "✅ repo root: $ROOT"
echo "✅ logs: $LOGDIR"

# 1) Run the proven-good patcher (already created in your repo)
if [[ ! -f scripts/dev/mega_finalize_incident_v1_FIXED.sh ]]; then
  echo "❌ missing scripts/dev/mega_finalize_incident_v1_FIXED.sh"
  echo "   (This is the one that already worked for you.)"
  exit 1
fi

bash scripts/dev/mega_finalize_incident_v1_FIXED.sh

# 2) Quick smoke tests (should all be reachable)
echo
echo "==> smoke: Next up?"
curl -I -sS "http://127.0.0.1:3000/" | head -n 1 || true

echo
echo "==> smoke: packet meta"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentPacketMetaV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 40 || true

echo
echo "==> smoke: zip verification"
curl -sS "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 60 || true

echo
echo "==> smoke: incident lock"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentLockV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80 || true

echo
echo "==> smoke: packet zip download (should be 200)"
curl -I -sS "http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST" | head -n 5 || true

echo
echo "✅ Open bundle page:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" 2>/dev/null || true

echo
echo "NEXT (manual clicks):"
echo "  1) Verify ZIP"
echo "  2) Finalize Incident"
echo "  3) Hard refresh -> Canonical + ZIP Verified + Immutable should stay ON"
