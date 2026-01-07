#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app
mkdir -p .logs

ORG_ID="${1:-org_001}"
CONTRACT_ID="${2:-car_abc123}"

echo "==> (0) hard stop ports + stray processes"
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true

echo "==> (1) force Next to emulator FN_BASE + default org"
ENVF="next-app/.env.local"
mkdir -p next-app
touch "$ENVF"
grep -q '^FN_BASE=' "$ENVF" && sed -i '' 's|^FN_BASE=.*|FN_BASE=http://127.0.0.1:5001/peakops-pilot/us-central1|' "$ENVF" || echo 'FN_BASE=http://127.0.0.1:5001/peakops-pilot/us-central1' >> "$ENVF"
grep -q '^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=' "$ENVF" && sed -i '' 's|^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=.*|NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=org_001|' "$ENVF" || echo 'NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=org_001' >> "$ENVF"
echo "✅ next-app/.env.local set"

echo "==> (2) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!
FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"

for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions not ready; tail emulators.log"
  tail -n 160 .logs/emulators.log || true
  exit 1
fi

echo "==> (3) start Next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ next not ready; tail next.log"
  tail -n 160 .logs/next.log || true
  exit 1
fi

echo "==> (4) SMOKE: direct function"
echo "--- hello ---"
curl -sS "$FN_BASE/hello" | head -c 160; echo
echo "--- getContractV1 (direct) ---"
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 600; echo

echo "==> (5) SMOKE: via Next proxy (what UI uses)"
echo "--- /api/fn/getContractV1 ---"
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 800; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
