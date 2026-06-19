#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "===== kill local dev ports ====="
for p in 3001 5004 8087 9199 4000 4001 4400 4401 4500 4501 9154; do
  lsof -ti tcp:$p | xargs kill -9 2>/dev/null || true
done

echo
echo "===== starting emulators ====="
osascript -e 'tell application "Terminal" to do script "cd '"$(pwd)"' && firebase emulators:start --project peakops-pilot --config firebase.json --only functions,firestore,storage"'

sleep 8

echo
echo "===== starting next dev ====="
osascript -e 'tell application "Terminal" to do script "cd '"$(pwd)"'/next-app && npm run dev"'

sleep 6

echo
echo "===== healthcheck ====="
curl -s http://127.0.0.1:5004/peakops-pilot/us-central1/hello ; echo
curl -s "http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo" ; echo
