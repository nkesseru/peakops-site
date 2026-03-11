#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
FN_PORT="${FN_PORT:-5004}"
STORAGE_PORT="${STORAGE_PORT:-9199}"

FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"
ST_BASE="http://127.0.0.1:${STORAGE_PORT}"

say(){ echo "[storage-truth] $*"; }
fail(){ echo "[storage-truth] FAIL: $*" >&2; exit 1; }

wait_port "${FN_PORT}" 10 || fail "functions ${FN_PORT} not listening"
wait_port 8087 10 || fail "firestore 8087 not listening"
wait_port "${STORAGE_PORT}" 10 || fail "storage ${STORAGE_PORT} not listening"

tmp_a="$(mktemp /tmp/peakops_storage_truth_a.XXXXXX.json)"
tmp_b="$(mktemp /tmp/peakops_storage_truth_b.XXXXXX.json)"
tmp_l="$(mktemp /tmp/peakops_storage_truth_list.XXXXXX.json)"
trap 'rm -f "$tmp_a" "$tmp_b" "$tmp_l"' EXIT

code_a="$(curl -sS -o "$tmp_a" -w '%{http_code}' "${ST_BASE}/storage/v1/b" || true)"
code_b="$(curl -sS -o "$tmp_b" -w '%{http_code}' "${ST_BASE}/v0/b" || true)"
say "bucket-list storage/v1/b http=${code_a} (informational)"
say "bucket-list v0/b http=${code_b} (informational)"

list_http="$(curl -sS -o "$tmp_l" -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" || true)"
[[ "${list_http}" == "200" ]] || fail "listEvidenceLocker http=${list_http} body=$(head -c 400 "$tmp_l")"
jq -e '.ok == true' "$tmp_l" >/dev/null 2>&1 || fail "listEvidenceLocker ok!=true body=$(head -c 400 "$tmp_l")"

printf '%-20s %-34s %-34s %-8s %-9s %-16s\n' "evidenceId" "storedBucket" "actualBucket" "meta" "media" "endpoint"

while IFS=$'\t' read -r evidence_id stored_bucket storage_path chosen_kind; do
  [[ -n "${evidence_id}" ]] || continue
  [[ -n "${storage_path}" ]] || fail "missing storagePath for evidenceId=${evidence_id}"

  cand_buckets="$(
    {
      printf '%s\n' "${stored_bucket}"
      if [[ "${stored_bucket}" == *.firebasestorage.app ]]; then
        printf '%s\n' "${stored_bucket%.firebasestorage.app}.appspot.com"
      elif [[ "${stored_bucket}" == *.appspot.com ]]; then
        printf '%s\n' "${stored_bucket%.appspot.com}.firebasestorage.app"
      fi
      printf '%s\n' "${FIREBASE_STORAGE_BUCKET:-}"
      if [[ -n "${FIREBASE_STORAGE_BUCKET:-}" ]]; then
        if [[ "${FIREBASE_STORAGE_BUCKET}" == *.firebasestorage.app ]]; then
          printf '%s\n' "${FIREBASE_STORAGE_BUCKET%.firebasestorage.app}.appspot.com"
        elif [[ "${FIREBASE_STORAGE_BUCKET}" == *.appspot.com ]]; then
          printf '%s\n' "${FIREBASE_STORAGE_BUCKET%.appspot.com}.firebasestorage.app"
        fi
      fi
      printf '%s\n' "${STORAGE_BUCKET:-}"
      if [[ -n "${STORAGE_BUCKET:-}" ]]; then
        if [[ "${STORAGE_BUCKET}" == *.firebasestorage.app ]]; then
          printf '%s\n' "${STORAGE_BUCKET%.firebasestorage.app}.appspot.com"
        elif [[ "${STORAGE_BUCKET}" == *.appspot.com ]]; then
          printf '%s\n' "${STORAGE_BUCKET%.appspot.com}.firebasestorage.app"
        fi
      fi
      printf '%s\n' "${PROJECT_ID}.firebasestorage.app"
      printf '%s\n' "${PROJECT_ID}.appspot.com"
    } | awk 'NF>0' | sort -u
  )"
  actual_bucket=""
  meta_code="0"
  media_code="0"
  endpoint_used=""
  enc_path="$(python3 - <<'PY' "${storage_path}"
import urllib.parse, sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"

  while IFS= read -r b; do
    [[ -n "${b}" ]] || continue
    enc_bucket="$(python3 - <<'PY' "${b}"
import urllib.parse, sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"
    media1="${ST_BASE}/download/storage/v1/b/${enc_bucket}/o/${enc_path}?alt=media"
    media2="${ST_BASE}/v0/b/${enc_bucket}/o/${enc_path}?alt=media"
    code_m1="$(curl -sS -o /dev/null -w '%{http_code}' "${ST_BASE}/storage/v1/b/${enc_bucket}/o/${enc_path}" || true)"
    code_m2="$(curl -sS -o /dev/null -w '%{http_code}' "${ST_BASE}/v0/b/${enc_bucket}/o/${enc_path}" || true)"
    code_r1="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "${media1}" || true)"
    code_r2="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "${media2}" || true)"
    if [[ "${code_r1}" == "200" || "${code_r1}" == "206" ]]; then
      actual_bucket="${b}"
      media_code="${code_r1}"
      endpoint_used="${endpoint_used:+${endpoint_used}|}media:download"
      break
    fi
    if [[ "${code_r2}" == "200" || "${code_r2}" == "206" ]]; then
      actual_bucket="${b}"
      media_code="${code_r2}"
      endpoint_used="${endpoint_used:+${endpoint_used}|}media:v0"
      break
    fi
  done <<< "${cand_buckets}"

  printf '%-20s %-34s %-34s %-8s %-9s %-16s\n' "${evidence_id}" "${stored_bucket:-"-"}" "${actual_bucket:-"-"}" "${meta_code}" "${media_code}" "${endpoint_used:-"-"}"
  if [[ -z "${actual_bucket}" ]]; then
    fail "actual bucket not found for evidenceId=${evidence_id} path=${storage_path}"
  fi
  if [[ "${media_code}" != "200" && "${media_code}" != "206" ]]; then
    fail "media fetch not ok for evidenceId=${evidence_id} bucket=${actual_bucket} path=${storage_path}"
  fi
done < <(
  jq -r '
    .docs[]?
    | {
        id: (.id // ""),
        storedBucket: (.file.bucket // .["file.bucket"] // ""),
        thumbnailPath: (.file.thumbnailPath // .["file.thumbnailPath"] // ""),
        thumbPath: (.file.thumbPath // .file.derivatives.thumb.storagePath // .["file.thumbPath"] // ""),
        previewPath: (.file.previewPath // .file.derivatives.preview.storagePath // .["file.previewPath"] // ""),
        storagePath: (.file.storagePath // .["file.storagePath"] // "")
      }
    | if (.thumbnailPath|length)>0 then [ .id, .storedBucket, .thumbnailPath, "thumbnailPath" ]
      elif (.thumbPath|length)>0 then [ .id, .storedBucket, .thumbPath, "thumbPath" ]
      elif (.previewPath|length)>0 then [ .id, .storedBucket, .previewPath, "previewPath" ]
      else [ .id, .storedBucket, .storagePath, "storagePath" ]
      end
    | @tsv
  ' "$tmp_l"
)

say "PASS"
