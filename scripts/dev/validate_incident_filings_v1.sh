#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

TMP="/tmp/peak_schema_${ORG_ID}_${INCIDENT_ID}_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$TMP"

echo "==> ORG_ID=$ORG_ID"
echo "==> INCIDENT_ID=$INCIDENT_ID"
echo "==> BASE_URL=$BASE_URL"
echo "==> TMP=$TMP"
echo

echo "==> (1) Pull incident bundle (filings payloads)"
BUNDLE_JSON="$TMP/bundle.json"
curl -fsS "$BASE_URL/api/fn/getIncidentBundleV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" > "$BUNDLE_JSON" \
  || { echo "❌ getIncidentBundleV1 failed"; exit 1; }

python3 - <<'PY' "$BUNDLE_JSON" "$TMP"
import json,sys,os
bundle=json.load(open(sys.argv[1]))
tmp=sys.argv[2]
if not bundle.get("ok"):
  raise SystemExit("bundle not ok: "+str(bundle.get("error")))
filings=bundle.get("filings") or []
by={}
for f in filings:
  t=(f.get("type") or f.get("filingType") or "").upper()
  if t: by[t]=f
# write payloads if present
for t in ["DIRS","OE_417"]:
  f=by.get(t)
  payload=(f or {}).get("payload") or {}
  out=os.path.join(tmp, f"{t}.payload.json")
  json.dump(payload, open(out,"w"), indent=2)
  print("✅ wrote", out, "keys=", len(payload.keys()) if isinstance(payload,dict) else "n/a")
PY

echo
echo "==> (2) Validate DIRS + OE_417 payloads (v1 rules)"
python3 - <<'PY' "$TMP/DIRS.payload.json" "$TMP/OE_417.payload.json" "$TMP"
import json,sys,os,re
dirs=json.load(open(sys.argv[1]))
oe=json.load(open(sys.argv[2]))
tmp=sys.argv[3]

def is_iso(s):
  if not isinstance(s,str): return False
  # loose ISO check
  return bool(re.match(r"^\d{4}-\d{2}-\d{2}T", s))

def req(d, path, typ=None):
  cur=d
  for p in path.split("."):
    if not isinstance(cur,dict) or p not in cur: return (False, None)
    cur=cur[p]
  if typ and not isinstance(cur, typ): return (False, cur)
  return (True, cur)

def validate_dirs(p):
  errs=[]
  ok,v=req(p,"filingType",str); 
  if not ok or v!="DIRS": errs.append("filingType must be 'DIRS'")
  ok,v=req(p,"incidentId",str); 
  if not ok or not v.strip(): errs.append("incidentId required (string)")
  ok,v=req(p,"orgId",str); 
  if not ok or not v.strip(): errs.append("orgId required (string)")
  ok,v=req(p,"startTime",str); 
  if not ok or not is_iso(v): errs.append("startTime required (ISO string)")
  ok,v=req(p,"outageType",str);
  if not ok or v not in ["WIRELINE","WIRELESS","BROADBAND","OTHER"]: errs.append("outageType required (WIRELINE/WIRELESS/BROADBAND/OTHER)")
  ok,v=req(p,"narrative",str);
  if not ok or len(v.strip())<10: errs.append("narrative required (>=10 chars)")
  ok,v=req(p,"affectedCount",(int,float));
  if not ok or v<0: errs.append("affectedCount required (number >=0)")
  ok,v=req(p,"location",dict);
  if not ok: errs.append("location required (object)")
  else:
    st=p.get("location",{}).get("state")
    if not isinstance(st,str) or len(st.strip())!=2: errs.append("location.state required (2-letter)")
  return errs

def validate_oe(p):
  errs=[]
  ok,v=req(p,"filingType",str); 
  if not ok or v!="OE_417": errs.append("filingType must be 'OE_417'")
  ok,v=req(p,"incidentId",str); 
  if not ok or not v.strip(): errs.append("incidentId required (string)")
  ok,v=req(p,"orgId",str); 
  if not ok or not v.strip(): errs.append("orgId required (string)")
  ok,v=req(p,"startTime",str); 
  if not ok or not is_iso(v): errs.append("startTime required (ISO string)")
  ok,v=req(p,"eventType",str);
  if not ok or len(v.strip())<3: errs.append("eventType required (string)")
  ok,v=req(p,"impact",str);
  if not ok or v not in ["PARTIAL_SERVICE","TOTAL_OUTAGE","DEGRADED","OTHER"]: errs.append("impact required (PARTIAL_SERVICE/TOTAL_OUTAGE/DEGRADED/OTHER)")
  ok,v=req(p,"narrative",str);
  if not ok or len(v.strip())<10: errs.append("narrative required (>=10 chars)")
  return errs

dirs_errs=validate_dirs(dirs if isinstance(dirs,dict) else {})
oe_errs=validate_oe(oe if isinstance(oe,dict) else {})

out={
  "ok": (len(dirs_errs)==0 and len(oe_errs)==0),
  "orgId": os.environ.get("ORG_ID","org_001"),
  "incidentId": os.environ.get("INCIDENT_ID","inc_TEST"),
  "results": {
    "DIRS": {"valid": len(dirs_errs)==0, "errors": dirs_errs},
    "OE_417": {"valid": len(oe_errs)==0, "errors": oe_errs},
  }
}

json.dump(out, open(os.path.join(tmp,"validation.json"),"w"), indent=2)
print("✅ wrote", os.path.join(tmp,"validation.json"))
print(json.dumps(out, indent=2))
PY

echo
echo "==> (3) Next move: show results + store into packet later"
echo "Validation file:"
echo "  $TMP/validation.json"
