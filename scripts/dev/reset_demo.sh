#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
MODE="${MODE:-full}"
SEED_MODE="${SEED_MODE:-review}"

PORTS=(4415 4005 4505 5004 8087 9154 9199 8253)
NEXT_PORT=3001
if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/firebase.json"
fi

LOG_DIR="/tmp/peakops"
EMU_LOG="${LOG_DIR}/reset_demo_emulators.log"
NEXT_LOG="${LOG_DIR}/reset_demo_next.log"
LAST_FAIL=""

say() { echo "[reset-demo] $*"; }
fail() {
  LAST_FAIL="$*"
  echo "[reset-demo] FAIL: ${LAST_FAIL}" >&2
}

require_cmd() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || { fail "missing required command: ${cmd}"; exit 1; }
}

wait_for_port() {
  local port="$1"
  local timeout="${2:-30}"
  local i=0
  while (( i < timeout )); do
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

ensure_port_clear() {
  local port="$1"
  local timeout="${2:-8}"
  local i=0
  while (( i < timeout )); do
    local still
    still="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2, $1}' | head -n 1 || true)"
    if [[ -z "${still}" ]]; then
      return 0
    fi
    kill_port "${port}"
    sleep 1
    i=$((i+1))
  done
  return 1
}

wait_for_http_code() {
  local url="$1"
  local expected="$2"
  local timeout="${3:-30}"
  local i=0
  while (( i < timeout )); do
    local code
    code="$(curl -s -o /tmp/peakops_reset_http_probe.out -w '%{http_code}' "${url}" || true)"
    if [[ "${code}" == "${expected}" ]]; then
      return 0
    fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

wait_for_backfill_non_404() {
  local base_url="$1"
  local timeout="${2:-30}"
  local i=0
  local last_code="000"
  while (( i < timeout )); do
    local code
    code="$(
      curl -s -o /tmp/peakops_reset_backfill_probe.out -w '%{http_code}' \
        -X POST "${base_url}/backfillEvidenceJobIdV1" \
        -H 'content-type: application/json' \
        -d '{}' || true
    )"
    last_code="${code}"
    if [[ "${code}" != "404" && "${code}" != "000" ]]; then
      return 0
    fi
    sleep 1
    i=$((i+1))
  done
  echo "${last_code}" >/tmp/peakops_reset_backfill_last_code.txt
  return 1
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    say "Killing port ${port} PID(s): ${pids}"
    # best effort
    kill -9 ${pids} >/dev/null 2>&1 || true
  fi
}

stop_emulator_processes() {
  # best effort process purge
  if [[ "${KEEP_EMUS:-0}" != "1" ]]; then
pkill -f "firebase emulators" >/dev/null 2>&1 || true
fi
  if [[ "${KEEP_EMUS:-0}" != "1" ]]; then
pkill -f firebase-tools >/dev/null 2>&1 || true
fi
  pkill -f "functions-framework" >/dev/null 2>&1 || true
  if [[ "${KEEP_EMUS:-0}" != "1" ]]; then
pkill -f "firebase.*emulator" >/dev/null 2>&1 || true
fi
  pkill -f "java.*emulator" >/dev/null 2>&1 || true
  if [[ "${KEEP_EMUS:-0}" != "1" ]]; then
pkill -f "node.*firebase" >/dev/null 2>&1 || true
fi
}

print_fail_banner() {
  echo
  echo "===== FAIL ❌ Demo reset failed ====="
  if [[ -n "${LAST_FAIL}" ]]; then
    echo "Reason: ${LAST_FAIL}"
  fi
  if [[ -f "${EMU_LOG}" ]]; then
    echo "--- Emulator log tail (last 40) ---"
    tail -n 40 "${EMU_LOG}" || true
    echo "-----------------------------------"
  fi
  echo "Next actions:"
  echo "1) Check emulator log: ${EMU_LOG}"
  echo "2) Check next log: ${NEXT_LOG}"
  echo "3) Re-run: bash scripts/dev/reset_demo.sh"
  echo "===================================="
}

print_pass_banner() {
  echo
  echo "===== PASS ✅ Demo is ready ====="
  echo "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}"
  echo "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/review"
  echo "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/${INCIDENT_ID}/summary"
  echo "Logs: ${EMU_LOG} | ${NEXT_LOG}"
  echo "================================="
}

require_cmd lsof
require_cmd curl
require_cmd jq
require_cmd firebase
require_cmd pnpm
require_cmd bash
[[ -f "${CONFIG_PATH}" ]] || { fail "config file not found: ${CONFIG_PATH}"; print_fail_banner; exit 1; }
say "repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} nextPort=${NEXT_PORT}"
say "mode=${MODE}"
say "seedMode=${SEED_MODE}"

mkdir -p "${LOG_DIR}"

if [[ "${MODE}" != "seed-only" ]]; then
  say "Stopping stale emulators/processes"
  stop_emulator_processes
  for p in "${PORTS[@]}"; do
    kill_port "${p}"
  done

  say "Verifying known ports are clear after cleanup"
  for p in "${PORTS[@]}"; do
    if ! ensure_port_clear "${p}" 8; then
      still="$(lsof -nP -iTCP:"${p}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2, $1}' | head -n 1 || true)"
      fail "port ${p} still in use by ${still}"
      print_fail_banner
      exit 1
    fi
  done

  say "Verifying functions emulator port 5004 is free"
  FNS_STILL="$(lsof -nP -iTCP:5004 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2, $1}' || true)"
  if [[ -n "${FNS_STILL}" ]]; then
    fail "port 5004 occupied: ${FNS_STILL}"
    print_fail_banner
    exit 1
  fi

  say "Verifying critical emulator ports are free after purge"
  for p in 4415 5004 8087 9154 9199; do
    if lsof -nP -iTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "critical port ${p} still in use after purge"
      lsof -nP -iTCP:"${p}" -sTCP:LISTEN || true
      print_fail_banner
      exit 1
    fi
  done

  EMU_ONLY="functions,firestore,storage,ui"
  ATTEMPT=1
  while (( ATTEMPT <= 2 )); do
    : > "${EMU_LOG}"
    say "Starting emulators (${EMU_ONLY}) attempt=${ATTEMPT}"
    nohup firebase emulators:start \
      --project "${PROJECT_ID}" \
      --config "${CONFIG_PATH}" \
      --only "${EMU_ONLY}" \
      >"${EMU_LOG}" 2>&1 &

    if ! wait_for_port 5004 45; then
      fail "functions emulator proxy port 5004 not listening"
      echo "--- lsof 5004 ---"
      lsof -nP -iTCP:5004 -sTCP:LISTEN || true
      tail -n 120 "${EMU_LOG}" || true
      if (( ATTEMPT < 2 )); then
        stop_emulator_processes
        ATTEMPT=$((ATTEMPT+1))
        continue
      fi
      print_fail_banner
      exit 1
    fi
    if ! wait_for_port 8087 45; then
      fail "firestore emulator port 8087 not listening"
      tail -n 120 "${EMU_LOG}" || true
      if (( ATTEMPT < 2 )); then
        stop_emulator_processes
        ATTEMPT=$((ATTEMPT+1))
        continue
      fi
      print_fail_banner
      exit 1
    fi
    if ! wait_for_port 9199 45; then
      fail "storage emulator port 9199 not listening"
      tail -n 120 "${EMU_LOG}" || true
      if (( ATTEMPT < 2 )); then
        stop_emulator_processes
        ATTEMPT=$((ATTEMPT+1))
        continue
      fi
      print_fail_banner
      exit 1
    fi
    if ! wait_for_http_code "http://127.0.0.1:5004/${PROJECT_ID}/us-central1/healthzV1" "200" 60; then
  fail "functions readiness failed: /healthzV1 did not return 200 on proxy port 5004"
      tail -n 120 "${EMU_LOG}" || true
      if (( ATTEMPT < 2 )); then
        stop_emulator_processes
        ATTEMPT=$((ATTEMPT+1))
        continue
      fi
      print_fail_banner
      exit 1
    fi
    break
  done
else
  say "MODE=seed-only: expecting emulators + next already running"
  wait_for_port 5004 45 || { fail "functions proxy 5004 not listening"; print_fail_banner; exit 1; }
  wait_for_port 8087 45 || { fail "firestore 8087 not listening"; print_fail_banner; exit 1; }
  wait_for_port 9199 45 || { fail "storage 9199 not listening"; print_fail_banner; exit 1; }
  if ! wait_for_http_code "http://127.0.0.1:5004/${PROJECT_ID}/us-central1/healthzV1" "200" 60; then
  fail "functions readiness failed: /healthzV1 did not return 200 on proxy port 5004"
    print_fail_banner
    exit 1
  fi
fi

FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
say "Using FN_BASE=${FN_BASE}"

say "Waiting for backfillEvidenceJobIdV1 to be non-404"
if ! wait_for_backfill_non_404 "${FN_BASE}" 30; then
  LAST_BACKFILL_CODE="$(cat /tmp/peakops_reset_backfill_last_code.txt 2>/dev/null || echo unknown)"
  fail "backfillEvidenceJobIdV1 remained 404/000 (last_http=${LAST_BACKFILL_CODE})"
  tail -n 120 "${EMU_LOG}" || true
  rg -n "backfillEvidenceJobIdV1|could not resolve|Error" "${EMU_LOG}" || true
  print_fail_banner
  exit 1
fi

if [[ ! -f "functions_clean/backfillEvidenceJobIdV1.js" ]]; then
  fail "functions_clean/backfillEvidenceJobIdV1.js missing from workspace"
  print_fail_banner
  exit 1
fi

if [[ "${MODE}" != "seed-only" ]]; then
  say "Starting Next dev server"
  nohup pnpm run next:restart >"${NEXT_LOG}" 2>&1 &

  if ! wait_for_port "${NEXT_PORT}" 45; then
    fail "next dev server port ${NEXT_PORT} not listening"
    print_fail_banner
    exit 1
  fi
else
  if ! wait_for_port "${NEXT_PORT}" 45; then
    fail "next dev server port ${NEXT_PORT} not listening (seed-only mode expects it up)"
    print_fail_banner
    exit 1
  fi
fi

say "Running demo seed"
if ! bash scripts/dev/seed_demo_incident.sh; then
  fail "seed script failed"
  print_fail_banner
  exit 1
fi

say "Verifying required ports"
for p in 5004 8087 9199; do
  if ! lsof -nP -iTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "required port ${p} not listening"
    print_fail_banner
    exit 1
  fi
done

say "Verifying storage REST"
ST_CODE="$(
  curl -s -o /tmp/peakops_reset_storage_probe.json -w '%{http_code}' \
    "http://127.0.0.1:9199/storage/v1/b/peakops-pilot.firebasestorage.app/o?pageSize=1" || true
)"
if [[ "${ST_CODE}" -lt 200 || "${ST_CODE}" -gt 299 ]]; then
  fail "storage REST probe failed on 9199 (http ${ST_CODE})"
  tail -n 120 "${EMU_LOG}" || true
  print_fail_banner
  exit 1
fi

FS_BASE="http://127.0.0.1:8087/v1/projects/${PROJECT_ID}/databases/(default)/documents"
say "Verifying incident + evidence in Firestore REST"
INC_CODE="$(curl -s -o /tmp/peakops_reset_incident_probe.json -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}" || true)"
if [[ "${INC_CODE}" -lt 200 || "${INC_CODE}" -gt 299 ]]; then
  fail "incident ${INCIDENT_ID} missing in Firestore (http ${INC_CODE})"
  print_fail_banner
  exit 1
fi
EVID_CODE="$(curl -s -o /tmp/peakops_reset_evidence_probe.json -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=200" || true)"
if [[ "${EVID_CODE}" == "000" ]]; then
  fail "evidence_locker probe curl failed (http 000): ${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=200"
  print_fail_banner
  exit 1
fi
if [[ "${EVID_CODE}" -lt 200 || "${EVID_CODE}" -gt 299 ]]; then
  fail "evidence_locker query failed (http ${EVID_CODE})"
  print_fail_banner
  exit 1
fi
EVID_COUNT="$(jq -r '(.documents // []) | length' /tmp/peakops_reset_evidence_probe.json 2>/dev/null || echo 0)"
if [[ "${EVID_COUNT}" -ne 5 ]]; then
  fail "evidence_locker count is ${EVID_COUNT}; expected == 5 (paths: ${FS_BASE}/incidents/${INCIDENT_ID}, /tmp/peakops_reset_evidence_probe.json)"
  print_fail_banner
  exit 1
fi

say "Verifying jobs + assignment + evidence mapping + HEIC stability"
JOBS_CODE="$(curl -s -o /tmp/peakops_reset_jobs_probe.json -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}/jobs?pageSize=200" || true)"
if [[ "${JOBS_CODE}" -lt 200 || "${JOBS_CODE}" -gt 299 ]]; then
  fail "jobs query failed (http ${JOBS_CODE})"
  print_fail_banner
  exit 1
fi
JOBS_TOTAL="$(jq -r '(.documents // []) | length' /tmp/peakops_reset_jobs_probe.json 2>/dev/null || echo 0)"
if [[ "${JOBS_TOTAL}" -ne 2 ]]; then
  fail "jobs count is ${JOBS_TOTAL}; expected == 2 (paths: ${FS_BASE}/incidents/${INCIDENT_ID}/jobs, /tmp/peakops_reset_jobs_probe.json)"
  print_fail_banner
  exit 1
fi
JOBS_ASSIGNED="$(jq -r '[.documents[]? | select(((.fields.assignedOrgId.stringValue // "")|length)>0 or ((.fields.assignedTo.stringValue // "")|length)>0)] | length' /tmp/peakops_reset_jobs_probe.json 2>/dev/null || echo 0)"
if [[ "${JOBS_ASSIGNED}" -ne 2 ]]; then
  fail "assigned jobs is ${JOBS_ASSIGNED}; expected == 2 (probe: /tmp/peakops_reset_jobs_probe.json)"
  print_fail_banner
  exit 1
fi
JOBS_REVIEWABLE_READY="$(jq -r '[.documents[]? | select((((.fields.status.stringValue // "") | ascii_downcase) == "complete") or (((.fields.status.stringValue // "") | ascii_downcase) == "review"))] | length' /tmp/peakops_reset_jobs_probe.json 2>/dev/null || echo 0)"
JOBS_ACTIVE_READY="$(jq -r '[.documents[]? | select((((.fields.status.stringValue // "") | ascii_downcase) == "open") or (((.fields.status.stringValue // "") | ascii_downcase) == "in_progress") or (((.fields.status.stringValue // "") | ascii_downcase) == "assigned"))] | length' /tmp/peakops_reset_jobs_probe.json 2>/dev/null || echo 0)"
if [[ "${SEED_MODE}" == "review" ]]; then
  if [[ "${JOBS_REVIEWABLE_READY}" -lt 2 ]]; then
    fail "no reviewable jobs found; expected >=2 jobs with status complete|review (probe: /tmp/peakops_reset_jobs_probe.json)"
    print_fail_banner
    exit 1
  fi
else
  if [[ "${JOBS_ACTIVE_READY}" -lt 2 ]]; then
    fail "no active jobs found; expected >=2 jobs with status open|in_progress|assigned for interactive mode (probe: /tmp/peakops_reset_jobs_probe.json)"
    print_fail_banner
    exit 1
  fi
fi

EVID_SUMMARY_JSON="$(
  jq -c '
    def resolvedJobId:
      (.fields["jobId"].stringValue
       // .fields.jobId.stringValue
       // .fields.evidence.mapValue.fields.jobId.stringValue
       // .fields["evidence.jobId"].stringValue
       // .fields.job.mapValue.fields.jobId.stringValue
       // "");
    def storagePath:
      (.fields["file.storagePath"].stringValue
       // .fields.file.mapValue.fields.storagePath.stringValue
       // "");
    {
      total: ((.documents // []) | length),
      with_job: ((.documents // []) | map(select((resolvedJobId | length) > 0)) | length),
      with_top_level_job: ((.documents // []) | map(select((.fields.jobId.stringValue // "" | length) > 0)) | length),
      by_job_001: ((.documents // []) | map(select(resolvedJobId == "job_demo_001")) | length),
      by_job_002: ((.documents // []) | map(select(resolvedJobId == "job_demo_002")) | length),
      unassigned: ((.documents // []) | map(select((resolvedJobId | length) == 0)) | length),
      unassigned_docs: ((.documents // [])
        | map(select((resolvedJobId | length) == 0)
          | {
              evidenceId: (.name // "" | split("/") | last),
              storagePath: storagePath,
              jobIdFieldKeys: (((.fields // {}) | keys) | map(select(test("jobId"; "i")))),
              rawCandidates: {
                top: (.fields.jobId.stringValue // ""),
                nested_evidence: (.fields.evidence.mapValue.fields.jobId.stringValue // ""),
                nested_job: (.fields.job.mapValue.fields.jobId.stringValue // "")
              }
            })
        | .[:5])
    }' /tmp/peakops_reset_evidence_probe.json 2>/dev/null || echo '{}'
)"
EVID_WITH_JOB="$(echo "${EVID_SUMMARY_JSON}" | jq -r '.with_job // 0' 2>/dev/null || echo 0)"
EVID_WITH_TOP_LEVEL_JOB="$(echo "${EVID_SUMMARY_JSON}" | jq -r '.with_top_level_job // 0' 2>/dev/null || echo 0)"
EVID_JOB_001="$(echo "${EVID_SUMMARY_JSON}" | jq -r '.by_job_001 // 0' 2>/dev/null || echo 0)"
EVID_JOB_002="$(echo "${EVID_SUMMARY_JSON}" | jq -r '.by_job_002 // 0' 2>/dev/null || echo 0)"
EVID_UNASSIGNED="$(echo "${EVID_SUMMARY_JSON}" | jq -r '.unassigned // 0' 2>/dev/null || echo 0)"

if [[ "${EVID_UNASSIGNED}" -gt 0 ]]; then
  say "Unassigned evidence sample (max 5):"
  echo "${EVID_SUMMARY_JSON}" | jq -c '.unassigned_docs[]?' 2>/dev/null || true
  fail "unassigned evidence detected: ${EVID_UNASSIGNED} (probe: /tmp/peakops_reset_evidence_probe.json)"
  print_fail_banner
  exit 1
fi
if [[ "${EVID_WITH_JOB}" -ne "${EVID_COUNT}" ]]; then
  fail "evidence mapping mismatch: evidence_with_job=${EVID_WITH_JOB} evidence_total=${EVID_COUNT} (expected equal)"
  print_fail_banner
  exit 1
fi
if [[ "${EVID_JOB_001}" -lt 2 || "${EVID_JOB_002}" -lt 2 ]]; then
  fail "evidence-by-job coverage failed: job_demo_001=${EVID_JOB_001} job_demo_002=${EVID_JOB_002} (expected >=2 each)"
  print_fail_banner
  exit 1
fi

JOB_DEMO_002_REJECTED="$(jq -r '[.documents[]? | select((.name // "") | endswith("/job_demo_002")) | select(((.fields.status.stringValue // "") | ascii_downcase) == "rejected" or ((.fields.reviewStatus.stringValue // "") | ascii_downcase) == "rejected")] | length' /tmp/peakops_reset_jobs_probe.json 2>/dev/null || echo 0)"
if [[ "${JOB_DEMO_002_REJECTED}" -gt 0 ]]; then
  fail "job_demo_002 is rejected; expected open/in_progress/assigned for deterministic demo (probe: /tmp/peakops_reset_jobs_probe.json)"
  print_fail_banner
  exit 1
fi

HEIC_COUNT="$(jq -r '[.documents[]? | select(((.fields.file.mapValue.fields.contentType.stringValue // "") | ascii_downcase | test("heic|heif")))] | length' /tmp/peakops_reset_evidence_probe.json 2>/dev/null || echo 0)"
HEIC_PENDING_COUNT="$(jq -r '[.documents[]? | select(((.fields.file.mapValue.fields.contentType.stringValue // "") | ascii_downcase | test("heic|heif"))) | select(((.fields.file.mapValue.fields.conversionStatus.stringValue // "") | ascii_downcase) == "pending" or ((.fields.file.mapValue.fields.conversionStatus.stringValue // "") | ascii_downcase) == "processing")] | length' /tmp/peakops_reset_evidence_probe.json 2>/dev/null || echo 0)"
if [[ "${HEIC_COUNT}" -gt 0 && "${HEIC_PENDING_COUNT}" -gt 0 ]]; then
  fail "HEIC stability gate failed: heic_pending_count=${HEIC_PENDING_COUNT} (probe: /tmp/peakops_reset_evidence_probe.json)"
  print_fail_banner
  exit 1
fi

say "summary seed_mode=${SEED_MODE} jobs_total=${JOBS_TOTAL} jobs_assigned=${JOBS_ASSIGNED} jobs_reviewable_ready=${JOBS_REVIEWABLE_READY} jobs_active_ready=${JOBS_ACTIVE_READY} evidence_total=${EVID_COUNT} evidence_with_job=${EVID_WITH_JOB} evidence_with_top_level_job=${EVID_WITH_TOP_LEVEL_JOB} by_job={job_demo_001:${EVID_JOB_001},job_demo_002:${EVID_JOB_002},unassigned:${EVID_UNASSIGNED}} heic_count=${HEIC_COUNT} heic_pending_count=${HEIC_PENDING_COUNT}"

print_pass_banner
