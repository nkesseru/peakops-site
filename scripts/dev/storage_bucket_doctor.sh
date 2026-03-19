#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
EVIDENCE_ID="${EVIDENCE_ID:-ev_demo_heic_001}"
FS_PORT="${FS_PORT:-8087}"
STORAGE_PORT="${STORAGE_PORT:-9199}"

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
ST_BASE="http://127.0.0.1:${STORAGE_PORT}"

say(){ echo "[storage-bucket-doctor] $*"; }
fail(){ echo "[storage-bucket-doctor] FAIL: $*" >&2; exit 1; }

tmp_b="$(mktemp /tmp/peakops_bucket_doctor_buckets.XXXXXX.json)"
tmp_d="$(mktemp /tmp/peakops_bucket_doctor_doc.XXXXXX.json)"
trap 'rm -f "$tmp_b" "$tmp_d"' EXIT

b_code="$(curl -sS -o "$tmp_b" -w '%{http_code}' "${ST_BASE}/storage/v1/b" || true)"
[[ "$b_code" == "200" ]] || fail "storage bucket list http=${b_code}"
mapfile -t BUCKETS < <(jq -r '.items[]?.name // .buckets[]?.name // empty' "$tmp_b")
[[ "${#BUCKETS[@]}" -gt 0 ]] || fail "no buckets found in storage emulator"
say "buckets: ${BUCKETS[*]}"

d_code="$(curl -sS -o "$tmp_d" -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker/${EVIDENCE_ID}" || true)"
[[ "$d_code" == "200" ]] || fail "evidence doc not found http=${d_code} evidenceId=${EVIDENCE_ID}"
storage_path="$(jq -r '.fields["file.storagePath"].stringValue // .fields.file.mapValue.fields.storagePath.stringValue // ""' "$tmp_d")"
stored_bucket="$(jq -r '.fields["file.bucket"].stringValue // .fields.file.mapValue.fields.bucket.stringValue // ""' "$tmp_d")"
[[ -n "$storage_path" ]] || fail "missing storagePath on evidence doc"
say "evidenceId=${EVIDENCE_ID} storedBucket=${stored_bucket} storagePath=${storage_path}"

enc_path="$(python3 - <<'PY' "$storage_path"
import urllib.parse,sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"

printf '%-40s %-8s %-8s\n' 'bucket' 'meta' 'media'
for b in "$stored_bucket" "${BUCKETS[@]}"; do
  [[ -n "$b" ]] || continue
  enc_b="$(python3 - <<'PY' "$b"
import urllib.parse,sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"
  meta_code="$(curl -sS -o /dev/null -w '%{http_code}' "${ST_BASE}/storage/v1/b/${enc_b}/o/${enc_path}" || true)"
  media_code="$(curl -sS -I -o /dev/null -w '%{http_code}' "${ST_BASE}/download/storage/v1/b/${enc_b}/o/${enc_path}?alt=media" || true)"
  printf '%-40s %-8s %-8s\n' "$b" "$meta_code" "$media_code"
done

say "PASS"
