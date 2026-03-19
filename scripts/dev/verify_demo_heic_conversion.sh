#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
BASE_FN="${BASE_FN:-http://127.0.0.1:5002/${PROJECT_ID}/us-central1}"
EVIDENCE_ID="${EVIDENCE_ID:-ev_demo_heic_001}"

say() { echo "[verify-heic] $*"; }
fail() { echo "[verify-heic] FAIL: $*" >&2; exit 2; }

if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi
if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi

is_http_ok() {
  local code="$1"
  [[ "${code}" -ge 200 && "${code}" -le 399 ]]
}

list_file="$(mktemp /tmp/peakops_verify_heic_list.XXXXXX.json)"
debug_file="$(mktemp /tmp/peakops_verify_heic_debug.XXXXXX.json)"
run_file="$(mktemp /tmp/peakops_verify_heic_run.XXXXXX.json)"
trap 'rm -f "${list_file}" "${debug_file}" "${run_file}" /tmp/peakops_verify_heic_read.json' EXIT

say "Finding HEIC evidence in incident=${INCIDENT_ID}"
list_code="$(
  curl -sS -o "${list_file}" -w '%{http_code}' \
    "${BASE_FN}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" || true
)"
if ! is_http_ok "${list_code}"; then
  cat "${list_file}" 2>/dev/null || true
  fail "listEvidenceLocker failed http=${list_code}"
fi

evidence_id="${EVIDENCE_ID}"
if [[ -n "${evidence_id}" ]]; then
  if ! jq -e --arg id "${evidence_id}" '.docs[]? | select(.id == $id)' "${list_file}" >/dev/null 2>&1; then
    evidence_id=""
  fi
fi
if [[ -z "${evidence_id}" ]]; then
  evidence_id="$(
    jq -r '
    .docs[]?
    | select(
        ((.file.contentType // "") | test("heic|heif"; "i"))
        or ((.file.originalName // "") | test("\\.(heic|heif)$"; "i"))
        or ((.file.storagePath // "") | test("\\.(heic|heif)$"; "i"))
      )
    | .id
  ' "${list_file}" | head -n1
  )"
fi

if [[ -z "${evidence_id}" ]]; then
  fail "no HEIC evidence found in ${INCIDENT_ID}; provide HEIC_SAMPLE_FILE when seeding"
fi

say "Running debugHeicConversionV1 for evidenceId=${evidence_id}"
debug_code="$(
  curl -sS -o "${debug_file}" -w '%{http_code}' \
    -X POST "${BASE_FN}/debugHeicConversionV1" \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"evidenceId\":\"${evidence_id}\",\"dryRun\":false}" || true
)"
if ! is_http_ok "${debug_code}"; then
  cat "${debug_file}" 2>/dev/null || true
  fail "debugHeicConversionV1 failed http=${debug_code}"
fi

conv_ok="$(jq -r '(.conversionResult.ok // false) | tostring' "${debug_file}")"
preview_path="$(jq -r '.finalEvidence.previewPath // .conversionResult.previewPath // ""' "${debug_file}")"
thumb_path="$(jq -r '.finalEvidence.thumbPath // .conversionResult.thumbPath // ""' "${debug_file}")"
status_now="$(jq -r '.finalEvidence.conversionStatus // ""' "${debug_file}")"

if [[ "${conv_ok}" != "true" || -z "${preview_path}" || -z "${thumb_path}" || "${status_now}" != "ready" ]]; then
  say "Conversion not ready yet; running runConversionJobsV1 once then polling"
  run_code="$(
    curl -sS -o "${run_file}" -w '%{http_code}' \
      -X POST "${BASE_FN}/runConversionJobsV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"evidenceId\":\"${evidence_id}\"}" || true
  )"
  if ! is_http_ok "${run_code}"; then
    cat "${run_file}" 2>/dev/null || true
    fail "runConversionJobsV1 failed http=${run_code}"
  fi

  start_ts="$(date +%s)"
  while :; do
    poll_code="$(
      curl -sS -o "${list_file}" -w '%{http_code}' \
        "${BASE_FN}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" || true
    )"
    if is_http_ok "${poll_code}"; then
      status_now="$(
        jq -r --arg id "${evidence_id}" '.docs[]? | select(.id == $id) | .file.conversionStatus // ""' "${list_file}" | head -n1
      )"
      preview_path="$(
        jq -r --arg id "${evidence_id}" '.docs[]? | select(.id == $id) | .file.previewPath // ""' "${list_file}" | head -n1
      )"
      thumb_path="$(
        jq -r --arg id "${evidence_id}" '.docs[]? | select(.id == $id) | .file.thumbPath // ""' "${list_file}" | head -n1
      )"
      if [[ "${status_now}" == "ready" && -n "${preview_path}" && -n "${thumb_path}" ]]; then
        break
      fi
    fi
    now_ts="$(date +%s)"
    if [[ $((now_ts - start_ts)) -ge 45 ]]; then
      err_now="$(
        jq -r --arg id "${evidence_id}" '.docs[]? | select(.id == $id) | .file.conversionError // ""' "${list_file}" | head -n1
      )"
      fail "timeout evidenceId=${evidence_id} status=${status_now:-unknown} preview=${preview_path:-} thumb=${thumb_path:-} error=${err_now:-}"
    fi
    sleep 3
  done
fi

bucket="$(
  jq -r --arg id "${evidence_id}" '.docs[]? | select(.id == $id) | .file.bucket // .file.derivativeBucket // ""' "${list_file}" | head -n1
)"
if [[ -z "${bucket}" ]]; then
  fail "bucket missing for evidenceId=${evidence_id}"
fi

check_signed_read() {
  local kind="$1"
  local path="$2"
  local out_json="/tmp/peakops_verify_heic_read.json"
  local code url head_code head_headers head_ct
  code="$(
    curl -sS -o "${out_json}" -w '%{http_code}' \
      -X POST "${BASE_FN}/createEvidenceReadUrlV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${bucket}\",\"storagePath\":\"${path}\",\"expiresSec\":120}" || true
  )"
  if ! is_http_ok "${code}"; then
    cat "${out_json}" 2>/dev/null || true
    fail "${kind} read-url failed http=${code}"
  fi
  url="$(jq -r '.url // ""' "${out_json}")"
  [[ -n "${url}" ]] || fail "${kind} read-url empty for path=${path}"
  head_headers="$(mktemp /tmp/peakops_verify_heic_head.XXXXXX)"
  head_code="$(curl -sS -I -D "${head_headers}" -o /dev/null -w '%{http_code}' "${url}" || true)"
  is_http_ok "${head_code}" || fail "${kind} HEAD failed http=${head_code} path=${path}"
  head_ct="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/{sub(/\r$/,"",$0); sub(/^[^:]*:[[:space:]]*/,"",$0); print tolower($0); exit}' "${head_headers}")"
  rm -f "${head_headers}"
  [[ "${head_ct}" == image/* ]] || fail "${kind} HEAD content-type is not image/* (got=${head_ct:-empty}) path=${path}"
}

check_signed_read "preview" "${preview_path}"
check_signed_read "thumb" "${thumb_path}"

echo "PASS evidenceId=${evidence_id} status=ready previewPath=${preview_path} thumbPath=${thumb_path}"
