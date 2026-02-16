#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FN_PORT="${FN_PORT:-5002}"
NEXT_PORT="${NEXT_PORT:-3001}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/next-app/.env.local"
EXPECTED_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"
LIST_URL="$EXPECTED_BASE/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=50"
NEXT_URL="http://127.0.0.1:${NEXT_PORT}"

fail() {
  echo "[smoke] FAIL: $*" >&2
  exit 1
}

say() {
  echo "[smoke] $*"
}

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is required"
fi

say "Checking expected ports"
if ! lsof -nP -iTCP:"${FN_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Functions emulator not listening on ${FN_PORT}. Start emulators first."
fi

if ! lsof -nP -iTCP:"${NEXT_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Next app not listening on ${NEXT_PORT}. Start next-app first."
fi

say "Checking NEXT_PUBLIC_FUNCTIONS_BASE contract"
if [[ ! -f "$ENV_FILE" ]]; then
  fail "Missing $ENV_FILE. Create from next-app/.env.local.example"
fi

CURRENT_BASE="$(awk -F= '/^NEXT_PUBLIC_FUNCTIONS_BASE=/{print $2}' "$ENV_FILE" | tail -n1 | tr -d '"' | tr -d "'" | xargs)"
if [[ -z "$CURRENT_BASE" ]]; then
  fail "NEXT_PUBLIC_FUNCTIONS_BASE missing in $ENV_FILE"
fi
if [[ "$CURRENT_BASE" != "$EXPECTED_BASE" ]]; then
  fail "NEXT_PUBLIC_FUNCTIONS_BASE mismatch. expected=${EXPECTED_BASE} current=${CURRENT_BASE}"
fi

say "Probing Functions listEvidenceLocker"
HTTP_CODE="$(curl -sS -o /tmp/peakops_smoke_list.json -w '%{http_code}' "$LIST_URL" || true)"
if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -gt 399 ]]; then
  tail -c 400 /tmp/peakops_smoke_list.json 2>/dev/null || true
  fail "listEvidenceLocker failed with HTTP ${HTTP_CODE}"
fi
if ! jq -e '.ok == true' /tmp/peakops_smoke_list.json >/dev/null 2>&1; then
  cat /tmp/peakops_smoke_list.json
  fail "listEvidenceLocker response missing ok=true"
fi
EVIDENCE_COUNT="$(jq -r '(.count // 0) as $c | if ($c|type) == "number" then $c else 0 end' /tmp/peakops_smoke_list.json)"
if [[ "${EVIDENCE_COUNT}" -le 0 ]]; then
  fail "listEvidenceLocker returned count=0 for incident ${INCIDENT_ID}. Run scripts/dev/seed_demo_incident.sh"
fi
if ! jq -e '.docs[]? | select(.id=="ev_demo_heic_001")' /tmp/peakops_smoke_list.json >/dev/null 2>&1; then
  fail "Seed marker evidence ev_demo_heic_001 missing for incident ${INCIDENT_ID}. Run scripts/dev/seed_demo_incident.sh"
fi
if ! jq -e '.docs[]? | select(((.file.thumbPath // "") | length) > 0 or ((.file.conversionStatus // "") | ascii_downcase) == "ready" or ((.file.conversionStatus // "") | ascii_downcase) == "n/a")' /tmp/peakops_smoke_list.json >/dev/null 2>&1; then
  say "WARN no evidence has thumbPath/ready/n/a status yet; conversion pipeline may still be warming up."
fi

say "Probing Next"
NHTTP="$(curl -sS -o /dev/null -w '%{http_code}' "$NEXT_URL" || true)"
if [[ "$NHTTP" == "000" ]]; then
  fail "Next not reachable at ${NEXT_URL}"
fi

say "PASS"
say "Functions: ${EXPECTED_BASE}"
say "Next: ${NEXT_URL}"
