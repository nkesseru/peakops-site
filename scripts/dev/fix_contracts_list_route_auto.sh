#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ORG_ID="${1:-org_001}"
LIMIT="${2:-5}"

# Try to detect FN_BASE from next-app/.env.local
FN_BASE="$(grep -E '^FN_BASE=' next-app/.env.local 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' || true)"
if [ -z "${FN_BASE}" ]; then
  FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
fi

echo "==> Using FN_BASE=$FN_BASE"
echo "==> Probing candidate list endpoints…"

probe () {
  local FN="$1"
  local URL="$FN_BASE/$FN?orgId=$ORG_ID&limit=$LIMIT"
  echo
  echo "---- $FN ----"
  echo "$URL"
  # Print HTTP status and first 200 chars of body
  RESP="$(curl -sS -D - "$URL" -o /tmp/_probe_body.txt || true)"
  STATUS="$(echo "$RESP" | head -n 1)"
  echo "$STATUS"
  head -c 200 /tmp/_probe_body.txt; echo
  # Return success if body contains ok:true and NOT the missing contractId error
  if grep -q '"ok"[[:space:]]*:[[:space:]]*true' /tmp/_probe_body.txt && ! grep -q 'Missing orgId/contractId' /tmp/_probe_body.txt; then
    return 0
  fi
  return 1
}

CHOSEN=""
if probe "listContractsV1"; then
  CHOSEN="listContractsV1"
elif probe "getContractsV1"; then
  CHOSEN="getContractsV1"
else
  echo
  echo "❌ Neither listContractsV1 nor getContractsV1 returned ok:true."
  echo "   That means the bug is in the cloud function side OR FN_BASE points somewhere unexpected."
  echo "   Quick check: curl -sS '$FN_BASE/hello' | head -c 120"
  exit 1
fi

echo
echo "✅ Chosen list function: $CHOSEN"

FILE="next-app/src/app/api/fn/getContractsV1/route.ts"
mkdir -p "$(dirname "$FILE")"

cat > "$FILE" <<TS
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

// Contracts LIST (no contractId required)
export async function GET(req: Request) {
  const url = new URL(req.url);

  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }

  return proxyGET(
    new Request(url.toString(), { method: "GET", headers: req.headers }),
    "${CHOSEN}"
  );
}
TS

echo "✅ patched: $FILE -> ${CHOSEN}"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> smoke via Next"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=$LIMIT" | head -c 220; echo
echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
