#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # avoid zsh history expansion weirdness with !

cd ~/peakops/my-app
mkdir -p .logs scripts/dev

echo "==> (0) Kill ports + stray dev/emulators"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Patch fnProxy to use AbortController timeout (10s) + better error"
FNPROXY="next-app/src/app/api/_lib/fnProxy.ts"
if [ -f "$FNPROXY" ]; then
  python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/api/_lib/fnProxy.ts")
s = p.read_text()

# ensure we import nothing extra; just use AbortController inline
def patch_fetch(fn_name: str):
    # find "await fetch(target" in proxyGET/proxyPOST and wrap with AbortController
    return

# crude but reliable: replace first fetch call in proxyGET and proxyPOST blocks
import re

def wrap_fetch_block(txt):
    # Replace: const r = await fetch(target, { method: "GET" });
    txt = re.sub(
        r'const r = await fetch\(target, \{ method: "GET" \}\);',
        'const ac = new AbortController();\n'
        '  const t = setTimeout(() => ac.abort(), 10000);\n'
        '  let r;\n'
        '  try {\n'
        '    r = await fetch(target, { method: "GET", signal: ac.signal });\n'
        '  } finally {\n'
        '    clearTimeout(t);\n'
        '  }',
        txt,
        count=1,
    )
    # Replace POST fetch line similarly (match method: "POST")
    txt = re.sub(
        r'const r = await fetch\(target, \{ method: "POST", headers: \{[^}]*\}, body \}\);',
        'const ac = new AbortController();\n'
        '  const t = setTimeout(() => ac.abort(), 10000);\n'
        '  let r;\n'
        '  try {\n'
        '    r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ac.signal });\n'
        '  } finally {\n'
        '    clearTimeout(t);\n'
        '  }',
        txt,
        count=1,
    )
    return txt

if "setTimeout(() => ac.abort(), 10000)" not in s:
    s2 = wrap_fetch_block(s)
    if s2 == s:
        print("⚠️ fnProxy patch didn't match expected patterns; leaving file unchanged.")
    else:
        p.write_text(s2)
        print("✅ patched fnProxy timeout (10s)")
else:
    print("✅ fnProxy already has timeout")
PY
else
  echo "⚠️ Missing $FNPROXY (skipping patch)"
fi

echo "==> (2) Start emulators (functions + firestore)"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"

echo "==> (3) Wait for functions /hello"
ok=0
for i in $(seq 1 80); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.25
done
if [ "$ok" != "1" ]; then
  echo "❌ functions never became ready"
  tail -n 120 .logs/emulators.log || true
  echo "Stop: kill $EMU_PID"
  exit 1
fi
echo "✅ functions ready (pid=$EMU_PID)  FN_BASE=$FN_BASE"

echo "==> (4) Force next-app/.env.local FN_BASE to emulator (so Next never points to Cloud Run by accident)"
ENV_LOCAL="next-app/.env.local"
mkdir -p next-app
touch "$ENV_LOCAL"
# delete any existing FN_BASE line, then append correct one
python3 - <<'PY'
from pathlib import Path
p = Path("next-app/.env.local")
lines = p.read_text().splitlines()
lines = [ln for ln in lines if not ln.startswith("FN_BASE=")]
lines.append("FN_BASE=http://127.0.0.1:5001/peakops-pilot/us-central1")
# optional: dev default org
if not any(ln.startswith("NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=") for ln in lines):
    lines.append("NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=org_001")
p.write_text("\n".join(lines) + "\n")
print("✅ wrote next-app/.env.local FN_BASE + NEXT_PUBLIC_DEV_DEFAULT_ORG_ID")
PY

echo "==> (5) Start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

echo "==> (6) Wait for Next"
ok=0
for i in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.25
done
if [ "$ok" != "1" ]; then
  echo "❌ Next never became ready"
  tail -n 120 .logs/next.log || true
  echo "Stop: kill $EMU_PID $NEXT_PID"
  exit 1
fi
echo "✅ next ready (pid=$NEXT_PID)"

echo "==> (7) Smoke (Next -> fnProxy -> functions emulator)"
curl -m 10 -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=org_001&limit=5" | head -c 300; echo
curl -m 10 -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=org_001&contractId=car_abc123" | head -c 300; echo

echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
