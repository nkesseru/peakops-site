#!/usr/bin/env bash
set -e

echo "===== FULL DEMO RESET ====="

# Kill any lingering emulator lag
sleep 0.5

echo "Clearing Firestore (best effort)..."
# (your emulator doesn't support recursive delete well, so we just overwrite cleanly)

echo "Re-seeding clean incident..."

curl -s -X POST \
  "http://127.0.0.1:5004/peakops-pilot/us-central1/createIncidentV1" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "riverbend-electric",
    "incidentId": "inc_demo",
    "title": "Demo Incident"
  }' > /dev/null

echo "Seeding demo job..."

curl -s -X POST \
  "http://127.0.0.1:5004/peakops-pilot/us-central1/createJobV1" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "riverbend-electric",
    "incidentId": "inc_demo",
    "title": "Inspect pole base"
  }' > /dev/null

sleep 0.5

echo "===== DEMO READY ====="
