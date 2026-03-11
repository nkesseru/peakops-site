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
FN_BASE="${FN_BASE:-http://127.0.0.1:5004/${PROJECT_ID}/us-central1}"
EXPIRES_SEC="${EXPIRES_SEC:-30}"
BOOT_DEMO="${BOOT_DEMO:-1}"
FS_PORT="${FS_PORT:-}"

say(){ echo "[thumb-longevity] $*"; }
fail(){ echo "[thumb-longevity] FAIL: $*" >&2; exit 1; }

if [[ "${BOOT_DEMO}" == "1" ]]; then
  say "bootstrapping demo with SEED_MODE=review"
  SEED_MODE=review bash scripts/dev/demo_up.sh
fi

tmp_docs="$(mktemp -t peakops_thumb_docs.XXXXXX.json)"
tmp_url1="$(mktemp -t peakops_thumb_url1.XXXXXX.json)"
trap 'rm -f "$tmp_docs" "$tmp_url1"' EXIT

if [[ -z "${FS_PORT}" && -f firebase.json ]]; then
  FS_PORT="$(jq -r '.emulators.firestore.port // empty' firebase.json 2>/dev/null || true)"
fi
FS_PORT="${FS_PORT:-8087}"
FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"

say "fetching seeded doc ev_demo_png_001 from Firestore REST"
doc_code="$(curl -sS -o "$tmp_docs" -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker/ev_demo_png_001" || true)"
[[ "$doc_code" == "200" ]] || fail "Firestore doc fetch failed http=${doc_code} for ev_demo_png_001"

evidence_id="ev_demo_png_001"
bucket="$(jq -r '.fields.file.mapValue.fields.bucket.stringValue // .fields["file.bucket"].stringValue // ""' "$tmp_docs")"
storage_path="$(jq -r '.fields.file.mapValue.fields.storagePath.stringValue // .fields["file.storagePath"].stringValue // ""' "$tmp_docs")"
[[ -n "$bucket" && -n "$storage_path" ]] || fail "missing bucket/storagePath on ev_demo_png_001"
say "using evidenceId=${evidence_id} bucket=${bucket} storagePath=${storage_path}"

req_body="$(printf '{"orgId":"%s","incidentId":"%s","bucket":"%s","storagePath":"%s","expiresSec":%s}' "$ORG_ID" "$INCIDENT_ID" "$bucket" "$storage_path" "$EXPIRES_SEC")"

code_u1="$(curl -sS -o "$tmp_url1" -w '%{http_code}' -X POST "${FN_BASE}/createEvidenceReadUrlV1" -H 'content-type: application/json' -d "$req_body")"
[[ "$code_u1" == "200" ]] || fail "createEvidenceReadUrlV1(1) http=${code_u1} body=$(head -c 300 "$tmp_url1")"
url1="$(jq -r '.url // empty' "$tmp_url1")"
[[ -n "$url1" ]] || fail "missing url in first response: $(head -c 300 "$tmp_url1")"
echo "$url1" | grep -q '/download/storage/v1/b/' || fail "emulator URL expected to contain /download/storage/v1/b/, got ${url1}"
say "minted URL1=${url1}"

st_now="$(curl -sS -o /dev/null -w '%{http_code}' "$url1" || echo 000)"
if [[ "$st_now" != "200" && "$st_now" != "206" ]]; then
  fail "minted emulator URL fetch failed http=${st_now}"
fi
say "PASS URL1 GET http=${st_now}"

st_head="$(curl -sSI -o /dev/null -w '%{http_code}' "$url1" || echo 000)"
if [[ "$st_head" == "200" ]]; then
  say "URL1 HEAD http=${st_head}"
else
  say "URL1 HEAD http=${st_head} (non-fatal; emulator/head behavior may differ)"
fi

say "done"
