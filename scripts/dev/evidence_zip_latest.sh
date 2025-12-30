#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> Finding most recent incident with evidence..."
echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"
echo

# pull incidents json first (and fail loudly if not JSON)
INC_JSON="$(mktemp)"
curl -sS "$FN_BASE/listIncidents?orgId=$ORG_ID" > "$INC_JSON" || true
FIRST="$(python3 - <<'PY' "$INC_JSON"
import sys, pathlib
s=pathlib.Path(sys.argv[1]).read_text(errors="ignore").lstrip()
print(s[:1])
PY
)"
if [[ "$FIRST" != "{" ]]; then
  echo "❌ listIncidents did not return JSON. First 200 chars:"
  head -c 200 "$INC_JSON"; echo
  echo "   Your Functions emulator likely didn't load functions."
  echo "   Check: grep -n \"Loaded functions definitions\" .logs/emulators.log | tail"
  exit 1
fi

INCIDENT_ID="$(python3 - <<'PY' "$INC_JSON"
import json,sys,urllib.request,urllib.error
FN_BASE = None
ORG_ID = None
# read from env (bash already set them)
import os
FN_BASE = os.environ.get("FN_BASE")
ORG_ID = os.environ.get("ORG_ID")

data=json.load(open(sys.argv[1]))
incs=data.get("incidents",[]) or []

def has_evidence(iid:str)->bool:
  url=f"{FN_BASE}/listEvidenceLocker?orgId={ORG_ID}&incidentId={iid}&limit=1"
  try:
    with urllib.request.urlopen(url, timeout=3) as r:
      j=json.load(r)
      return int(j.get("count",0) or 0) > 0
  except Exception:
    return False

# newest last in your API; we scan reversed to grab most recent
for inc in reversed(incs):
  iid = inc.get("id") or inc.get("incidentId")
  if not iid:
    continue
  if has_evidence(iid):
    print(iid)
    break
PY
)"

rm -f "$INC_JSON"

if [[ -z "${INCIDENT_ID:-}" ]]; then
  echo "❌ No incident with evidence found."
  exit 1
fi

echo "✅ Latest incident with evidence: $INCIDENT_ID"
echo
bash scripts/dev/evidence_zip_pull.sh "$INCIDENT_ID"
