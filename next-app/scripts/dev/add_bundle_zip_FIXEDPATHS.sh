#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

# --- Resolve ROOT + NEXT_DIR regardless of where script is launched from ---
PWD0="$(pwd)"
if [[ -d "./next-app/src/app" ]]; then
  ROOT="$PWD0"
  NEXT_DIR="$ROOT/next-app"
elif [[ -d "./src/app" && "$(basename "$PWD0")" == "next-app" ]]; then
  ROOT="$(cd .. && pwd)"
  NEXT_DIR="$PWD0"
else
  # last resort: walk up until we find next-app/src/app
  ROOT="$PWD0"
  while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app/src/app" ]]; do
    ROOT="$(cd "$ROOT/.." && pwd)"
  done
  if [[ ! -d "$ROOT/next-app/src/app" ]]; then
    echo "❌ Could not locate repo root containing next-app/src/app"
    echo "   Run from repo root or from next-app/."
    exit 1
  fi
  NEXT_DIR="$ROOT/next-app"
fi

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR" "$ROOT/scripts/dev/_bak"

echo "==> ROOT=$ROOT"
echo "==> NEXT_DIR=$NEXT_DIR"

# --- Locate the packet zip route robustly ---
PACKET_ROUTE="$NEXT_DIR/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$PACKET_ROUTE" ]]; then
  echo "⚠️  Expected not found: $PACKET_ROUTE"
  echo "==> Searching for downloadIncidentPacketZip/route.ts ..."
  FOUND="$(find "$NEXT_DIR/src/app/api" -path "*/downloadIncidentPacketZip/route.ts" -maxdepth 8 2>/dev/null | head -n 1 || true)"
  if [[ -z "${FOUND:-}" ]]; then
    echo "❌ Could not find downloadIncidentPacketZip/route.ts under $NEXT_DIR/src/app/api"
    exit 1
  fi
  PACKET_ROUTE="$FOUND"
fi
echo "✅ packet route: $PACKET_ROUTE"

# --- (Optional) sanity: confirm it parses (no-op edit) ---
cp "$PACKET_ROUTE" "$ROOT/scripts/dev/_bak/downloadIncidentPacketZip_route_$(date +%Y%m%d_%H%M%S).ts"

# --- Restart Next + emulators (safe stack boot) ---
echo "==> hard kill common ports + stray procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ hello not responding"; tail -n 160 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulator ready"

echo "==> start Next"
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> smoke incidents page"
INC_URL="$BASE/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
curl -fsS "$INC_URL" >/dev/null && echo "✅ incidents page OK"

echo "==> smoke packet zip HEAD"
DURL="$BASE/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
curl -fsSI "$DURL" | head -n 25 || { echo "❌ packet zip HEAD failing"; tail -n 200 "$LOGDIR/next.log"; exit 1; }

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  $INC_URL"
echo
echo "LOGS:"
echo "  tail -n 160 $LOGDIR/emulators.log"
echo "  tail -n 160 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
