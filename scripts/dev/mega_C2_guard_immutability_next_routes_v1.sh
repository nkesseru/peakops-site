#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

mkdir -p .logs

write_route() {
  local path="$1"
  local content="$2"
  mkdir -p "$(dirname "$path")"
  cp -f "$path" "$path.bak_$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
  printf "%s\n" "$content" > "$path"
  echo "✅ wrote: $path"
}

COMMON_GUARD_TS='
import { NextResponse } from "next/server";
import { proxyGET, proxyPOST } from "../_lib/fnProxy";

export const runtime = "nodejs";

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function firestoreBase() {
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

async function isImmutable(incidentId: string): Promise<boolean> {
  const url = `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return false; // fail-open in dev
  const j: any = await r.json().catch(() => null);
  return !!j?.fields?.immutable?.booleanValue;
}

function getQ(req: Request) {
  const u = new URL(req.url);
  return u.searchParams;
}

async function guardOr409(req: Request, allowForce: boolean) {
  const q = getQ(req);
  const incidentId = String(q.get("incidentId") || "");
  const force = (q.get("force") || "") === "1";
  if (!incidentId) return null; // let underlying handler return its own 400s

  // If immutable and not forced (or force not allowed), block.
  const imm = await isImmutable(incidentId);
  if (imm) {
    if (allowForce && force) return null;
    return json(409, { ok: false, error: "IMMUTABLE: Incident is finalized" });
  }
  return null;
}
'

GEN_TL_TS="${COMMON_GUARD_TS}
export async function POST(req: Request) {
  const blocked = await guardOr409(req, false);
  if (blocked) return blocked;
  return proxyPOST(req, \"generateTimelineV1\");
}
"

GEN_FL_TS="${COMMON_GUARD_TS}
export async function POST(req: Request) {
  const blocked = await guardOr409(req, false);
  if (blocked) return blocked;
  return proxyPOST(req, \"generateFilingsV1\");
}
"

EXPORT_TS="${COMMON_GUARD_TS}
export async function GET(req: Request) {
  const blocked = await guardOr409(req, true); // allow force=1 override
  if (blocked) return blocked;
  return proxyGET(req, \"exportIncidentPacketV1\");
}
"

write_route "next-app/src/app/api/fn/generateTimelineV1/route.ts" "$GEN_TL_TS"
write_route "next-app/src/app/api/fn/generateFilingsV1/route.ts" "$GEN_FL_TS"
write_route "next-app/src/app/api/fn/exportIncidentPacketV1/route.ts" "$EXPORT_TS"

echo
echo "🧹 restart Next"
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port "${NEXT_PORT}" > ../.logs/next.log 2>&1 ) &
sleep 2

echo
echo "==> smoke: should be 409 for timeline/filings on immutable incident"
curl -sS -i -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST&requestedBy=smoke" | head -n 18 || true
echo
curl -sS -i -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST&requestedBy=smoke" | head -n 18 || true
echo
echo "==> smoke: export should be 409 (no force) then 200 (force=1)"
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST&requestedBy=smoke" | head -n 18 || true
echo
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST&requestedBy=smoke&force=1" | head -n 18 || true

echo
echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/inc_TEST?orgId=org_001"
echo "  Artifact: http://127.0.0.1:${NEXT_PORT}/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo
echo "LOGS:"
echo "  tail -n 200 .logs/next.log"
