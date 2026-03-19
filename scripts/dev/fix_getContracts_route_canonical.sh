#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/api/fn/getContractsV1/route.ts"
mkdir -p "$(dirname "$FILE")"

cat > "$FILE" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);

  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }

  // Canonical list function (no contractId needed)
  return proxyGET(
    new Request(url.toString(), { method: "GET", headers: req.headers }),
    "getContractsV1"
  );
}
TS

echo "✅ patched: $FILE -> getContractsV1"

pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> smoke"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=org_001&limit=5" | python3 -m json.tool | head -n 80
