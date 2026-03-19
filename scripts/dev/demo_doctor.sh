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
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/firebase.json"
fi
FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
EXPECTED_BASE="${FN_BASE}"

[[ -f "${CONFIG_PATH}" ]] || { echo "[demo-doctor] FAIL: config file not found: ${CONFIG_PATH}" >&2; exit 1; }
echo "[demo-doctor] pwd=$(pwd)"
echo "[demo-doctor] repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} incidentId=${INCIDENT_ID}"
echo "[demo-doctor] listeners:"
for p in 3001 4005 4415 4505 5004 8087 9154 9199; do
  echo "--- port ${p}"
  if lsof -nP -iTCP:${p} -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -nP -iTCP:${p} -sTCP:LISTEN || true
  else
    echo "[demo-doctor] port ${p} not listening"
  fi
done

probe() {
  local label="$1"
  local url="$2"
  local code
  code="$(curl -s -o /tmp/peakops_demo_doctor.out -w '%{http_code}' "${url}" || true)"
  echo "[demo-doctor] ${label} http=${code} url=${url}"
  if [[ "${code}" -ge 200 && "${code}" -le 299 ]]; then
    head -c 200 /tmp/peakops_demo_doctor.out 2>/dev/null || true
    echo
  fi
}

probe "hello" "${FN_BASE}/hello"
probe "storage" "http://127.0.0.1:9199/storage/v1/b/peakops-pilot.firebasestorage.app/o?pageSize=1"
probe "incident-page" "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}"
probe "review-page" "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/review"
probe "summary-page" "http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/summary"

ENV_BASE="$(awk -F= '/^NEXT_PUBLIC_FUNCTIONS_BASE=/{print $2}' next-app/.env.local 2>/dev/null | tail -n1 | tr -d '"' | tr -d "'" | xargs || true)"
echo "[demo-doctor] NEXT_PUBLIC_FUNCTIONS_BASE=${ENV_BASE:-<unset>}"
if [[ -n "${ENV_BASE}" && "${ENV_BASE}" != "${EXPECTED_BASE}" ]]; then
  echo "[demo-doctor] WARN: NEXT_PUBLIC_FUNCTIONS_BASE expected ${EXPECTED_BASE}"
fi

echo "[demo-doctor] tip: clear stale fallback in browser DevTools:"
echo "sessionStorage.removeItem(\"peakops_functions_base_override\"); location.reload();"
