#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
BAKDIR="$ROOT/scripts/dev/_bak"

echo "==> locating latest backup for downloadIncidentPacketZip route..."
LATEST="$(ls -1t "$BAKDIR"/downloadIncidentPacketZip_route_*.ts 2>/dev/null | head -n 1 || true)"
if [[ -z "${LATEST}" ]]; then
  echo "❌ No backups found in $BAKDIR matching downloadIncidentPacketZip_route_*.ts"
  exit 1
fi
echo "✅ latest backup: $LATEST"

cp "$LATEST" "$FILE"
echo "✅ restored route.ts from backup"

echo "==> restart next (clean)"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> re-run validation fix script (no ~)"
bash "$ROOT/scripts/dev/fix_downloadIncidentPacketZip_cranky_validation.sh" "$ORG_ID" "$INCIDENT_ID" "$BASE_URL"
