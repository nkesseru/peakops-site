#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
echo "▶ running from repo root: $ROOT"

# defaults (override by exporting PROJECT_ID / ORG_ID / INCIDENT_ID)
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
INCIDENT_ID="${INCIDENT_ID:-inc_TEST}"

echo "==> SEED incident doc in Firestore emulator"
curl -sS -X PATCH \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\":\"${ORG_ID}\"},
      \"title\": {\"stringValue\":\"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\":\"2026-01-16T00:00:00.000Z\"}
    }
  }" | head -c 400; echo

echo
echo "✅ Emulator UI: http://127.0.0.1:4000/firestore"
