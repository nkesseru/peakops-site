#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

# --- (1) Ensure proxy helper exists ---
mkdir -p next-app/src/app/api/_lib

cat > next-app/src/app/api/_lib/fnProxy.ts <<'TS'
import { NextResponse } from "next/server";

function getBase() {
  // Prefer Next runtime env, fallback to emulator
  return process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
}

function buildUrl(req: Request, fnName: string) {
  const base = getBase().replace(/\/+$/, "");
  const url = new URL(req.url);

  // Copy query params
  const qs = url.searchParams.toString();

  // Cloud Run functions are like: https://<name>-...a.run.app  (no /us-central1)
  // Emulator/CloudFunctions are like: http://127.0.0.1:5001/<project>/us-central1
  const target = base.includes("a.run.app")
    ? `${base}/${fnName}${qs ? `?${qs}` : ""}`
    : `${base}/${fnName}${qs ? `?${qs}` : ""}`;

  return target;
}

export async function proxyGET(req: Request, fnName: string) {
  const target = buildUrl(req, fnName);
  const r = await fetch(target, { method: "GET" });
  const text = await r.text();
  // Return raw text if not JSON
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return new NextResponse(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "text/plain" } });
  }
}

export async function proxyPOST(req: Request, fnName: string) {
  const target = buildUrl(req, fnName);
  const body = await req.text();
  const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return new NextResponse(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "text/plain" } });
  }
}
TS

# --- (2) Add exportContractPacketV1 route ---
mkdir -p next-app/src/app/api/fn/exportContractPacketV1

cat > next-app/src/app/api/fn/exportContractPacketV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyGET(req, "exportContractPacketV1");
}
TS

echo "✅ patched Next proxy + added /api/fn/exportContractPacketV1"
echo ""
echo "Next step:"
echo "  1) Set next-app/.env.local FN_BASE to your Cloud Run function base"
echo "  2) Restart next dev"
