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

say() { echo "[thumb-fetch-probe] $*"; }
fail() { echo "[thumb-fetch-probe] FAIL: $*" >&2; exit 1; }

tmp_list="$(mktemp -t peakops_thumb_probe_list.XXXXXX.json)"
tmp_mint="$(mktemp -t peakops_thumb_probe_mint.XXXXXX.json)"
trap 'rm -f "$tmp_list" "$tmp_mint"' EXIT

list_http="$(curl -sS -o "$tmp_list" -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" || true)"
[[ "${list_http}" == "200" ]] || fail "listEvidenceLocker http=${list_http} body=$(head -c 300 "$tmp_list")"
jq -e '.ok == true' "$tmp_list" >/dev/null 2>&1 || fail "listEvidenceLocker ok!=true body=$(head -c 300 "$tmp_list")"

printf '%-20s %-10s %-30s %-30s %-8s %-9s %-56s %-70s\n' "evidenceId" "kind" "storedBucket" "mintedBucket" "mintHttp" "fetchHttp" "storagePath" "url"

while IFS=$'\t' read -r evidence_id chosen_path_kind bucket storage_path; do
  [[ -z "${evidence_id}" ]] && continue
  [[ -n "${bucket}" && -n "${storage_path}" ]] || fail "missing bucket/path for evidenceId=${evidence_id}"

  req="$(jq -n \
    --arg orgId "${ORG_ID}" \
    --arg incidentId "${INCIDENT_ID}" \
    --arg bucket "${bucket}" \
    --arg storagePath "${storage_path}" \
    '{orgId:$orgId,incidentId:$incidentId,bucket:$bucket,storagePath:$storagePath,expiresSec:60,debug:true}')"

  mint_http="$(curl -sS -o "$tmp_mint" -w '%{http_code}' -X POST "${FN_BASE}/createEvidenceReadUrlV1" -H 'content-type: application/json' -d "${req}" || true)"
  out_ok="$(jq -r '.ok // false' "$tmp_mint" 2>/dev/null || echo false)"
  out_err="$(jq -r '.error // ""' "$tmp_mint" 2>/dev/null || echo "")"
  out_url="$(jq -r '.url // ""' "$tmp_mint" 2>/dev/null || echo "")"
  minted_bucket="$(jq -r '.bucket // ""' "$tmp_mint" 2>/dev/null || echo "")"
  [[ "${mint_http}" == "200" ]] || fail "mint failed evidenceId=${evidence_id} mint_http=${mint_http} err=${out_err} bucket=${bucket} path=${storage_path} body=$(head -c 500 "$tmp_mint")"
  [[ "${out_ok}" == "true" && -n "${out_url}" ]] || fail "mint invalid evidenceId=${evidence_id} err=${out_err} body=$(head -c 300 "$tmp_mint")"

  fetch_http="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "${out_url}" || echo 000)"
  if [[ "${fetch_http}" != "200" && "${fetch_http}" != "206" ]]; then
    fail "fetch(range) failed evidenceId=${evidence_id} fetch_http=${fetch_http} bucket=${bucket} path=${storage_path} url='${out_url}'"
  fi

  printf '%-20s %-10s %-30s %-30s %-8s %-9s %-56s %-70s\n' "${evidence_id}" "${chosen_path_kind}" "${bucket}" "${minted_bucket}" "${mint_http}" "${fetch_http}" "${storage_path}" "${out_url}"
done < <(
  jq -r '
    .docs[]?
    | {
        id: (.id // ""),
        bucket: (.file.bucket // .["file.bucket"] // ""),
        previewPath: (.file.previewPath // .file.derivatives.preview.storagePath // .["file.previewPath"] // ""),
        thumbPath: (.file.thumbPath // .file.derivatives.thumb.storagePath // .["file.thumbPath"] // ""),
        thumbnailPath: (.file.thumbnailPath // .["file.thumbnailPath"] // ""),
        storagePath: (.file.storagePath // .["file.storagePath"] // "")
      }
    | if (.thumbnailPath|length)>0 then [ .id, "thumbnailPath", .bucket, .thumbnailPath ]
      elif (.thumbPath|length)>0 then [ .id, "thumbPath", .bucket, .thumbPath ]
      elif (.previewPath|length)>0 then [ .id, "previewPath", .bucket, .previewPath ]
      else [ .id, "original", .bucket, .storagePath ]
      end
    | @tsv
  ' "$tmp_list"
)

say "PASS"
