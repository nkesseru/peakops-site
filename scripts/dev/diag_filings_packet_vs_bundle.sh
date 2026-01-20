#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
CONTRACT_ID="${3:-car_abc123}"
BASE_URL="${4:-http://127.0.0.1:3000}"

echo "==> Using:"
echo "  ORG_ID=$ORG_ID"
echo "  INCIDENT_ID=$INCIDENT_ID"
echo "  CONTRACT_ID=$CONTRACT_ID"
echo "  BASE_URL=$BASE_URL"
echo

echo "==> Sanity: server reachable?"
curl -fsSI "$BASE_URL/" >/dev/null || {
  echo "❌ Can't reach Next at $BASE_URL"
  echo "Tip: start stack, then rerun."
  exit 1
}
echo "✅ Next reachable"
echo

PACKET_URL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&contractId=$CONTRACT_ID"
BUNDLE_URL="$BASE_URL/api/fn/downloadIncidentBundleZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"

TMP="/tmp/peak_diag_${ORG_ID}_${INCIDENT_ID}_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$TMP"
echo "==> TMP=$TMP"
echo

echo "==> (1) Download PACKET zip"
curl -fsS "$PACKET_URL" -o "$TMP/packet.zip"
echo "✅ packet.zip downloaded ($(stat -f%z "$TMP/packet.zip") bytes)"
echo

echo "==> (2) List PACKET contents (top 120)"
unzip -l "$TMP/packet.zip" | head -n 120
echo

echo "==> (3) Confirm filings exist in PACKET"
if unzip -l "$TMP/packet.zip" | grep -qE '^.*filings/.*\.json$'; then
  echo "✅ PACKET contains filings/*.json"
else
  echo "❌ PACKET does NOT contain filings/*.json"
fi
echo

echo "==> (4) Show filings/index.json + dirs/oe417 heads (if present)"
for f in "filings/index.json" "filings/dirs.json" "filings/oe417.json"; do
  if unzip -l "$TMP/packet.zip" | awk '{print $4}' | grep -qx "$f"; then
    echo "--- $f ---"
    unzip -p "$TMP/packet.zip" "$f" | head -c 900; echo
  else
    echo "--- $f (missing) ---"
  fi
done
echo

echo "==> (5) Download BUNDLE zip"
curl -fsS "$BUNDLE_URL" -o "$TMP/bundle.zip"
echo "✅ bundle.zip downloaded ($(stat -f%z "$TMP/bundle.zip") bytes)"
echo

echo "==> (6) List BUNDLE contents"
unzip -l "$TMP/bundle.zip"
echo

echo "==> (7) Does bundle contain packet.zip?"
if unzip -l "$TMP/bundle.zip" | awk '{print $4}' | grep -qx "packet.zip"; then
  echo "✅ bundle contains packet.zip (nested)"
else
  echo "❌ bundle does NOT contain packet.zip"
  exit 2
fi
echo

echo "==> (8) Extract nested packet.zip from bundle, then list filings inside it"
unzip -p "$TMP/bundle.zip" "packet.zip" > "$TMP/packet_from_bundle.zip"
echo "✅ extracted packet_from_bundle.zip ($(stat -f%z "$TMP/packet_from_bundle.zip") bytes)"
echo

if unzip -l "$TMP/packet_from_bundle.zip" | grep -qE '^.*filings/.*\.json$'; then
  echo "✅ Nested packet.zip INSIDE bundle contains filings/*.json"
else
  echo "❌ Nested packet.zip INSIDE bundle does NOT contain filings/*.json"
fi
echo

echo "==> (9) Quick diff: packet.zip vs packet_from_bundle.zip file lists"
# compare sorted file lists
unzip -l "$TMP/packet.zip" | awk '{print $4}' | tail -n +4 | sort > "$TMP/a.txt"
unzip -l "$TMP/packet_from_bundle.zip" | awk '{print $4}' | tail -n +4 | sort > "$TMP/b.txt"
diff -u "$TMP/a.txt" "$TMP/b.txt" || true
echo

echo "✅ DIAG COMPLETE"
echo "If your expectation was: 'bundle has filings/ next to packet.zip', that's not implemented yet."
echo "Right now: bundle = wrapper (packet.zip + bundle_manifest.json)."
echo
echo "Artifacts:"
echo "  $TMP/packet.zip"
echo "  $TMP/bundle.zip"
echo "  $TMP/packet_from_bundle.zip"
