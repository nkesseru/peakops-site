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
FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"

say(){ echo "[thumb-gate] $*"; }
fail(){ echo "[thumb-gate] FAIL: $*" >&2; exit 1; }

if [[ -x "scripts/dev/storage_truth.sh" ]]; then
  bash scripts/dev/storage_truth.sh
else
  fail "scripts/dev/storage_truth.sh missing or not executable"
fi

tmp_list="$(mktemp /tmp/peakops_thumb_gate_list.XXXXXX.json)"
tmp_mint="$(mktemp /tmp/peakops_thumb_gate_mint.XXXXXX.json)"
trap 'rm -f "$tmp_list" "$tmp_mint"' EXIT

list_http="$(curl -sS -o "$tmp_list" -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" || true)"
[[ "$list_http" == "200" ]] || fail "listEvidenceLocker http=${list_http} body=$(head -c 400 "$tmp_list")"
jq -e '.ok == true' "$tmp_list" >/dev/null 2>&1 || fail "listEvidenceLocker ok!=true body=$(head -c 400 "$tmp_list")"

printf '%-20s %-13s %-38s %-7s %-9s\n' "evidenceId" "chosenKind" "bucket" "mintOk" "fetchHttp"

while IFS=$'\t' read -r evidence_id chosen_kind bucket storage_path; do
  [[ -n "$evidence_id" ]] || continue
  [[ -n "$storage_path" ]] || fail "missing storagePath evidenceId=${evidence_id} bucket='${bucket}' path='${storage_path}'"

  req="$(jq -n \
    --arg orgId "${ORG_ID}" \
    --arg incidentId "${INCIDENT_ID}" \
    --arg bucket "${bucket}" \
    --arg storagePath "${storage_path}" \
    '{orgId:$orgId,incidentId:$incidentId,bucket:$bucket,storagePath:$storagePath,expiresSec:60,debug:true}')"

  mint_http="$(curl -sS -o "$tmp_mint" -w '%{http_code}' -X POST "${FN_BASE}/createEvidenceReadUrlV1" -H 'content-type: application/json' -d "$req" || true)"
  mint_ok="$(jq -r '.ok // false' "$tmp_mint" 2>/dev/null || echo false)"
  mint_url="$(jq -r '.url // ""' "$tmp_mint" 2>/dev/null || echo "")"

  if [[ "$mint_http" != "200" || "$mint_ok" != "true" || -z "$mint_url" ]]; then
    fail "mint failed evidenceId=${evidence_id} mint_http=${mint_http} body=$(head -c 600 "$tmp_mint")"
  fi

  fetch_http="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "$mint_url" || echo 000)"
  if [[ "$fetch_http" != "200" && "$fetch_http" != "206" ]]; then
    fail "fetch failed evidenceId=${evidence_id} fetch_http=${fetch_http} url='${mint_url}'"
  fi

  printf '%-20s %-13s %-38s %-7s %-9s\n' "$evidence_id" "$chosen_kind" "$bucket" "$mint_ok" "$fetch_http"
done < <(
  jq -r '
    .docs[]?
    | {
        id: (.id // ""),
        bucket: (.file.bucket // .["file.bucket"] // ""),
        thumbnailPath: (.file.thumbnailPath // .["file.thumbnailPath"] // ""),
        thumbPath: (.file.thumbPath // .file.derivatives.thumb.storagePath // .["file.thumbPath"] // ""),
        previewPath: (.file.previewPath // .file.derivatives.preview.storagePath // .["file.previewPath"] // ""),
        storagePath: (.file.storagePath // .["file.storagePath"] // "")
      }
    | if (.thumbnailPath|length)>0 then [ .id, "thumbnailPath", .bucket, .thumbnailPath ]
      elif (.thumbPath|length)>0 then [ .id, "thumbPath", .bucket, .thumbPath ]
      elif (.previewPath|length)>0 then [ .id, "previewPath", .bucket, .previewPath ]
      else [ .id, "storagePath", .bucket, .storagePath ]
      end
    | @tsv
  ' "$tmp_list"
)

say "PASS"
