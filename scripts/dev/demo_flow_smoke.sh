#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
NEXT_PORT="${NEXT_PORT:-3001}"
FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"

pass() { echo "[demo-flow-smoke] PASS: $*"; }
fail() { echo "[demo-flow-smoke] FAIL: $*" >&2; exit 1; }

post_ok() {
  local label="$1"
  local endpoint="$2"
  local payload="$3"
  local code
  code="$(
    curl -sS -o /tmp/peakops_demo_flow.out -w '%{http_code}' \
      -X POST "${FN_BASE}/${endpoint}" \
      -H 'content-type: application/json' \
      -d "${payload}" || true
  )"
  if [[ "${code}" -lt 200 || "${code}" -gt 299 ]]; then
    fail "${label} http=${code} body=$(head -c 500 /tmp/peakops_demo_flow.out 2>/dev/null || true)"
  fi
  if ! jq -e '.ok == true' /tmp/peakops_demo_flow.out >/dev/null 2>&1; then
    fail "${label} returned ok!=true body=$(cat /tmp/peakops_demo_flow.out 2>/dev/null || true)"
  fi
  pass "${label}"
}

echo "[demo-flow-smoke] projectId=${PROJECT_ID} orgId=${ORG_ID} incidentId=${INCIDENT_ID}"

for job_id in job_demo_001 job_demo_002; do
  post_ok "mark-complete ${job_id}" "updateJobStatusV1" "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"jobId\":\"${job_id}\",\"status\":\"complete\",\"updatedBy\":\"demo_flow_smoke\"}"
done

for job_id in job_demo_001 job_demo_002; do
  post_ok "move-to-review ${job_id}" "updateJobStatusV1" "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"jobId\":\"${job_id}\",\"status\":\"review\",\"updatedBy\":\"demo_flow_smoke\"}"
done

for job_id in job_demo_001 job_demo_002; do
  post_ok "approve ${job_id}" "approveJobV1" "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"jobId\":\"${job_id}\",\"approvedBy\":\"demo_flow_smoke\"}"
done

post_ok "close incident" "closeIncidentV1" "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"actorUid\":\"dev-admin\",\"actorRole\":\"admin\",\"closedBy\":\"demo_flow_smoke\"}"

JOBS_JSON="$(curl -sS "${FN_BASE}/listJobsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=20" || true)"
echo "${JOBS_JSON}" | jq -e '.ok == true and (.count|tonumber) == 2' >/dev/null || fail "listJobsV1 unexpected payload: ${JOBS_JSON}"
APPROVED_COUNT="$(echo "${JOBS_JSON}" | jq -r '[.docs[]? | select(((.status // "") | ascii_downcase) == "approved")] | length' 2>/dev/null || echo 0)"
if [[ "${APPROVED_COUNT}" -lt 2 ]]; then
  fail "expected approved_count>=2 after flow, got ${APPROVED_COUNT}; payload=${JOBS_JSON}"
fi
pass "jobs approved_count>=2"

INC_JSON="$(curl -sS "${FN_BASE}/getIncidentV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" || true)"
echo "${INC_JSON}" | jq -e '.ok == true' >/dev/null || fail "getIncidentV1 unexpected payload: ${INC_JSON}"
INC_STATUS="$(echo "${INC_JSON}" | jq -r '.doc.status // ""')"
if [[ "$(echo "${INC_STATUS}" | tr '[:upper:]' '[:lower:]')" != "closed" ]]; then
  fail "incident not closed after flow, status=${INC_STATUS}"
fi
pass "incident closed"

SUMMARY_CODE="$(curl -sS -o /tmp/peakops_demo_flow_summary.out -w '%{http_code}' "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/summary" || true)"
if [[ "${SUMMARY_CODE}" != "200" ]]; then
  fail "summary page http=${SUMMARY_CODE} body=$(head -c 500 /tmp/peakops_demo_flow_summary.out 2>/dev/null || true)"
fi
pass "summary page 200"

ART_CODE="$(
  curl -sS -o /tmp/peakops_demo_flow_artifact.out -w '%{http_code}' \
    -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentArtifactV1" \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\"}" || true
)"
if [[ "${ART_CODE}" -lt 200 || "${ART_CODE}" -gt 299 ]]; then
  fail "artifact export http=${ART_CODE} body=$(head -c 500 /tmp/peakops_demo_flow_artifact.out 2>/dev/null || true)"
fi
if ! jq -e '.ok == true and ((.base64Zip // "") | length > 1000)' /tmp/peakops_demo_flow_artifact.out >/dev/null 2>&1; then
  fail "artifact export payload unexpected: $(cat /tmp/peakops_demo_flow_artifact.out 2>/dev/null || true)"
fi
pass "artifact export ok"

echo "[demo-flow-smoke] PASS ✅"
