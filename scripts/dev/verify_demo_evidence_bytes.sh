#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FN_PORT="${FN_PORT:-5002}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"

say() { echo "[verify-demo-bytes] $*"; }
fail() { echo "[verify-demo-bytes] FAIL: $*" >&2; exit 2; }

sanitize_id() {
  printf '%s' "$1" | tr '/:' '__' | tr -cd 'A-Za-z0-9._-'
}

if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi
if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi
if ! command -v od >/dev/null 2>&1; then fail "od is required"; fi

hex_prefix() {
  local file_path="$1"
  local nbytes="$2"
  if command -v xxd >/dev/null 2>&1; then
    xxd -p -l "${nbytes}" "${file_path}" | tr -d '\n'
    return
  fi
  od -An -t x1 -N "${nbytes}" "${file_path}" | tr -d ' \n'
}

read_url_for() {
  local bucket="$1"
  local storage_path="$2"
  local out_file="$3"
  local code

  code="$(
    curl -sS -o "${out_file}" -w '%{http_code}' \
      -X POST "${BASE}/createEvidenceReadUrlV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${bucket}\",\"storagePath\":\"${storage_path}\",\"expiresSec\":120}" || true
  )"
  if [[ "${code}" -lt 200 || "${code}" -gt 299 ]]; then
    cat "${out_file}" 2>/dev/null || true
    fail "createEvidenceReadUrlV1 failed http=${code} bucket=${bucket} path=${storage_path}"
  fi

  local url
  url="$(jq -r '.url // ""' "${out_file}")"
  if [[ -z "${url}" ]]; then
    echo "[verify-demo-bytes] read-url raw response bucket=${bucket} path=${storage_path}:" >&2
    cat "${out_file}" 2>/dev/null >&2 || true
    fail "createEvidenceReadUrlV1 returned empty url bucket=${bucket} path=${storage_path}"
  fi
  printf '%s' "${url}"
}

verify_one() {
  local kind="$1"
  local expected="$2"
  local bytes="$3"
  local min_size="$4"

  local doc
  doc="$(curl -sS "${BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" \
    | jq -c --arg kind "${kind}" '.docs[]? | select((.file.contentType // "") == $kind and (.file.bucket // "") != "" and (.file.storagePath // "") != "")' \
    | head -n1)"

  if [[ -z "${doc}" ]]; then
    fail "no evidence doc found for contentType=${kind}"
  fi

  local evidence_id bucket storage_path
  evidence_id="$(printf '%s' "${doc}" | jq -r '.id // ""')"
  bucket="$(printf '%s' "${doc}" | jq -r '.file.bucket // ""')"
  storage_path="$(printf '%s' "${doc}" | jq -r '.file.storagePath // ""')"

  if [[ -z "${bucket}" || -z "${storage_path}" ]]; then
    fail "missing bucket/path for evidenceId=${evidence_id}"
  fi

  local safe_kind
  safe_kind="$(sanitize_id "${kind}")"
  local read_json
  read_json="$(mktemp "/tmp/peakops_verify_readurl_${safe_kind}.XXXXXX.json")"
  local signed_url
  signed_url="$(read_url_for "${bucket}" "${storage_path}" "${read_json}")"

  local body_file
  body_file="$(mktemp /tmp/peakops_verify_body.XXXXXX)"
  if ! curl -sS -L "${signed_url}" -o "${body_file}"; then
    local signed_host
    signed_host="$(printf '%s' "${signed_url}" | sed -E 's#^[a-zA-Z]+://([^/]+)/?.*$#\1#')"
    rm -f "${body_file}"
    fail "signed url GET failed evidenceId=${evidence_id} host=${signed_host}"
  fi

  local magic
  magic="$(hex_prefix "${body_file}" "${bytes}")"
  local body_size
  body_size="$(wc -c < "${body_file}" | tr -d ' ')"

  if [[ "${body_size}" -lt "${min_size}" ]]; then
    rm -f "${body_file}"
    fail "size mismatch evidenceId=${evidence_id} kind=${kind} size=${body_size} minSize=${min_size}"
  fi

  if command -v sips >/dev/null 2>&1; then
    if ! sips -g pixelWidth -g pixelHeight "${body_file}" >/tmp/peakops_verify_sips.out 2>&1; then
      cat /tmp/peakops_verify_sips.out 2>/dev/null || true
      rm -f "${body_file}"
      fail "decode failed evidenceId=${evidence_id} kind=${kind} bucket=${bucket} path=${storage_path}"
    fi
  fi
  rm -f "${body_file}"

  echo "evidenceId=${evidence_id} kind=${kind} bucket=${bucket} path=${storage_path} size=${body_size} magic=${magic} expected=${expected}"
  if [[ "${magic}" != "${expected}" ]]; then
    fail "magic mismatch evidenceId=${evidence_id} got=${magic} expected=${expected}"
  fi
}

verify_one "image/png" "89504e470d0a1a0a" 8 67
verify_one "image/jpeg" "ffd8ff" 3 200
say "PASS png/jpg magic verified"
