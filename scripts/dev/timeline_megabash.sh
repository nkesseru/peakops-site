#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

# --- find repo root ---
ROOT="$(pwd)"
if command -v git >/dev/null 2>&1; then
  TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "${TOP:-}" && -d "$TOP/next-app" ]]; then
    ROOT="$TOP"
  fi
fi

NEXT_DIR="$ROOT/next-app"
if [[ ! -d "$NEXT_DIR/src/app/api/fn" ]]; then
  echo "❌ Could not find next-app at: $NEXT_DIR"
  echo "   Run from repo root (the folder that contains next-app/)."
  exit 1
fi

echo "==> Timeline Mega Bash"
echo "ROOT=$ROOT"
echo "ORG_ID=$ORG_ID"
echo "INCIDENT_ID=$INCIDENT_ID"
echo "BASE_URL=$BASE_URL"
echo

# --- pick FN_BASE (from next-app/.env.local if present) ---
FN_BASE_DEFAULT="http://127.0.0.1:5001/peakops-pilot/us-central1"
FN_BASE="$FN_BASE_DEFAULT"
if [[ -f "$NEXT_DIR/.env.local" ]]; then
  FB="$(grep -E '^FN_BASE=' "$NEXT_DIR/.env.local" | tail -n 1 | cut -d= -f2- | tr -d '"' || true)"
  if [[ -n "${FB:-}" ]]; then
    FN_BASE="$FB"
  fi
fi
echo "==> FN_BASE=$FN_BASE"
echo

# --- choose the generator endpoint that actually exists ---
pick_endpoint() {
  local cands=("generateTimelineV2" "generateTimelineAndPersist" "generateTimelineV1" "generateTimeline")
  for ep in "${cands[@]}"; do
    # We probe via OPTIONS/GET-ish just to see if function exists (will often return 405 but NOT "does not exist")
    local out
    out="$(curl -sS "$FN_BASE/$ep" 2>/dev/null | head -c 180 || true)"
    if echo "$out" | grep -qi "does not exist"; then
      continue
    fi
    # If we got anything other than "does not exist", assume it's real
    echo "$ep"
    return 0
  done
  echo ""
  return 0
}

GEN_EP="$(pick_endpoint)"
if [[ -z "$GEN_EP" ]]; then
  echo "❌ Could not find a timeline generator function at FN_BASE."
  echo "   Quick: curl -sS \"$FN_BASE/hello\""
  exit 1
fi
echo "✅ Using generator endpoint: $GEN_EP"
echo

# --- create Next route: POST /api/fn/generateTimelineV1 -> proxyPOST to chosen endpoint ---
API_DIR="$NEXT_DIR/src/app/api/fn/generateTimelineV1"
API_ROUTE="$API_DIR/route.ts"
mkdir -p "$API_DIR"

cat > "$API_ROUTE" <<TS
import { proxyPOST } from "../_lib/fnProxy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return proxyPOST(req, "${GEN_EP}");
}
TS

echo "✅ wrote $API_ROUTE"
echo

# --- restart Next cleanly ---
echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

# --- call generator via Next route ---
echo "==> generate timeline via Next proxy"
curl -fsS -X POST "$BASE_URL/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 80

echo
echo "==> verify timeline/events.json inside packet zip"
TMP="/tmp/peak_timeline_verify_${INCIDENT_ID}_$$"
mkdir -p "$TMP"
curl -fsS "$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID" -o "$TMP/packet.zip"

unzip -l "$TMP/packet.zip" | grep -E "timeline/events\.json" >/dev/null \
  && echo "✅ timeline/events.json present in packet.zip" \
  || { echo "❌ timeline/events.json missing from packet.zip"; exit 1; }

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "If something errors, tail logs:"
echo "  tail -n 160 $ROOT/.logs/next.log"
