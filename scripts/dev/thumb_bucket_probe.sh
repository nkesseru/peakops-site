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

say(){ echo "[thumb-bucket-probe] $*"; }
fail(){ echo "[thumb-bucket-probe] FAIL: $*" >&2; exit 1; }

flip_bucket() {
  local b="$1"
  if [[ "$b" == *.firebasestorage.app ]]; then
    echo "${b%.firebasestorage.app}.appspot.com"
  elif [[ "$b" == *.appspot.com ]]; then
    echo "${b%.appspot.com}.firebasestorage.app"
  else
    echo "$b"
  fi
}

tmp_list="$(mktemp /tmp/peakops_thumb_bucket_probe.XXXXXX.json)"
trap 'rm -f "$tmp_list"' EXIT

list_http="$(curl -sS -o "$tmp_list" -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=50" || true)"
[[ "$list_http" == "200" ]] || fail "listEvidenceLocker http=${list_http}"

evidence_id="$(jq -r '.docs[0].id // ""' "$tmp_list")"
bucket="$(jq -r '.docs[0].file.bucket // .docs[0]["file.bucket"] // ""' "$tmp_list")"
path="$(jq -r '.docs[0].file.storagePath // .docs[0]["file.storagePath"] // ""' "$tmp_list")"
[[ -n "$evidence_id" && -n "$bucket" && -n "$path" ]] || fail "first evidence missing id/bucket/path"

flipped="$(flip_bucket "$bucket")"
enc_bucket="$(python3 - <<'PY' "$bucket"
import urllib.parse,sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"
enc_flipped="$(python3 - <<'PY' "$flipped"
import urllib.parse,sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"
enc_path="$(python3 - <<'PY' "$path"
import urllib.parse,sys
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"

url_a="${ST_BASE}/download/storage/v1/b/${enc_bucket}/o/${enc_path}?alt=media"
url_b="${ST_BASE}/download/storage/v1/b/${enc_flipped}/o/${enc_path}?alt=media"

http_a="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "$url_a" || true)"
http_b="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "$url_b" || true)"

say "evidenceId=${evidence_id}"
say "storedBucket=${bucket} status=${http_a}"
say "flippedBucket=${flipped} status=${http_b}"

if [[ "$http_a" != "200" && "$http_a" != "206" && "$http_b" != "200" && "$http_b" != "206" ]]; then
  fail "neither stored nor flipped bucket served media"
fi

say "PASS"
