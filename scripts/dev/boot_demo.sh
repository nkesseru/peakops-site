#!/usr/bin/env bash
set -euo pipefail
# DEPRECATED: use scripts/dev/demo_up.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
NEXT_PORT="${NEXT_PORT:-3001}"

if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/${CONFIG_FILE}"
fi

LOG_DIR="/tmp/peakops"
EMU_LOG="${LOG_DIR}/boot_demo_emulators.log"
NEXT_LOG="${LOG_DIR}/boot_demo_next.log"

say(){ echo "[boot-demo] $*"; }
fail(){ echo "[boot-demo] FAIL: $*" >&2; exit 1; }

wait_port() {
  local port="$1" timeout="${2:-60}" i=0
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
mkdir -p "${LOG_DIR}"
say "repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} nextPort=${NEXT_PORT}"

say "Killing stale demo ports/processes"
bash scripts/dev/kill_demo_ports.sh || true

say "Starting emulators (functions,firestore,storage,ui)"
: > "${EMU_LOG}"
nohup firebase emulators:start \
  --project "${PROJECT_ID}" \
  --config "${CONFIG_PATH}" \
  --only functions,firestore,storage,ui \
  >"${EMU_LOG}" 2>&1 &

wait_port 4415 60 || { tail -n 120 "${EMU_LOG}" || true; fail "hub 4415 not listening"; }
wait_port 4005 60 || { tail -n 120 "${EMU_LOG}" || true; fail "ui 4005 not listening"; }
wait_port 5004 60 || { tail -n 120 "${EMU_LOG}" || true; fail "functions proxy 5004 not listening"; }
wait_port 8087 60 || { tail -n 120 "${EMU_LOG}" || true; fail "firestore 8087 not listening"; }
wait_port 9199 60 || { tail -n 120 "${EMU_LOG}" || true; fail "storage 9199 not listening"; }

HELLO_URL="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello"
say "Probing functions readiness: ${HELLO_URL}"
if ! wait_hello "${HELLO_URL}" 60; then
  tail -n 160 "${EMU_LOG}" || true
  fail "/hello did not return 200 on functions proxy 5004"
fi

say "Starting Next dev server"
: > "${NEXT_LOG}"
nohup pnpm run next:restart >"${NEXT_LOG}" 2>&1 &
wait_port "${NEXT_PORT}" 60 || { tail -n 160 "${NEXT_LOG}" || true; fail "next ${NEXT_PORT} not listening"; }

say "Running reset demo"
bash scripts/dev/reset_demo.sh

echo
echo "===== PASS ✅ Demo boot complete ====="
echo "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo"
echo "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/review"
echo "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/summary"
echo "Logs: ${EMU_LOG} | ${NEXT_LOG}"
echo "======================================"
