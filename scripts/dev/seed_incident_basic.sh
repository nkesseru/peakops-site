#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "==> Seed incident doc (Firestore emulator)"
curl -sS -X PATCH \
  "http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"2026-01-01T00:00:00.000Z\"}
    }
  }" | head -c 400; echo

echo "✅ seeded. Open Emulator UI: http://127.0.0.1:4000/firestore"
