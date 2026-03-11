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
JOBS_URL="$EXPECTED_BASE/listJobsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=25"
INCIDENT_URL="$EXPECTED_BASE/getIncidentV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"
NEXT_URL="http://127.0.0.1:${NEXT_PORT}"
INCIDENT_PAGE_URL="${NEXT_URL}/incidents/${INCIDENT_ID}"
READ_PROXY_URL="${NEXT_URL}/api/fn/createEvidenceReadUrlV1"
CLOSE_PROXY_URL="${NEXT_URL}/api/fn/closeIncidentV1"

fail() {
  echo "[smoke] FAIL: $*" >&2
  exit 1
}

say() {
  echo "[smoke] $*"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is required"
fi
if ! command -v od >/dev/null 2>&1; then
  fail "od is required"
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
if ! jq -e '.docs[]? | select(((.jobId // "") | length) > 0)' /tmp/peakops_smoke_list.json >/dev/null 2>&1; then
  fail "No evidence docs have canonical top-level jobId for ${INCIDENT_ID}. Run scripts/dev/seed_demo_incident.sh"
fi
if ! jq -e '.docs[]? | select((.jobId // .evidence.jobId // "") == "job_demo_001")' /tmp/peakops_smoke_list.json >/dev/null 2>&1; then
  fail "No evidence docs linked to job_demo_001 for ${INCIDENT_ID}. Run scripts/dev/seed_demo_incident.sh"
fi
say "Probing incident notes summary marker"
INC_HTTP_CODE="$(curl -sS -o /tmp/peakops_smoke_incident.json -w '%{http_code}' "$INCIDENT_URL" || true)"
if [[ "$INC_HTTP_CODE" -lt 200 || "$INC_HTTP_CODE" -gt 399 ]]; then
  tail -c 400 /tmp/peakops_smoke_incident.json 2>/dev/null || true
  fail "getIncidentV1 failed with HTTP ${INC_HTTP_CODE}"
fi
if ! jq -e '.ok == true' /tmp/peakops_smoke_incident.json >/dev/null 2>&1; then
  cat /tmp/peakops_smoke_incident.json
  fail "getIncidentV1 response missing ok=true"
fi
if ! jq -e '.doc.notesSummary.savedAt // .doc.notesSummary.saved // .doc.notes.savedAt // .doc.notes.saved // empty' /tmp/peakops_smoke_incident.json >/dev/null 2>&1; then
  fail "Incident notes-saved marker missing. Run scripts/dev/seed_demo_incident.sh"
fi
if ! jq -e '.docs[]? | select(((.file.thumbPath // "") | length) > 0 or ((.file.conversionStatus // "") | ascii_downcase) == "ready" or ((.file.conversionStatus // "") | ascii_downcase) == "n/a")' /tmp/peakops_smoke_list.json >/dev/null 2>&1; then
  say "WARN no evidence has thumbPath/ready/n/a status yet; conversion pipeline may still be warming up."
fi

say "Probing signed read URL for one evidence object"
READ_PICK="$(jq -r '
  .docs[]?
  | select(((.file.bucket // .file.derivativeBucket // "") | length) > 0 and ((.file.storagePath // "") | length) > 0)
  | "\(.file.bucket // .file.derivativeBucket)\t\(.file.storagePath)\t\(.id)"
  ' /tmp/peakops_smoke_list.json | head -n1)"
if [[ -z "${READ_PICK}" ]]; then
  fail "No evidence with bucket+storagePath found for signed read URL probe."
fi
READ_BUCKET="$(printf '%s' "${READ_PICK}" | awk -F'\t' '{print $1}')"
READ_PATH="$(printf '%s' "${READ_PICK}" | awk -F'\t' '{print $2}')"
READ_EVIDENCE_ID="$(printf '%s' "${READ_PICK}" | awk -F'\t' '{print $3}')"
READ_HTTP_CODE="$(
  curl -sS -o /tmp/peakops_smoke_readurl.json -w '%{http_code}' \
    -X POST "${EXPECTED_BASE}/createEvidenceReadUrlV1" \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${READ_BUCKET}\",\"storagePath\":\"${READ_PATH}\",\"expiresSec\":120}" || true
)"
if [[ "${READ_HTTP_CODE}" -lt 200 || "${READ_HTTP_CODE}" -gt 399 ]]; then
  tail -c 400 /tmp/peakops_smoke_readurl.json 2>/dev/null || true
  fail "createEvidenceReadUrlV1 failed (${READ_HTTP_CODE}) for evidence ${READ_EVIDENCE_ID}"
fi
READ_URL="$(jq -r '.url // ""' /tmp/peakops_smoke_readurl.json)"
if [[ -z "${READ_URL}" ]]; then
  cat /tmp/peakops_smoke_readurl.json
  fail "createEvidenceReadUrlV1 returned no url for evidence ${READ_EVIDENCE_ID}"
fi
READ_URL_CODE="$(curl -sS -I -o /dev/null -w '%{http_code}' "${READ_URL}" || true)"
if [[ "${READ_URL_CODE}" -lt 200 || "${READ_URL_CODE}" -gt 399 ]]; then
  fail "Signed read URL not reachable (${READ_URL_CODE}) for evidence ${READ_EVIDENCE_ID}"
fi

say "Probing Next proxy /api/fn/createEvidenceReadUrlV1"
PROXY_HTTP_CODE="$(
  curl -sS -o /tmp/peakops_smoke_readurl_proxy.json -w '%{http_code}' \
    -X POST "${READ_PROXY_URL}" \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${READ_BUCKET}\",\"storagePath\":\"${READ_PATH}\",\"expiresSec\":120}" || true
)"
if [[ "${PROXY_HTTP_CODE}" -lt 200 || "${PROXY_HTTP_CODE}" -gt 399 ]]; then
  cat /tmp/peakops_smoke_readurl_proxy.json 2>/dev/null || true
  fail "Next proxy createEvidenceReadUrlV1 failed (${PROXY_HTTP_CODE}) for evidence ${READ_EVIDENCE_ID}"
fi
PROXY_URL="$(jq -r '.url // ""' /tmp/peakops_smoke_readurl_proxy.json)"
if [[ -z "${PROXY_URL}" ]]; then
  cat /tmp/peakops_smoke_readurl_proxy.json
  fail "Next proxy createEvidenceReadUrlV1 returned no url for evidence ${READ_EVIDENCE_ID}"
fi
PROXY_URL_CODE="$(curl -sS -I -o /dev/null -w '%{http_code}' "${PROXY_URL}" || true)"
if [[ "${PROXY_URL_CODE}" -lt 200 || "${PROXY_URL_CODE}" -gt 399 ]]; then
  fail "Next proxy signed read URL not reachable (${PROXY_URL_CODE}) for evidence ${READ_EVIDENCE_ID}"
fi

say "Verifying PNG demo object magic bytes"
PNG_PICK="$(jq -r '
  .docs[]?
  | select(((.file.contentType // "") | ascii_downcase) == "image/png")
  | select(((.file.bucket // .file.derivativeBucket // "") | length) > 0 and ((.file.storagePath // "") | length) > 0)
  | "\(.file.bucket // .file.derivativeBucket)\t\(.file.storagePath)\t\(.id)"
  ' /tmp/peakops_smoke_list.json | head -n1)"
if [[ -z "${PNG_PICK}" ]]; then
  fail "No PNG evidence with bucket+storagePath found for magic-byte verification."
fi
PNG_BUCKET="$(printf '%s' "${PNG_PICK}" | awk -F'\t' '{print $1}')"
PNG_PATH="$(printf '%s' "${PNG_PICK}" | awk -F'\t' '{print $2}')"
PNG_ID="$(printf '%s' "${PNG_PICK}" | awk -F'\t' '{print $3}')"
PNG_PROXY_HTTP_CODE="$(
  curl -sS -o /tmp/peakops_smoke_png_readurl_proxy.json -w '%{http_code}' \
    -X POST "${READ_PROXY_URL}" \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${PNG_BUCKET}\",\"storagePath\":\"${PNG_PATH}\",\"expiresSec\":120}" || true
)"
if [[ "${PNG_PROXY_HTTP_CODE}" -lt 200 || "${PNG_PROXY_HTTP_CODE}" -gt 399 ]]; then
  cat /tmp/peakops_smoke_png_readurl_proxy.json 2>/dev/null || true
  fail "Next proxy createEvidenceReadUrlV1 failed (${PNG_PROXY_HTTP_CODE}) for PNG evidence ${PNG_ID}"
fi
PNG_URL="$(jq -r '.url // ""' /tmp/peakops_smoke_png_readurl_proxy.json)"
if [[ -z "${PNG_URL}" ]]; then
  cat /tmp/peakops_smoke_png_readurl_proxy.json
  fail "Next proxy createEvidenceReadUrlV1 returned no url for PNG evidence ${PNG_ID}"
fi
PNG_URL_CODE="$(curl -sS -I -o /dev/null -w '%{http_code}' "${PNG_URL}" || true)"
if [[ "${PNG_URL_CODE}" -lt 200 || "${PNG_URL_CODE}" -gt 399 ]]; then
  fail "PNG signed read URL not reachable (${PNG_URL_CODE}) for evidence ${PNG_ID}"
fi
PNG_MAGIC="$(
  curl -sS -L "${PNG_URL}" \
    | od -An -t x1 -N 8 \
    | tr -d ' \n'
)"
if [[ "$(lower "${PNG_MAGIC}")" != "89504e470d0a1a0a" ]]; then
  fail "PNG magic mismatch for evidence ${PNG_ID}: got=${PNG_MAGIC}. Run scripts/dev/seed_demo_incident.sh"
fi

say "Verifying JPG demo object magic bytes"
JPG_PICK="$(jq -r '
  .docs[]?
  | select(((.file.contentType // "") | ascii_downcase) == "image/jpeg")
  | select(((.file.bucket // .file.derivativeBucket // "") | length) > 0 and ((.file.storagePath // "") | length) > 0)
  | "\(.file.bucket // .file.derivativeBucket)\t\(.file.storagePath)\t\(.id)"
  ' /tmp/peakops_smoke_list.json | head -n1)"
if [[ -z "${JPG_PICK}" ]]; then
  fail "No JPG evidence with bucket+storagePath found for magic-byte verification."
fi
JPG_BUCKET="$(printf '%s' "${JPG_PICK}" | awk -F'\t' '{print $1}')"
JPG_PATH="$(printf '%s' "${JPG_PICK}" | awk -F'\t' '{print $2}')"
JPG_ID="$(printf '%s' "${JPG_PICK}" | awk -F'\t' '{print $3}')"
JPG_PROXY_HTTP_CODE="$(
  curl -sS -o /tmp/peakops_smoke_jpg_readurl_proxy.json -w '%{http_code}' \
    -X POST "${READ_PROXY_URL}" \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${JPG_BUCKET}\",\"storagePath\":\"${JPG_PATH}\",\"expiresSec\":120}" || true
)"
if [[ "${JPG_PROXY_HTTP_CODE}" -lt 200 || "${JPG_PROXY_HTTP_CODE}" -gt 399 ]]; then
  cat /tmp/peakops_smoke_jpg_readurl_proxy.json 2>/dev/null || true
  fail "Next proxy createEvidenceReadUrlV1 failed (${JPG_PROXY_HTTP_CODE}) for JPG evidence ${JPG_ID}"
fi
JPG_URL="$(jq -r '.url // ""' /tmp/peakops_smoke_jpg_readurl_proxy.json)"
if [[ -z "${JPG_URL}" ]]; then
  cat /tmp/peakops_smoke_jpg_readurl_proxy.json
  fail "Next proxy createEvidenceReadUrlV1 returned no url for JPG evidence ${JPG_ID}"
fi
JPG_URL_CODE="$(curl -sS -I -o /dev/null -w '%{http_code}' "${JPG_URL}" || true)"
if [[ "${JPG_URL_CODE}" -lt 200 || "${JPG_URL_CODE}" -gt 399 ]]; then
  fail "JPG signed read URL not reachable (${JPG_URL_CODE}) for evidence ${JPG_ID}"
fi
JPG_MAGIC="$(
  curl -sS -L "${JPG_URL}" \
    | od -An -t x1 -N 3 \
    | tr -d ' \n'
)"
if [[ "$(lower "${JPG_MAGIC}")" != "ffd8ff" ]]; then
  fail "JPG magic mismatch for evidence ${JPG_ID}: got=${JPG_MAGIC}. Run scripts/dev/seed_demo_incident.sh"
fi

say "Probing Functions listJobsV1"
JOBS_HTTP_CODE="$(curl -sS -o /tmp/peakops_smoke_jobs.json -w '%{http_code}' "$JOBS_URL" || true)"
if [[ "$JOBS_HTTP_CODE" -lt 200 || "$JOBS_HTTP_CODE" -gt 399 ]]; then
  tail -c 400 /tmp/peakops_smoke_jobs.json 2>/dev/null || true
  fail "listJobsV1 failed with HTTP ${JOBS_HTTP_CODE}"
fi
if ! jq -e '.ok == true' /tmp/peakops_smoke_jobs.json >/dev/null 2>&1; then
  cat /tmp/peakops_smoke_jobs.json
  fail "listJobsV1 response missing ok=true"
fi
JOBS_COUNT="$(jq -r '(.count // 0) as $c | if ($c|type) == "number" then $c else 0 end' /tmp/peakops_smoke_jobs.json)"
if [[ "${JOBS_COUNT}" -le 0 ]]; then
  fail "listJobsV1 returned count=0 for incident ${INCIDENT_ID}. Run scripts/dev/seed_demo_incident.sh"
fi

say "Probing Next"
NHTTP="$(curl -sS -o /dev/null -w '%{http_code}' "$NEXT_URL" || true)"
if [[ "$NHTTP" == "000" ]]; then
  fail "Next not reachable at ${NEXT_URL}"
fi
IPHTTP="$(curl -sS -o /dev/null -w '%{http_code}' "$INCIDENT_PAGE_URL" || true)"
if [[ "$IPHTTP" -lt 200 || "$IPHTTP" -gt 399 ]]; then
  fail "Incident page not healthy at ${INCIDENT_PAGE_URL} (HTTP ${IPHTTP})"
fi

say "Checking closeIncidentV1 proxy route exists (non-destructive)"
CLOSE_ROUTE_HTTP="$(curl -sS -o /tmp/peakops_smoke_close_route.out -w '%{http_code}' -X OPTIONS "${CLOSE_PROXY_URL}" || true)"
if [[ "${CLOSE_ROUTE_HTTP}" == "000" || "${CLOSE_ROUTE_HTTP}" == "404" ]]; then
  tail -c 300 /tmp/peakops_smoke_close_route.out 2>/dev/null || true
  fail "closeIncidentV1 proxy route missing at ${CLOSE_PROXY_URL}"
fi

say "PASS"
say "Functions: ${EXPECTED_BASE}"
say "Next: ${NEXT_URL}"
