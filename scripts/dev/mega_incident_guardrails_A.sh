#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

mkdir -p .logs

echo "==> (A1) write guard helper"
mkdir -p next-app/src/app/api/_lib
cat > next-app/src/app/api/_lib/guardrails.ts <<'TS'
import { NextResponse } from "next/server";

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}
function firestoreBase() {
  const host = mustEnv("FIRESTORE_EMULATOR_HOST");
  return `http://${host}/v1`;
}
function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

export async function assertImmutableOrThrow(req: Request, orgId: string, incidentId: string) {
  const u = new URL(req.url);
  const force = u.searchParams.get("force") === "1";
  if (force) return { ok: true, force: true };

  const docUrl =
    `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

  const r = await fetch(docUrl, { method: "GET" });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch {}

  if (!r.ok) throw new Error(j?.error?.message || t || `HTTP ${r.status}`);

  const immutable = !!j?.fields?.immutable?.booleanValue;
  if (immutable) {
    throw new Error("IMMUTABLE: incident is finalized (use force=1 for admin override)");
  }
  return { ok: true, force: false };
}

export function immutableReject(e: any) {
  const msg = String(e?.message || e);
  if (msg.startsWith("IMMUTABLE:")) return json(false, { error: msg }, 409);
  return null;
}
TS
echo "✅ wrote next-app/src/app/api/_lib/guardrails.ts"

echo "==> (A2) patch generateTimelineV1 + generateFilingsV1 + exportIncidentPacketV1 to respect immutable (unless force=1)"
patch_one() {
  local f="$1"
  test -f "$f" || { echo "⚠️ missing $f (skip)"; return 0; }
  cp "$f" "$f.bak_guard_$(date +%Y%m%d_%H%M%S)"

  # Insert import
  if ! rg -q "guardrails" "$f"; then
    perl -0777 -i -pe 's/import\s+\{\s*NextResponse\s*\}\s+from\s+"next\/server";/import { NextResponse } from "next\/server";\nimport { assertImmutableOrThrow, immutableReject } from "..\/..\/_lib\/guardrails";/s' "$f"
  fi

  # Add guard call inside handler (best-effort)
  # Look for: const orgId... const incidentId...
  if ! rg -q "assertImmutableOrThrow" "$f"; then
    perl -0777 -i -pe 's/(const\s+orgId\s*=\s*.*?;\s*\n\s*const\s+incidentId\s*=\s*.*?;\s*\n)/$1\n    try { await assertImmutableOrThrow(req as any, orgId, incidentId); } catch (e:any) { const r = immutableReject(e); if (r) return r; throw e; }\n/s' "$f"
  fi
  echo "✅ patched $f"
}

patch_one "next-app/src/app/api/fn/generateTimelineV1/route.ts"
patch_one "next-app/src/app/api/fn/generateFilingsV1/route.ts"
patch_one "next-app/src/app/api/fn/exportIncidentPacketV1/route.ts"

echo "==> (A3) restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> sanity: immutable should block writes (409) unless force=1"
curl -sS -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST" | head -c 180; echo
curl -sS -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST&force=1" | head -c 180; echo

echo "✅ A done"
