#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

FILE="next-app/src/app/api/fn/getContractsV1/route.ts"
mkdir -p "$(dirname "$FILE")"

cat > "$FILE" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

// NOTE: this is the *LIST* endpoint (NO contractId required)
export async function GET(req: Request) {
  const url = new URL(req.url);

  // dev default (keeps UI from hard failing if orgId drops)
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }

  return proxyGET(
    new Request(url.toString(), { method: "GET", headers: req.headers }),
    "listContractsV1"
  );
}
TS

echo "✅ patched: $FILE (now proxies -> listContractsV1)"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> smoke"
curl -i "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=org_001&limit=5" | head -n 20
echo
