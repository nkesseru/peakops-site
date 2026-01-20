#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

INCIDENT_ID="${1:-}"
if [[ -z "$INCIDENT_ID" ]]; then
  echo "Usage: $0 <INCIDENT_ID>"
  exit 1
fi

cd ~/peakops/my-app

set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
LIMIT="${LIMIT:-200}"

echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"
echo "==> INCIDENT_ID=$INCIDENT_ID"
echo "==> LIMIT=$LIMIT"
echo

curl_json () {
  local url="$1"
  local out="$2"

  local tmp_body tmp_hdr
  tmp_body="$(mktemp)"
  tmp_hdr="$(mktemp)"

  # capture headers + body
  curl -sS -D "$tmp_hdr" -o "$tmp_body" "$url" || true

  # quick JSON sanity check (first non-space char)
  local first
  first="$(python3 - <<'PY' "$tmp_body"
import sys, pathlib
p=pathlib.Path(sys.argv[1])
s=p.read_text(errors="ignore").lstrip()
print(s[:1])
PY
)"
  if [[ "$first" != "{" && "$first" != "[" ]]; then
    echo "❌ Expected JSON from: $url"
    echo "   First 200 chars:"
    head -c 200 "$tmp_body"; echo
    echo "   Tip: your Functions emulator probably didn't load functions. Check:"
    echo "        grep -n \"Loaded functions definitions\" .logs/emulators.log | tail"
    rm -f "$tmp_body" "$tmp_hdr"
    exit 1
  fi

  mv "$tmp_body" "$out"
  rm -f "$tmp_hdr"
}

echo "==> (1) Confirm evidence exists"
LIST="list_${INCIDENT_ID}.json"
curl_json "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=1" "$LIST"

COUNT="$(python3 - <<'PY' "$LIST"
import json,sys
d=json.load(open(sys.argv[1]))
print(int(d.get("count",0) or 0))
PY
)"
echo "count=$COUNT"
if [[ "$COUNT" -le 0 ]]; then
  echo "❌ NO_EVIDENCE for $INCIDENT_ID"
  exit 1
fi
echo

echo "==> (2) Export ZIP"
RESP="resp_${INCIDENT_ID}.json"
curl_json "$FN_BASE/exportEvidenceLockerZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=$LIMIT" "$RESP"
python3 -m json.tool < "$RESP" | head -n 40
echo

ZIP_FILE="$(python3 - <<'PY' "$RESP"
import json,sys
d=json.load(open(sys.argv[1]))
if not d.get("ok"):
  raise SystemExit("exportEvidenceLockerZip returned ok=false")
print(d["filename"])
PY
)"

echo "==> (3) Write ZIP file: $ZIP_FILE"
python3 - <<'PY' "$RESP"
import json,base64,sys
d=json.load(open(sys.argv[1]))
fn=d["filename"]
b64=d["zipBase64"]
data=base64.b64decode(b64)
open(fn,"wb").write(data)
print("✅ wrote", fn, "bytes=", len(data))
PY

echo
echo "==> (4) Unzip"
OUTDIR="unzipped_${INCIDENT_ID}"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"
unzip -o "$ZIP_FILE" -d "$OUTDIR" >/dev/null
echo "✅ extracted to $OUTDIR"
find "$OUTDIR" -type f -maxdepth 3

echo
echo "==> DONE"
echo "ZIP:    $ZIP_FILE"
echo "Folder: $OUTDIR"
