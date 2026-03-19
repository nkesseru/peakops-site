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
NEXT_PORT="${NEXT_PORT:-3001}"

FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"

tmp="$(mktemp /tmp/peakops_thumb_proxy_list.XXXXXX.json)"
trap 'rm -f "$tmp"' EXIT

echo "[thumb-proxy-smoke] listEvidenceLocker..."
code="$(curl -sS -o "$tmp" -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=50" || true)"
[[ "$code" == "200" ]] || { echo "[FAIL] listEvidenceLocker http=$code body=$(head -c 200 "$tmp")"; exit 1; }

jq -e '.ok==true' "$tmp" >/dev/null

printf '%-18s %-4s %-20s %-12s %s\n' "evidenceId" "http" "content-type" "kind" "proxyUrl"

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
  | if (.thumbnailPath|length)>0 then [ .id, .bucket, .thumbnailPath, "thumbnailPath" ]
    elif (.thumbPath|length)>0 then [ .id, .bucket, .thumbPath, "thumbPath" ]
    elif (.previewPath|length)>0 then [ .id, .bucket, .previewPath, "previewPath" ]
    else [ .id, .bucket, .storagePath, "original" ]
    end
  | @tsv
' "$tmp" | while IFS=$'\t' read -r id bucket path kind; do
  [[ -n "$id" && -n "$bucket" && -n "$path" ]] || continue
  b_enc="$(jq -rn --arg v "$bucket" '$v|@uri')"
  p_enc="$(jq -rn --arg v "$path" '$v|@uri')"
  url="http://127.0.0.1:${NEXT_PORT}/api/storageProxy?bucket=${b_enc}&storagePath=${p_enc}"
  head="$(curl -sS -I "$url" || true)"
  http="$(printf "%s" "$head" | awk 'toupper($1) ~ /^HTTP\// {code=$2} END{print code+0}')"
  ctype="$(printf "%s" "$head" | awk 'BEGIN{IGNORECASE=1} /^content-type:/ {print $2; exit}')"
  printf '%-18s %-4s %-20s %-12s %s\n' "$id" "$http" "${ctype:-missing}" "$kind" "$url"
  [[ "$http" == "200" || "$http" == "206" ]] || exit 2
done

echo "[thumb-proxy-smoke] PASS"
