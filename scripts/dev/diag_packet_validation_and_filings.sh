#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

URL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"
TS="$(date +%Y%m%d_%H%M%S)"
TMP="/tmp/peak_diag_validate_${ORG_ID}_${INCIDENT_ID}_${TS}"
mkdir -p "$TMP"

echo "==> Download packet.zip"
curl -fsS "$URL" -o "$TMP/packet.zip"
echo "✅ downloaded $(stat -f%z "$TMP/packet.zip") bytes -> $TMP/packet.zip"
echo

echo "==> List key files in zip"
unzip -l "$TMP/packet.zip" | egrep "filings/|packet_meta.json|manifest.json|hashes.json" || true
echo

echo "==> Require validation artifacts"
REQ=(
  "filings/validation.json"
  "filings/dirs.validation.json"
  "filings/oe417.validation.json"
  "filings/index.json"
  "filings/dirs.json"
  "filings/oe417.json"
)
for f in "${REQ[@]}"; do
  if unzip -l "$TMP/packet.zip" | awk '{print $4}' | grep -qx "$f"; then
    echo "✅ $f"
  else
    echo "❌ MISSING $f"
    echo
    echo "Top of zip contents:"
    unzip -l "$TMP/packet.zip" | head -n 80
    exit 1
  fi
done
echo

echo "==> Show validation summary"
unzip -p "$TMP/packet.zip" "filings/validation.json" | head -n 120
echo
echo "==> Show filings/index.json summary"
unzip -p "$TMP/packet.zip" "filings/index.json" | head -n 160
echo
echo "✅ DIAG OK — validation + filings are present in packet.zip"
echo "TMP: $TMP"
