#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
FS_PORT="${FS_PORT:-8087}"
STORAGE_PORT="${STORAGE_PORT:-9199}"
FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
STORAGE_BASE="http://127.0.0.1:${STORAGE_PORT}"

say() { echo "[thumb-bucket-audit] $*"; }
fail() { echo "[thumb-bucket-audit] FAIL: $*" >&2; exit 1; }

tmp_docs="$(mktemp -t peakops_thumb_bucket_docs.XXXXXX.json)"
trap 'rm -f "${tmp_docs}"' EXIT

code="$(curl -sS -o "${tmp_docs}" -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=300" || true)"
[[ "${code}" == "200" ]] || fail "evidence_locker query http=${code} path=${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=300"

proj_bucket_a="${PROJECT_ID}.firebasestorage.app"
proj_bucket_b="${PROJECT_ID}.appspot.com"

doc_count="$(jq -r '.documents | length' "${tmp_docs}" 2>/dev/null || echo 0)"
[[ "${doc_count}" -gt 0 ]] || fail "no evidence docs found"

printf '%-20s %-35s %-35s %-8s %s\n' "evidenceId" "storedBucket" "workingBucket" "http" "path"

patch_nested_bucket() {
  local doc_path="$1"
  local bucket="$2"
  local url="${FS_BASE}/${doc_path}?updateMask.fieldPaths=file.bucket&updateMask.fieldPaths=file.derivatives.thumb.bucket&updateMask.fieldPaths=file.derivatives.preview.bucket"
  local payload
  payload="$(jq -n --arg b "${bucket}" '{
    fields: {
      file: {
        mapValue: {
          fields: {
            bucket: { stringValue: $b },
            derivatives: {
              mapValue: {
                fields: {
                  thumb: { mapValue: { fields: { bucket: { stringValue: $b } } } },
                  preview: { mapValue: { fields: { bucket: { stringValue: $b } } } }
                }
              }
            }
          }
        }
      }
    }
  }')"
  curl -sS -X PATCH "${url}" -H 'content-type: application/json' -d "${payload}" >/dev/null || true
}

patch_flattened_bucket() {
  local doc_path="$1"
  local bucket="$2"
  local url="${FS_BASE}/${doc_path}?updateMask.fieldPaths=%60file.bucket%60&updateMask.fieldPaths=%60file.derivatives.thumb.bucket%60&updateMask.fieldPaths=%60file.derivatives.preview.bucket%60"
  local payload
  payload="$(jq -n --arg b "${bucket}" '{
    fields: {
      "file.bucket": { stringValue: $b },
      "file.derivatives.thumb.bucket": { stringValue: $b },
      "file.derivatives.preview.bucket": { stringValue: $b }
    }
  }')"
  curl -sS -X PATCH "${url}" -H 'content-type: application/json' -d "${payload}" >/dev/null || true
}

while IFS=$'\t' read -r doc_name evidence_id stored_bucket chosen_path; do
  [[ -n "${doc_name}" ]] || continue
  [[ -n "${chosen_path}" ]] || continue
  candidates=("${stored_bucket}" "${proj_bucket_a}" "${proj_bucket_b}")
  working_bucket=""
  working_http="000"
  for cand in "${candidates[@]}"; do
    [[ -n "${cand}" ]] || continue
    encoded_path="$(jq -rn --arg p "${chosen_path}" '$p|@uri')"
    url="${STORAGE_BASE}/download/storage/v1/b/${cand}/o/${encoded_path}?alt=media"
    http="$(curl -sS -o /dev/null -w '%{http_code}' "${url}" || echo 000)"
    if [[ "${http}" == "200" || "${http}" == "206" ]]; then
      working_bucket="${cand}"
      working_http="${http}"
      break
    fi
  done

  if [[ -z "${working_bucket}" ]]; then
    working_bucket="(none)"
  fi
  printf '%-20s %-35s %-35s %-8s %s\n' "${evidence_id}" "${stored_bucket:-"(empty)"}" "${working_bucket}" "${working_http}" "${chosen_path}"

  if [[ -n "${working_bucket}" && "${working_bucket}" != "(none)" && -n "${stored_bucket}" && "${working_bucket}" != "${stored_bucket}" ]]; then
    doc_path="incidents/${INCIDENT_ID}/evidence_locker/${evidence_id}"
    patch_nested_bucket "${doc_path}" "${working_bucket}"
    patch_flattened_bucket "${doc_path}" "${working_bucket}"
    say "patched ${evidence_id}: ${stored_bucket} -> ${working_bucket}"
  fi
done < <(
  jq -r '
    .documents[]? as $d
    | ($d.name | split("/") | last) as $id
    | ($d.fields.evidenceId.stringValue // $id) as $eid
    | ($d.fields.file.mapValue.fields.bucket.stringValue // $d.fields["file.bucket"].stringValue // "") as $bucket
    | (
        $d.fields.file.mapValue.fields.thumbnailPath.stringValue //
        $d.fields["file.thumbnailPath"].stringValue //
        $d.fields.file.mapValue.fields.thumbPath.stringValue //
        $d.fields["file.thumbPath"].stringValue //
        $d.fields.file.mapValue.fields.previewPath.stringValue //
        $d.fields["file.previewPath"].stringValue //
        $d.fields.file.mapValue.fields.storagePath.stringValue //
        $d.fields["file.storagePath"].stringValue //
        ""
      ) as $path
    | [$d.name, $eid, $bucket, $path] | @tsv
  ' "${tmp_docs}"
)

say "PASS"
