#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
NEXT_PORT="${NEXT_PORT:-3001}"
SEED_MODE="${SEED_MODE:-interactive}"
if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/firebase.json"
fi

LOG_DIR="/tmp/peakops"
EMU_LOG="${LOG_DIR}/demo_up_emulators.log"
NEXT_LOG="${LOG_DIR}/demo_up_next.log"

say(){ echo "[demo-up] $*"; }
die(){ echo "[demo-up] FAIL: $*" >&2; exit 1; }

dump_diag() {
  echo "[demo-up] ----- emulator log tail -----" >&2
  tail -n 200 "${EMU_LOG}" 2>/dev/null >&2 || true
  echo "[demo-up] ----- port listeners -----" >&2
  for p in 4415 4005 4505 5004 8087 9154 9199 3001; do
    echo "[demo-up] port ${p}" >&2
    lsof -nP -iTCP:${p} -sTCP:LISTEN >&2 || true
  done
}

quarantine_functions_env() {
  local fc_dir="${REPO_ROOT}/functions_clean"
  local qdir="/tmp/peakops/env_quarantine_$(date +%Y%m%d_%H%M%S)"
  mkdir -p "${qdir}"
  shopt -s nullglob dotglob
  for entry in "${fc_dir}"/.env*; do
    local base
    base="$(basename "${entry}")"
    [[ "${base}" == "." || "${base}" == ".." ]] && continue
    mv "${entry}" "${qdir}/${base}"
  done
  shopt -u nullglob dotglob
  say "Quarantined functions_clean/.env* -> ${qdir}"
}

[[ -f "${CONFIG_PATH}" ]] || die "config file not found: ${CONFIG_PATH}"
mkdir -p "${LOG_DIR}"
say "repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} nextPort=${NEXT_PORT} seedMode=${SEED_MODE}"
HELLO_URL="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello"

probe_hello_once() {
  local body_file code
  body_file="$(mktemp /tmp/peakops_demo_up_hello_probe.XXXXXX)"
  code="$(curl -sS -o "${body_file}" -w '%{http_code}' "${HELLO_URL}" || true)"
  if [[ "${code}" == "200" ]] && grep -qi "hello" "${body_file}" 2>/dev/null; then
    rm -f "${body_file}"
    return 0
  fi
  rm -f "${body_file}"
  return 1
}

wait_hello_ready() {
  local i
  for i in $(seq 1 40); do
    if probe_hello_once; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

say "Killing stale ports/processes"
bash scripts/dev/nuke_emulators.sh || true

say "Quarantining functions dotenv files"
quarantine_functions_env

say "Starting emulators (functions,firestore,storage,ui)"
: > "${EMU_LOG}"
export GCLOUD_PROJECT="${GCLOUD_PROJECT:-${PROJECT_ID}}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-${PROJECT_ID}}"
export FIREBASE_STORAGE_EMULATOR_HOST="${FIREBASE_STORAGE_EMULATOR_HOST:-127.0.0.1:9199}"
export FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-${PROJECT_ID}.appspot.com}"
export STORAGE_BUCKET="${STORAGE_BUCKET:-${PROJECT_ID}.appspot.com}"
export FUNCTIONS_EMULATOR="${FUNCTIONS_EMULATOR:-true}"
nohup firebase emulators:start \
  --project "${PROJECT_ID}" \
  --config "${CONFIG_PATH}" \
  --only functions,firestore,storage,ui \
  >"${EMU_LOG}" 2>&1 &

echo "[demo-up] hub 4415 check skipped (non-fatal in this local stack)"
wait_port 4005 60 || { dump_diag; die "ui 4005 not listening"; }
wait_port 5004 60 || { dump_diag; die "functions proxy 5004 not listening"; }
wait_port 8087 60 || { dump_diag; die "firestore 8087 not listening"; }
wait_port 9199 60 || { dump_diag; die "storage 9199 not listening"; }

say "Probing functions /hello: ${HELLO_URL}"
wait_hello_ready || {
  curl -sS -i "${HELLO_URL}" | sed -n '1,15p' >&2 || true
  dump_diag
  die "/hello not 200 on functions proxy"
}
HEALTH_URL="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/healthzV1"
health_ok="0"
for _ in $(seq 1 40); do
  health_file="$(mktemp /tmp/peakops_demo_up_health.XXXXXX)"
  health_code="$(curl -sS -o "${health_file}" -w '%{http_code}' "${HEALTH_URL}" || true)"
  if [[ "${health_code}" == "200" ]] && jq -e '.ok == true and ((.functions // []) | index("hello") != null) and ((.functions // []) | index("listEvidenceLocker") != null) and ((.functions // []) | index("createEvidenceReadUrlV1") != null) and ((.functions // []) | index("uploadEvidenceProxyV1") != null)' "${health_file}" >/dev/null 2>&1; then
    health_ok="1"
    rm -f "${health_file}"
    break
  fi
  rm -f "${health_file}"
  sleep 0.25
done
[[ "${health_ok}" == "1" ]] || { dump_diag; die "healthzV1 missing required handlers"; }

say "Starting Next dev server"
: > "${NEXT_LOG}"
nohup pnpm run next:restart >"${NEXT_LOG}" 2>&1 &
wait_port "${NEXT_PORT}" 60 || { tail -n 160 "${NEXT_LOG}" || true; die "next ${NEXT_PORT} not listening"; }

say "Running deterministic reset (seed-only mode)"
SEED_MODE="${SEED_MODE}" MODE=seed-only bash scripts/dev/reset_demo.sh

say "Smoke checks"
curl -sf "http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello" >/dev/null || die "smoke: hello failed"
JOBS_JSON="$(curl -sf "http://127.0.0.1:5004/${PROJECT_ID}/us-central1/listJobsV1?orgId=riverbend-electric&incidentId=inc_demo")" || die "smoke: listJobsV1 failed"
echo "${JOBS_JSON}" | jq -e '.ok == true and (.count|tonumber) == 2' >/dev/null || die "smoke: listJobsV1 expected ok:true,count:2"
curl -sf "http://127.0.0.1:5004/${PROJECT_ID}/us-central1/listEvidenceLocker?orgId=riverbend-electric&incidentId=inc_demo" >/dev/null || die "smoke: listEvidenceLocker failed"
curl -sf -o /dev/null "http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo" || die "smoke: incident page failed"
curl -sf -o /dev/null "http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/review" || die "smoke: review page failed"
curl -sf -o /dev/null "http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/summary" || die "smoke: summary page failed"

echo
echo "===== PASS ✅ Demo up ====="
echo "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo"
echo "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/review"
echo "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/summary"
echo "Logs: ${EMU_LOG} | ${NEXT_LOG}"
echo "==========================="
