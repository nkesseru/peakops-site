#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FUNCTIONS_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
HELLO_URL="${FUNCTIONS_BASE}/hello"
HEALTH_URL="${FUNCTIONS_BASE}/healthzV1"
EMU_LOG="${EMU_LOG:-/tmp/peakops/demo_up_emulators.log}"
NEXT_LOG="${NEXT_LOG:-/tmp/peakops/demo_up_next.log}"

echo "[stack-doctor] repoRoot=${REPO_ROOT}"
echo "[stack-doctor] configPath=${REPO_ROOT}/firebase.json"
echo "[stack-doctor] env GCLOUD_PROJECT=${GCLOUD_PROJECT:-}"
echo "[stack-doctor] env FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-}"
echo "[stack-doctor] env FIREBASE_STORAGE_EMULATOR_HOST=${FIREBASE_STORAGE_EMULATOR_HOST:-}"
echo "[stack-doctor] env FIREBASE_STORAGE_BUCKET=${FIREBASE_STORAGE_BUCKET:-}"
echo "[stack-doctor] env STORAGE_BUCKET=${STORAGE_BUCKET:-}"

layer_fail=""
for p in 3001 5004 8087 9199 4415 4005; do
  if lsof -nP -iTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[stack-doctor] PORT ${p} LISTEN"
    lsof -nP -iTCP:"${p}" -sTCP:LISTEN | sed -n '1,3p'
  else
    echo "[stack-doctor] PORT ${p} NOT_LISTEN"
    if [[ -z "${layer_fail}" ]]; then
      layer_fail="ports"
    fi
  fi
done

hello_file="$(mktemp /tmp/peakops_stack_doctor_hello.XXXXXX)"
hello_code="$(curl -sS -o "${hello_file}" -w '%{http_code}' "${HELLO_URL}" || true)"
echo "[stack-doctor] hello_http=${hello_code} url=${HELLO_URL}"
sed -n '1,20p' "${hello_file}" || true
if [[ "${hello_code}" != "200" && -z "${layer_fail}" ]]; then
  layer_fail="function_registration"
fi

health_file="$(mktemp /tmp/peakops_stack_doctor_health.XXXXXX)"
health_code="$(curl -sS -o "${health_file}" -w '%{http_code}' "${HEALTH_URL}" || true)"
echo "[stack-doctor] health_http=${health_code} url=${HEALTH_URL}"
sed -n '1,40p' "${health_file}" || true
if [[ "${health_code}" != "200" && -z "${layer_fail}" ]]; then
  layer_fail="function_registration"
fi

rm -f "${hello_file}" "${health_file}"

if [[ -f "${EMU_LOG}" ]]; then
  echo "[stack-doctor] emulator_log_tail=${EMU_LOG}"
  tail -n 120 "${EMU_LOG}" || true
else
  echo "[stack-doctor] emulator_log_missing=${EMU_LOG}"
fi

if [[ -f "${NEXT_LOG}" ]]; then
  echo "[stack-doctor] next_log_tail=${NEXT_LOG}"
  tail -n 120 "${NEXT_LOG}" || true
else
  echo "[stack-doctor] next_log_missing=${NEXT_LOG}"
fi

if [[ -z "${layer_fail}" ]]; then
  echo "[stack-doctor] layer=ok"
else
  echo "[stack-doctor] layer=${layer_fail}"
fi
