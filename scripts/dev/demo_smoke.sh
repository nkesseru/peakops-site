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
SEED_MODE="${SEED_MODE:-interactive}"
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/firebase.json"
fi
FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
EXPECTED_FN_BASE="${EXPECTED_FN_BASE:-${FN_BASE}}"

pass() { echo "[demo-smoke] PASS: $*"; }
fail() { echo "[demo-smoke] FAIL: $*" >&2; exit 1; }

check_http_200() {
  local label="$1"
  local url="$2"
  local out_file
  out_file="$(mktemp /tmp/peakops_demo_smoke.XXXXXX)"
  local code
  code="$(curl -s -o "${out_file}" -w '%{http_code}' "${url}" || true)"
  if [[ "${code}" != "200" ]]; then
    if [[ "${code}" == "000" ]]; then
      rm -f "${out_file}" >/dev/null 2>&1 || true
      fail "${label} curl failed (000) url=${url}"
    fi
    local body
    body="$(head -c 500 "${out_file}" 2>/dev/null || true)"
    rm -f "${out_file}" >/dev/null 2>&1 || true
    fail "${label} http=${code} url=${url} body=${body}"
  fi
  rm -f "${out_file}" >/dev/null 2>&1 || true
  pass "${label}"
}

check_json_ok() {
  local label="$1"
  local url="$2"
  local out_file="$3"
  local code
  code="$(curl -s -o "${out_file}" -w '%{http_code}' "${url}" || true)"
  if [[ "${code}" == "000" ]]; then
    fail "${label} curl failed (000) url=${url}"
  fi
  if [[ "${code}" -lt 200 || "${code}" -gt 299 ]]; then
    local body
    body="$(head -c 500 "${out_file}" 2>/dev/null || true)"
    fail "${label} http=${code} url=${url} body=${body}"
  fi
}

check_post_json_ok() {
  local label="$1"
  local url="$2"
  local body="$3"
  local out_file="$4"
  local code
  code="$(curl -s -o "${out_file}" -w '%{http_code}' -X POST "${url}" -H 'content-type: application/json' -d "${body}" || true)"
  if [[ "${code}" == "000" ]]; then
    fail "${label} curl failed (000) url=${url}"
  fi
  if [[ "${code}" -lt 200 || "${code}" -gt 299 ]]; then
    local body_snip
    body_snip="$(head -c 500 "${out_file}" 2>/dev/null || true)"
    fail "${label} http=${code} url=${url} body=${body_snip}"
  fi
}

[[ -f "${CONFIG_PATH}" ]] || fail "config file not found: ${CONFIG_PATH}"
echo "[demo-smoke] repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} incidentId=${INCIDENT_ID} orgId=${ORG_ID} seedMode=${SEED_MODE}"

ENV_FN_BASE="${NEXT_PUBLIC_FUNCTIONS_BASE:-}"
if [[ -z "${ENV_FN_BASE}" && -f "next-app/.env.local" ]]; then
  ENV_FN_BASE="$(awk -F= '/^NEXT_PUBLIC_FUNCTIONS_BASE=/{print $2; exit}' next-app/.env.local 2>/dev/null || true)"
fi
if [[ -n "${ENV_FN_BASE}" && "${ENV_FN_BASE}" != "${EXPECTED_FN_BASE}" ]]; then
  fail "NEXT_PUBLIC_FUNCTIONS_BASE mismatch: expected=${EXPECTED_FN_BASE} actual=${ENV_FN_BASE}"
fi
if [[ -n "${ENV_FN_BASE}" ]]; then
  pass "NEXT_PUBLIC_FUNCTIONS_BASE=${ENV_FN_BASE}"
fi

check_http_200 "hello" "${FN_BASE}/hello"

check_json_ok "getIncidentV1" "${FN_BASE}/getIncidentV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" "/tmp/peakops_demo_smoke_inc.json"
INC_JSON="$(cat /tmp/peakops_demo_smoke_inc.json 2>/dev/null || true)"
echo "${INC_JSON}" | jq -e '.ok == true and (.incidentId // "") == "'"${INCIDENT_ID}"'"' >/dev/null || fail "getIncidentV1 returned unexpected payload: ${INC_JSON}"
pass "getIncidentV1"

check_json_ok "listJobsV1" "${FN_BASE}/listJobsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=100" "/tmp/peakops_demo_smoke_jobs.json"
JOBS_JSON="$(cat /tmp/peakops_demo_smoke_jobs.json 2>/dev/null || true)"
echo "${JOBS_JSON}" | jq -e '.ok == true and ((.count // 0) == 2) and ((.error // "") != "auth_required")' >/dev/null || fail "listJobsV1 returned unexpected payload: ${JOBS_JSON}"
pass "listJobsV1"

check_json_ok "listEvidenceLocker" "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=100" "/tmp/peakops_demo_smoke_evid.json"
EVID_JSON="$(cat /tmp/peakops_demo_smoke_evid.json 2>/dev/null || true)"
echo "${EVID_JSON}" | jq -e '.ok == true and ((.count // 0) >= 5)' >/dev/null || fail "listEvidenceLocker returned unexpected payload: ${EVID_JSON}"
pass "listEvidenceLocker"
if [[ "${SEED_MODE}" == "review" ]]; then
  UNASSIGNED_COUNT="$(echo "${EVID_JSON}" | jq -r '[.docs[]? | select(((.jobId // .evidence.jobId // .["jobId"] // .["evidence.jobId"] // "") | tostring | length) == 0)] | length' 2>/dev/null || echo 0)"
  if [[ "${UNASSIGNED_COUNT}" -gt 0 ]]; then
    fail "unassigned evidence detected in review mode: ${UNASSIGNED_COUNT}"
  fi
  pass "unassignedEvidence=0"
fi

if [[ -x "scripts/dev/thumb_gate.sh" ]]; then
  if ! bash scripts/dev/thumb_gate.sh >/tmp/peakops_demo_smoke_thumb_gate.out 2>&1; then
    tail -n 120 /tmp/peakops_demo_smoke_thumb_gate.out 2>/dev/null || true
    fail "thumb_gate failed"
  fi
  pass "thumb_gate"
fi

check_http_200 "summary-page" "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/summary"
check_http_200 "review-page" "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/review"
ADD_EVIDENCE_HEAD_HTTP="$(curl -sS -I -o /dev/null -w '%{http_code}' "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/add-evidence" || true)"
if [[ "${ADD_EVIDENCE_HEAD_HTTP}" != "200" ]]; then
  fail "add-evidence-page-head http=${ADD_EVIDENCE_HEAD_HTTP} url=http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/add-evidence"
fi
pass "add-evidence-page-head"

ART_URL="http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentArtifactV1"
ART_BODY="{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\"}"
check_post_json_ok "artifact-export" "${ART_URL}" "${ART_BODY}" "/tmp/peakops_demo_smoke_artifact.json"
ART_JSON="$(cat /tmp/peakops_demo_smoke_artifact.json 2>/dev/null || true)"
echo "${ART_JSON}" | jq -e '.ok == true and ((.filename // "") | contains("'"${INCIDENT_ID}"'")) and ((.base64Zip // "") | length > 1000)' >/dev/null || fail "artifact export payload unexpected: ${ART_JSON}"
pass "artifact-export"

REVIEWABLE_COUNT="$(echo "${JOBS_JSON}" | jq -r '[.docs[]? | select(((.status // "") | ascii_downcase) == "complete" and ((.reviewStatus // "none") | ascii_downcase) != "approved")] | length' 2>/dev/null || echo 0)"
if [[ "${SEED_MODE}" == "review" ]]; then
  if [[ "${REVIEWABLE_COUNT}" -lt 2 ]]; then
    fail "expected at least 2 reviewables from listJobsV1, got ${REVIEWABLE_COUNT}"
  fi
  pass "reviewables>=2"
else
  ACTIVE_COUNT="$(echo "${JOBS_JSON}" | jq -r '[.docs[]? | select(((.status // "") | ascii_downcase) == "open" or ((.status // "") | ascii_downcase) == "in_progress" or ((.status // "") | ascii_downcase) == "assigned")] | length' 2>/dev/null || echo 0)"
  if [[ "${ACTIVE_COUNT}" -lt 2 ]]; then
    fail "expected at least 2 active jobs for interactive mode, got ${ACTIVE_COUNT}"
  fi
  pass "activeJobs>=2"
fi

echo "[demo-smoke] PASS ✅"
