#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"   # used only for "OPEN" links (no emulator start here)

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOGDIR=".logs"
TS="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
TS_ID="$(date -u +%Y%m%d_%H%M%S)"

BUNDLE_DIR="next-app/.packet_tmp_${INCIDENT_ID}_${TS_ID}"
OUT_ZIP="next-app/.packet_${INCIDENT_ID}_${TS_ID}.zip"

mkdir -p "$LOGDIR" scripts/dev/_bak "$BUNDLE_DIR" "$(dirname "$OUT_ZIP")"

upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

echo "==> Locking packet contract (v1) [ORG=$ORG_ID INCIDENT=$INCIDENT_ID TS=$TS]"

# --- packet_meta.json
cat > "$BUNDLE_DIR/packet_meta.json" <<EOF
{
  "packetVersion": "v1",
  "orgId": "$ORG_ID",
  "incidentId": "$INCIDENT_ID",
  "generatedAt": "$TS"
}
EOF

# --- workflow.json (freeze marker)
cat > "$BUNDLE_DIR/workflow.json" <<EOF
{
  "version": "v1",
  "frozenAt": "$TS",
  "source": "workflow_engine"
}
EOF

# --- timeline/events.json
mkdir -p "$BUNDLE_DIR/timeline"
cat > "$BUNDLE_DIR/timeline/events.json" <<EOF
[
  {
    "id": "t_packet_generated",
    "type": "PACKET_GENERATED",
    "title": "Packet generated",
    "message": "Immutable incident packet generated.",
    "occurredAt": "$TS",
    "createdAt": "$TS",
    "orgId": "$ORG_ID",
    "incidentId": "$INCIDENT_ID"
  }
]
EOF

# --- contract snapshot stub
mkdir -p "$BUNDLE_DIR/contract"
cat > "$BUNDLE_DIR/contract/contract.json" <<EOF
{
  "snapshotAt": "$TS",
  "orgId": "$ORG_ID",
  "incidentId": "$INCIDENT_ID",
  "sourceContractId": "LIVE_CONTRACT",
  "status": "SNAPSHOTTED"
}
EOF

# --- filings stubs
mkdir -p "$BUNDLE_DIR/filings"

# file -> type label mapping (portable)
write_filing () {
  local file="$1"
  local type="$2"
  cat > "$BUNDLE_DIR/filings/$file.json" <<EOF
{
  "type": "$type",
  "status": "NOT_FILED",
  "generatedAt": "$TS",
  "source": "generator_v1"
}
EOF
}

write_filing "index" "INDEX"
write_filing "dirs"  "DIRS"
write_filing "oe417" "OE_417"
write_filing "nors"  "NORS"
write_filing "sar"   "SAR"
write_filing "baba"  "BABA"

# --- manifest.json
cat > "$BUNDLE_DIR/manifest.json" <<EOF
{
  "packetVersion": "v1",
  "generatedAt": "$TS",
  "files": [
    "packet_meta.json",
    "manifest.json",
    "hashes.json",
    "workflow.json",
    "timeline/events.json",
    "contract/contract.json",
    "filings/index.json",
    "filings/dirs.json",
    "filings/oe417.json",
    "filings/nors.json",
    "filings/sar.json",
    "filings/baba.json"
  ]
}
EOF

# --- hashes.json (JSON array)
(
  cd "$BUNDLE_DIR"
  # shasum output: "<sha>  <file>"
  # We emit: {"file":"path","sha256":"..."} per line
  find . -type f ! -name hashes.json -print0 \
    | xargs -0 shasum -a 256 \
    | awk 'BEGIN{print "["} {gsub(/^\.\//,"",$2); printf "  {\"file\":\"%s\",\"sha256\":\"%s\"}%s\n",$2,$1, (NR==0?"":",") } END{print "]"}' \
    | sed 's/}$/,}/' \
    | awk 'NR==1{print;next} {lines[NR]=$0} END{
        # remove trailing comma from last object line
        for(i=2;i<=NR;i++){
          line=lines[i]
          if(i==NR-1){ sub(/,\s*$/,"",line) }
          print line
        }
      }' > hashes.json
)

# --- zip
(
  cd "$BUNDLE_DIR"
  zip -qr "$ROOT/$OUT_ZIP" .
)

echo "==> Wrote ZIP: $OUT_ZIP"

# --- restart Next + smoke
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
sleep 2

BURL="http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"

echo "==> smoke bundle page"
curl -fsS "$BURL" >/dev/null || { echo "❌ bundle page failing"; tail -n 200 "$LOGDIR/next.log"; exit 1; }
echo "✅ bundle page OK"

echo "==> smoke download route (HEAD)"
curl -fsSI "$DURL" | head -n 30

echo
echo "OPEN:"
echo "  $BURL"
echo
echo "✅ ALL DONE — packet contract LOCKED (portable bash)."
