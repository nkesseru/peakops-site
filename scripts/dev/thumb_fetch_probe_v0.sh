#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/kesserumini/peakops/my-app"
cd "$REPO"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
FN_PORT="${FN_PORT:-5004}"
NEXT_PORT="${NEXT_PORT:-3001}"
FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"

say(){ echo "[thumb-probe] $*"; }
fail(){ echo "[thumb-probe] FAIL: $*" >&2; exit 1; }

tmp_list="$(mktemp /tmp/peakops_thumb_probe_list.XXXXXX.json)"
tmp_mint="$(mktemp /tmp/peakops_thumb_probe_mint.XXXXXX.json)"
trap 'rm -f "$tmp_list" "$tmp_mint"' EXIT

say "listEvidenceLocker..."
code="$(curl -sS -o "$tmp_list" -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=50" || true)"
[[ "$code" == "200" ]] || fail "listEvidenceLocker http=$code body=$(head -c 300 "$tmp_list")"
jq -e '.ok==true' "$tmp_list" >/dev/null || fail "listEvidenceLocker ok!=true"

printf '%-18s %-6s %-6s %-34s %s\n' "evidenceId" "mint" "fetch" "bucket" "storagePath"

jq -r '.docs[]? | [
  (.id // ""),
  (.file.bucket // .["file.bucket"] // ""),
  (.file.thumbnailPath // .["file.thumbnailPath"] // ""),
  (.file.thumbPath // .file.derivatives.thumb.storagePath // .["file.thumbPath"] // ""),
  (.file.previewPath // .file.derivatives.preview.storagePath // .["file.previewPath"] // ""),
  (.file.storagePath // .["file.storagePath"] // "")
] | @tsv' "$tmp_list" | while IFS=$'\t' read -r eid bucket thumbnail thumb preview orig; do
  [[ -n "$eid" ]] || continue
  path="$orig"
  kind="orig"
  if [[ -n "$thumbnail" ]]; then path="$thumbnail"; kind="thumbN"; fi
  if [[ -z "$path" && -n "$thumb" ]]; then path="$thumb"; kind="thumb"; fi
  if [[ -z "$path" && -n "$preview" ]]; then path="$preview"; kind="prev"; fi

  [[ -n "$bucket" && -n "$path" ]] || fail "missing bucket/path for $eid (bucket='$bucket' path='$path')"

  req="$(jq -n --arg orgId "$ORG_ID" --arg incidentId "$INCIDENT_ID" --arg bucket "$bucket" --arg storagePath "$path" \
    '{orgId:$orgId,incidentId:$incidentId,bucket:$bucket,storagePath:$storagePath,debug:true}')"

  mint="$(curl -sS -o "$tmp_mint" -w '%{http_code}' -X POST "${FN_BASE}/createEvidenceReadUrlV1" -H 'content-type: application/json' -d "$req" || true)"
  out_ok="$(jq -r '.ok // false' "$tmp_mint" 2>/dev/null || echo false)"
  out_bucket="$(jq -r '.bucket // ""' "$tmp_mint" 2>/dev/null || echo "")"

  [[ "$mint" == "200" && "$out_ok" == "true" && -n "$out_bucket" ]] || fail "mint failed eid=$eid http=$mint body=$(cat "$tmp_mint")"

  proxy_url="http://127.0.0.1:${NEXT_PORT}/api/storageProxy?bucket=$(python3 - <<'PY' \"$out_bucket\"\nimport urllib.parse,sys\nprint(urllib.parse.quote(sys.argv[1], safe=''))\nPY\n)&storagePath=$(python3 - <<'PY' \"$path\"\nimport urllib.parse,sys\nprint(urllib.parse.quote(sys.argv[1], safe=''))\nPY\n)"
  fetch="$(curl -sS -H 'Range: bytes=0-0' -o /dev/null -w '%{http_code}' "$proxy_url" || echo 000)"
  [[ "$fetch" == "200" || "$fetch" == "206" ]] || fail "fetch failed eid=$eid fetch=$fetch url=$proxy_url"

  printf '%-18s %-6s %-6s %-34s %s\n' "$eid" "$mint" "$fetch" "$out_bucket" "$kind:$path"
done

say "PASS ✅"
