#!/usr/bin/env bash
set -euo pipefail
# DEPRECATED: use scripts/dev/demo_up.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
NEXT_PORT="${NEXT_PORT:-3001}"
ENV_LOCAL="${REPO_ROOT}/next-app/.env.local"
EMU_LOG="/tmp/peakops_boot_autodiscover_emulators.log"
NEXT_LOG="/tmp/peakops_boot_autodiscover_next.log"

if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/${CONFIG_FILE}"
fi

say(){ echo "[boot-autodiscover] $*"; }
fail(){ echo "[boot-autodiscover] FAIL: $*" >&2; exit 1; }

wait_port() {
  local port="$1" timeout="${2:-60}"
  local i=0
  while (( i < timeout )); do
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

wait_hello() {
  local url="$1" timeout="${2:-60}" i=0
  while (( i < timeout )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "${url}" || true)"
    [[ "${code}" == "200" ]] && return 0
    sleep 1
    i=$((i+1))
  done
  return 1
}

[[ -f "${CONFIG_PATH}" ]] || fail "config file not found: ${CONFIG_PATH}"
mkdir -p /tmp/peakops
say "repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} nextPort=${NEXT_PORT}"

say "Hard cleanup"
bash scripts/dev/kill_emulators_harder.sh || true

say "Starting emulators (functions,firestore,storage,ui)"
: > "${EMU_LOG}"
nohup firebase emulators:start \
  --project "${PROJECT_ID}" \
  --config "${CONFIG_PATH}" \
  --only functions,firestore,storage,ui \
  >"${EMU_LOG}" 2>&1 &

wait_port 8087 60 || { tail -n 120 "${EMU_LOG}" || true; fail "firestore 8087 not listening"; }
wait_port 9199 60 || { tail -n 120 "${EMU_LOG}" || true; fail "storage 9199 not listening"; }
wait_port 4005 60 || { tail -n 120 "${EMU_LOG}" || true; fail "ui 4005 not listening"; }
wait_port 5004 60 || { tail -n 120 "${EMU_LOG}" || true; fail "functions proxy 5004 not listening"; }

HELLO_URL="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello"
say "Probing functions readiness: ${HELLO_URL}"
if ! wait_hello "${HELLO_URL}" 60; then
  tail -n 160 "${EMU_LOG}" || true
  fail "/hello did not return 200 on functions proxy 5004"
fi

FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
say "Using NEXT_PUBLIC_FUNCTIONS_BASE=${FN_BASE}"

TMP_ENV="$(mktemp)"
if [[ -f "${ENV_LOCAL}" ]]; then
  awk '!/^NEXT_PUBLIC_FUNCTIONS_BASE=/' "${ENV_LOCAL}" > "${TMP_ENV}"
fi
echo "NEXT_PUBLIC_FUNCTIONS_BASE=${FN_BASE}" >> "${TMP_ENV}"
mv "${TMP_ENV}" "${ENV_LOCAL}"

say "Starting Next dev server"
: > "${NEXT_LOG}"
nohup pnpm run next:restart >"${NEXT_LOG}" 2>&1 &
wait_port "${NEXT_PORT}" 60 || { tail -n 120 "${NEXT_LOG}" || true; fail "next ${NEXT_PORT} not listening"; }

say "Running reset_demo"
bash scripts/dev/reset_demo.sh

echo
echo "===== PASS ✅ Demo autodiscover boot complete ====="
echo "Functions base: ${FN_BASE}"
echo "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo"
echo "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/review"
echo "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/summary"
echo "Logs: ${EMU_LOG} | ${NEXT_LOG}"
echo "=============================================="
