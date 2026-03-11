#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_PATH="${CONFIG_FILE:-${REPO_ROOT}/firebase.json}"
FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
LOG_FILE="/tmp/peakops/fn_only.log"
REQ_FNS='["hello","healthzV1","listEvidenceLocker","createEvidenceReadUrlV1","uploadEvidenceProxyV1"]'

say() { echo "[fn-only-smoke] $*"; }
fail() { echo "[fn-only-smoke] FAIL: $*" >&2; exit 1; }

mkdir -p /tmp/peakops

start_once() {
  say "killing stale listeners/processes"
  for p in 4415 4005 4505 5004; do
    pids="$(lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
    if [[ -n "${pids}" ]]; then
      kill -9 ${pids} >/dev/null 2>&1 || true
    fi
  done
  pkill -f "firebase emulators:start" >/dev/null 2>&1 || true
  pkill -f "firebase-tools" >/dev/null 2>&1 || true
  sleep 1

  bash scripts/dev/fix_functions_env_and_bootstrap.sh >/tmp/peakops/fn_only_fix_env.log 2>&1 || {
    cat /tmp/peakops/fn_only_fix_env.log || true
    fail "fix_functions_env_and_bootstrap failed"
  }

  export GCLOUD_PROJECT="${GCLOUD_PROJECT:-${PROJECT_ID}}"
  export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-${PROJECT_ID}}"
  export FIREBASE_STORAGE_EMULATOR_HOST="${FIREBASE_STORAGE_EMULATOR_HOST:-127.0.0.1:9199}"
  export FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-${PROJECT_ID}.appspot.com}"
  export STORAGE_BUCKET="${STORAGE_BUCKET:-${PROJECT_ID}.appspot.com}"

  : > "${LOG_FILE}"
  say "starting functions emulator"
  nohup firebase emulators:start --only functions --project "${PROJECT_ID}" --config "${CONFIG_PATH}" > "${LOG_FILE}" 2>&1 &

  for _ in $(seq 1 60); do
    if lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1 || { tail -n 200 "${LOG_FILE}" || true; fail "port 5004 not listening"; }

  local hello_file hello_code
  hello_file="$(mktemp /tmp/peakops_fn_hello.XXXXXX)"
  for _ in $(seq 1 60); do
    hello_code="$(curl -sS -o "${hello_file}" -w '%{http_code}' "${FN_BASE}/hello" || true)"
    if [[ "${hello_code}" == "200" ]]; then
      break
    fi
    sleep 0.25
  done
  if [[ "${hello_code}" != "200" ]]; then
    tail -n 200 "${LOG_FILE}" || true
    sed -n '1,40p' "${hello_file}" || true
    rm -f "${hello_file}"
    fail "/hello http=${hello_code}"
  fi
  rm -f "${hello_file}"

  local health_file health_code
  health_file="$(mktemp /tmp/peakops_fn_health.XXXXXX)"
  health_code="$(curl -sS -o "${health_file}" -w '%{http_code}' "${FN_BASE}/healthzV1" || true)"
  if [[ "${health_code}" != "200" ]]; then
    tail -n 200 "${LOG_FILE}" || true
    sed -n '1,60p' "${health_file}" || true
    rm -f "${health_file}"
    fail "/healthzV1 http=${health_code}"
  fi
  jq -e --argjson req "${REQ_FNS}" '.ok == true and ((.functions // []) as $f | all($req[]; ($f | index(.)) != null))' "${health_file}" >/dev/null || {
    sed -n '1,120p' "${health_file}" || true
    rm -f "${health_file}"
    fail "healthzV1 missing required handlers"
  }
  rm -f "${health_file}"
}

say "run 1/2"
start_once
say "run 2/2"
start_once
say "PASS"
