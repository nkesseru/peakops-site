#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"

echo "==> 0) dev-down (best-effort)"
bash scripts/dev/dev-down.sh 2>/dev/null || true

echo "==> 1) kill any stray firebase/next processes"
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> 2) free the known ports (hub/firestore/functions/ui/logging/next)"
PORTS=(3000 3001 3002 5001 8081 4400 4401 4409 4500 4501 4509 9150)
for p in "${PORTS[@]}"; do
  if lsof -tiTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo " - killing port $p"
    lsof -tiTCP:"$p" -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
  fi
done

echo "==> 3) verify ports are free"
BAD=0
for p in 4401 8081 5001; do
  if lsof -tiTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "❌ still in use: $p"
    lsof -nP -iTCP:"$p" -sTCP:LISTEN || true
    BAD=1
  else
    echo "✅ free: $p"
  fi
done
if [ "$BAD" -eq 1 ]; then
  echo ""
  echo "Stop here: something is still holding ports (see output above)."
  exit 1
fi

echo "==> 4) start dev stack (your script)"
bash scripts/dev/dev-up.sh

echo "==> 5) quick sanity pings"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
echo "FN_BASE=$FN_BASE"
curl -sSf "$FN_BASE/hello" | python3 -m json.tool | head -n 40
curl -sSf "$FN_BASE/listIncidents?orgId=${ORG_ID:-org_001}" | python3 -m json.tool | head -n 80

echo ""
echo "✅ Done."
echo "Incident UI: http://localhost:3000/admin/incidents?orgId=${ORG_ID:-org_001}"
echo "Queue UI:    http://localhost:3000/admin/queue"
