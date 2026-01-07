#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app
mkdir -p .logs

echo "==> (0) Kill ports (3000,5001,8080,8081,4000,4409,9150)"
lsof -tiTCP:3000,5001,8080,8081,4000,4409,9150 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Start emulators (functions+firestore) in background"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
echo "==> (2) Wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions never became ready"
  tail -n 80 .logs/emulators.log || true
  echo "Stop: kill $EMU_PID"
  exit 1
fi

echo "==> (3) Start Next (port 3000) in background"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

echo "==> (4) Wait for Next"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ next never became ready"
  tail -n 120 .logs/next.log || true
  echo "Stop: kill $EMU_PID $NEXT_PID"
  exit 1
fi

echo
echo "✅ STACK UP"
echo "FN_BASE=$FN_BASE"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
