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

say(){ echo "[boot-demo] $*"; }
fail(){ echo "[boot-demo] FAIL: $*" >&2; exit 1; }

[[ -f "${CONFIG_PATH}" ]] || fail "config file not found: ${CONFIG_PATH}"
say "repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} nextPort=${NEXT_PORT}"

wait_port() {
  local port="$1" timeout="${2:-60}"
  for _ in $(seq 1 "$timeout"); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$1" || true; }

say "Hard-killing stale emulators / ports"
bash scripts/dev/kill_emulators_harder.sh || true

EMU_LOG="/tmp/peakops_boot_demo_emulators.log"
NEXT_LOG="/tmp/peakops_boot_demo_next.log"
: > "${EMU_LOG}"
: > "${NEXT_LOG}"

say "Starting emulators (functions,firestore,storage,ui)"
nohup firebase emulators:start \
  --project "$PROJECT_ID" \
  --config "$CONFIG_PATH" \
  --only functions,firestore,storage,ui \
  >"${EMU_LOG}" 2>&1 &

say "Waiting for required ports..."
wait_port 4415 60 || { tail -n 120 "${EMU_LOG}" || true; fail "hub (4415) not listening"; }
wait_port 4005 60 || { tail -n 120 "${EMU_LOG}" || true; fail "ui (4005) not listening"; }
wait_port 5004 60 || { tail -n 120 "${EMU_LOG}" || true; fail "functions (5004) not listening"; }
wait_port 8087 60 || { tail -n 120 "${EMU_LOG}" || true; fail "firestore (8087) not listening"; }
wait_port 9199 60 || { tail -n 120 "${EMU_LOG}" || true; fail "storage (9199) not listening"; }

say "Probing functions /hello"
# Why: "Serving at port 8xxx" is the worker runtime port; 5004 is the emulator proxy port.
HELLO_URL="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello"
for _ in $(seq 1 60); do
  [[ "$(http_code "${HELLO_URL}")" == "200" ]] && break
  sleep 1
done
[[ "$(http_code "${HELLO_URL}")" == "200" ]] || { tail -n 120 "${EMU_LOG}" || true; fail "/hello not 200"; }

say "Starting Next dev server"
nohup pnpm run next:restart >"${NEXT_LOG}" 2>&1 &
wait_port "${NEXT_PORT}" 60 || { tail -n 200 "${NEXT_LOG}" || true; fail "next not listening on ${NEXT_PORT}"; }

say "Seeding demo/reset"
bash scripts/dev/reset_demo.sh

say "PASS ✅ demo boot complete"
say "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo"
say "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/review"
say "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/summary"
say "Logs: ${EMU_LOG} | ${NEXT_LOG}"
say "Self-test: cd ~ && bash ${REPO_ROOT}/scripts/dev/boot_demo_clean.sh"
