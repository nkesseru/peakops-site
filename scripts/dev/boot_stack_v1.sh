#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"

# kill only known ports + known dev processes
lsof -tiTCP:3000,5001,8080,8081,4000,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.4

mkdir -p .logs

# Start emulators (functions + firestore)
echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for /hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ emulators not ready"
  tail -n 120 .logs/emulators.log || true
  exit 1
fi

echo "✅ emulators ready (pid=$EMU_PID)"
echo "FN_BASE=$FN_BASE"

# Point Next at emulator
echo "==> point Next at emulator"
mkdir -p next-app
touch next-app/.env.local
grep -vE '^(FN_BASE|NEXT_PUBLIC_DEV_DEFAULT_ORG_ID)=' next-app/.env.local > /tmp/next_env_local.tmp || true
mv /tmp/next_env_local.tmp next-app/.env.local
{
  echo "FN_BASE=$FN_BASE"
  echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID"
} >> next-app/.env.local

# Start Next
echo "==> start Next :3000"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 && break
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ Next did not come up"
  tail -n 120 .logs/next.log || true
  exit 1
fi

echo "✅ next ready (pid=$NEXT_PID)"

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
