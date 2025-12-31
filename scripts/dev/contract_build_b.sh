#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

INCIDENT_ID="${1:-}"          # optional
PURPOSE="${2:-REGULATORY}"    # optional

echo "==> Running Contract Build A first..."
bash scripts/dev/contract_build_a.sh "${INCIDENT_ID}" "${PURPOSE}"

# If A created it, capture last created incidentId from the printed resp file name.
# Prefer: arg > latest resp file.
if [[ -z "${INCIDENT_ID}" ]]; then
  INCIDENT_ID="$(ls -t resp_regpacket_inc_*.json 2>/dev/null | head -n 1 | sed -E 's/^resp_regpacket_(inc_[a-z0-9]+)\.json$/\1/')"
fi

RESP="resp_regpacket_${INCIDENT_ID}.json"
OUTDIR="unzipped_regpacket_${INCIDENT_ID}"

if [[ ! -f "$RESP" ]]; then
  echo "❌ missing $RESP (A didn't produce it)"
  exit 1
fi

echo
echo "==> (B1) Add contract/contract.json into $OUTDIR"
mkdir -p "$OUTDIR/contract"

python3 - <<'PY' "$RESP" "$OUTDIR/contract/contract.json"
import json,sys,datetime
resp=json.load(open(sys.argv[1]))
out=sys.argv[2]

contract = {
  "schemaVersion": "contract.v1",
  "orgId": resp.get("orgId"),
  "incidentId": resp.get("incidentId"),
  "purpose": resp.get("purpose"),
  "generatedAt": resp.get("generatedAt"),
  "packetHash": resp.get("packetHash"),
  "evidence": {
    "count": resp.get("countEvidence") or None
  },
  "signing": {
    "status": "UNSIGNED",
    "buyer": {"name": "", "title": "", "email": ""},
    "seller": {"name": "", "title": "", "email": ""},
    "signedAt": None
  },
  "notes": "Auto-generated placeholder contract metadata. Add real contract fields later."
}

open(out,"w").write(json.dumps(contract, indent=2))
print("✅ wrote", out)
PY

echo "==> (B2) Repack as contract packet zip"
NEWZIP="peakops_contractpacket_${INCIDENT_ID}_$(date -u +%Y-%m-%dT%H-%M-%SZ).zip"
rm -f "$NEWZIP"
( cd "$OUTDIR" && zip -qr "../$NEWZIP" . )
echo "✅ wrote $NEWZIP"
ls -lh "$NEWZIP"
echo

echo "✅ Contract Build B DONE"
echo "Contract packet: $NEWZIP"
