set +H 2>/dev/null || true
set -euo pipefail
REGION=us-west1; SERVICE=peakops-api
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
ID_TOKEN="$(gcloud auth print-identity-token)"
cat >/tmp/p.json <<'JSON'
{"rulepack_version":"2025.02","payload":{"as_of":"2025-10-30","county_fips":"53063","cell_sites_served":120,"cell_sites_out":8}}
JSON
PF="$(curl -s -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
  -X POST "$URL/v1/prefile/FCC_DIRS" --data-binary @/tmp/p.json)"
echo "$PF" | jq
SUB_ID="$(echo "$PF" | jq -r '.id')"
curl -s -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
  -X POST "$URL/v1/finalize/FCC_DIRS/$SUB_ID" -d '{"actor":"smoke"}' | jq
curl -s -H "Authorization: Bearer $ID_TOKEN" "$URL/v1/finalized/$SUB_ID.json" | jq
