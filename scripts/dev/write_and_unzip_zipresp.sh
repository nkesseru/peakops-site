#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

INCIDENT_ID="${1:-}"
test -n "$INCIDENT_ID" || { echo "Usage: $0 <INCIDENT_ID>"; exit 1; }

RESP="resp_${INCIDENT_ID}.json"
test -f "$RESP" || { echo "❌ missing $RESP"; exit 1; }

python3 - <<PY
import json, base64
d=json.load(open("${RESP}"))
fn=d.get("filename", f"peakops_evidence_${INCIDENT_ID}.zip")
open(fn,"wb").write(base64.b64decode(d["zipBase64"]))
print("✅ wrote", fn)
PY

ZIP_FILE="$(python3 -c "import json; print(json.load(open('${RESP}'))['filename'])")"
OUTDIR="unzipped_${INCIDENT_ID}"
mkdir -p "$OUTDIR"
unzip -o "$ZIP_FILE" -d "$OUTDIR" >/dev/null
echo "✅ extracted to $OUTDIR"
ls -la "$OUTDIR"
