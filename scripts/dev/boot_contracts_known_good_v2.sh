#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
VERSION_ID="${4:-v1}"

REPO="$HOME/peakops/my-app"
LOGDIR="$REPO/.logs"
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

cd "$REPO"
mkdir -p "$LOGDIR"

echo "==> boot_contracts_known_good_v2"
echo "project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID version=$VERSION_ID"
echo

echo "==> (0) hard-kill ports (3000/5001/8080/8081/4000/4409/9150)"
lsof -tiTCP:3000,5001,8080,8081,4000,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

echo "==> (2) wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ functions never became ready"
  tail -n 120 "$LOGDIR/emulators.log" || true
  echo "Stop: kill $EMU_PID"
  exit 1
fi

echo "==> (3) point Next proxy at emulator + default orgId"
ENV_FILE="next-app/.env.local"
touch "$ENV_FILE"

# ensure FN_BASE points to emulator (not Cloud Run)
grep -q '^FN_BASE=' "$ENV_FILE" && sed -i '' "s|^FN_BASE=.*|FN_BASE=${FN_BASE}|g" "$ENV_FILE" || echo "FN_BASE=${FN_BASE}" >> "$ENV_FILE"
grep -q '^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=' "$ENV_FILE" && sed -i '' "s|^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=.*|NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=${ORG_ID}|g" "$ENV_FILE" || echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=${ORG_ID}" >> "$ENV_FILE"

echo "✅ next-app/.env.local set:"
echo "  FN_BASE=$FN_BASE"
echo "  NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID"
echo

echo "==> (4) start Next"
( cd next-app && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ next never became ready"
  tail -n 120 "$LOGDIR/next.log" || true
  echo "Stop: kill $EMU_PID $NEXT_PID"
  exit 1
fi

echo
echo "==> (5) smoke (Next -> fnProxy -> emulator)"
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=${ORG_ID}&contractId=${CONTRACT_ID}" | head -c 200; echo
echo

echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/${CONTRACT_ID}?orgId=${ORG_ID}"
echo
echo "EDIT (safe nano):"
echo "  nano \"next-app/src/app/admin/contracts/[id]/page.tsx\""
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
