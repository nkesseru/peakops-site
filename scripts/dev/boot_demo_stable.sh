#!/usr/bin/env bash
set -euo pipefail
# DEPRECATED: use scripts/dev/demo_up.sh

# Always resolve repo root even if run from ~
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
NEXT_PORT="${NEXT_PORT:-3001}"

CONFIG_PATH="${REPO_ROOT}/firebase.json"
[[ -f "${CONFIG_PATH}" ]] || { echo "[boot-demo] FAIL: missing ${CONFIG_PATH}"; exit 1; }

LOG_DIR="/tmp/peakops"
EMU_LOG="${LOG_DIR}/boot_demo_emulators.log"
NEXT_LOG="${LOG_DIR}/boot_demo_next.log"
mkdir -p "${LOG_DIR}"

say(){ echo "[boot-demo] $*"; }
fail(){ echo "[boot-demo] FAIL: $*" >&2; exit 1; }

wait_port(){
  local port="$1" timeout="${2:-60}"
  for _ in $(seq 1 "$timeout"); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

http_code(){
  local url="$1"
  curl -s -o /dev/null -w '%{http_code}' "$url" || echo "000"
}

# 0) Kill drift
say "Hard-killing drift"
bash "${REPO_ROOT}/scripts/dev/kill_drift_hard.sh" || true

# 1) Start emulators with ABSOLUTE config (no drift)
rm -f "${EMU_LOG}"
say "Starting emulators w/ config=${CONFIG_PATH}"
nohup firebase emulators:start \
  --project "${PROJECT_ID}" \
  --config "${CONFIG_PATH}" \
  --only functions,firestore,storage,ui \
  >"${EMU_LOG}" 2>&1 &

# 2) Wait for expected ports
say "Waiting for ports (hub/ui/functions/firestore/storage)…"
wait_port 4415 60 || { tail -n 120 "${EMU_LOG}" || true; fail "hub 4415 not listening"; }
wait_port 4005 60 || { tail -n 120 "${EMU_LOG}" || true; fail "ui 4005 not listening"; }
wait_port 8087 60 || { tail -n 120 "${EMU_LOG}" || true; fail "firestore 8087 not listening"; }
wait_port 9199 60 || { tail -n 120 "${EMU_LOG}" || true; fail "storage 9199 not listening"; }

# Important: functions port must be 5004. If not, config didn't load.
if ! wait_port 5004 60; then
  say "Functions did not bind 5004. This usually means firebase.json wasn’t loaded or port is stolen."
  tail -n 160 "${EMU_LOG}" || true
  fail "functions 5004 not listening"
fi

# 3) Probe /hello on pinned base
HELLO="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello"
say "Probing /hello -> ${HELLO}"
[[ "$(http_code "${HELLO}")" == "200" ]] || { tail -n 160 "${EMU_LOG}" || true; fail "/hello not 200"; }

# 4) Probe storage REST
say "Probing storage REST"
[[ "$(http_code "http://127.0.0.1:9199/storage/v1/b")" != "000" ]] || { tail -n 160 "${EMU_LOG}" || true; fail "storage REST not reachable"; }

# 5) Start Next
rm -f "${NEXT_LOG}"
say "Starting Next on :${NEXT_PORT}"
nohup pnpm run next:restart >"${NEXT_LOG}" 2>&1 &
wait_port "${NEXT_PORT}" 90 || { tail -n 160 "${NEXT_LOG}" || true; fail "Next not listening on ${NEXT_PORT}"; }

# 6) Seed/reset
say "Running reset_demo"
bash "${REPO_ROOT}/scripts/dev/reset_demo.sh"

echo
echo "===== PASS ✅ Demo booted ====="
echo "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}"
echo "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/review"
echo "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/summary"
echo "Emu log:  ${EMU_LOG}"
echo "Next log: ${NEXT_LOG}"
echo "==============================="
