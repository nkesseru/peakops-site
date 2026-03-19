#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

NEXT_DIR="next-app"
ROUTE_ROOT="$NEXT_DIR/src/app/api/fn"
PAGE="$NEXT_DIR/src/app/admin/incidents/[id]/bundle/page.tsx"
LOGDIR=".logs"

mkdir -p "$LOGDIR" \
  "$ROUTE_ROOT/getIncidentLockV1" \
  "$ROUTE_ROOT/finalizeIncidentV1"

test -f "$PAGE" || { echo "❌ missing page: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_finalize_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_finalize_*"

# Ensure Next env has emulator vars (so routes can talk to Firestore REST emulator)
ENV_FILE="$NEXT_DIR/.env.local"
touch "$ENV_FILE"
upsert_env () {
  local key="$1"
  local val="$2"
  if rg -n "^${key}=" "$ENV_FILE" >/dev/null 2>&1; then
    perl -0777 -i -pe "s/^${key}=.*\$/${key}=${val}/m" "$ENV_FILE"
  else
    printf "\n%s=%s\n" "$key" "$val" >> "$ENV_FILE"
  fi
}
upsert_env "FIRESTORE_EMULATOR_HOST" "127.0.0.1:8080"
upsert_env "FIRESTORE_EMULATOR_REST" "http://127.0.0.1:8080"

echo "✅ updated next-app/.env.local (tail)"
tail -n 8 "$ENV_FILE" || true

# --------------------------
# Route: GET lock state
# --------------------------
cat > "$ROUTE_ROOT/getIncidentLockV1/route.ts" <<'TS'
import { NextResponse } from "next/server";

function json(ok: boolean, obj: any, status = 200) {
  return NextResponse.json({ ok, ...obj }, { status });
}

function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function firestoreDocUrl(projectId: string, path: string) {
  const base = envOrThrow("FIRESTORE_EMULATOR_REST").replace(/\/+$/, "");
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`;
}

function readField(fields: any, key: string) {
  const f = fields?.[key];
  if (!f) return null;
  if (typeof f.booleanValue === "boolean") return f.booleanValue;
  if (typeof f.stringValue === "string") return f.stringValue;
  if (typeof f.integerValue === "string") return Number(f.integerValue);
  return null;
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    const projectId = process.env.PROJECT_ID || process.env.NEXT_PUBLIC_PROJECT_ID || "peakops-pilot";
    if (!orgId || !incidentId) return json(false, { error: "orgId and incidentId required" }, 400);

    const docUrl = firestoreDocUrl(projectId, `incidents/${encodeURIComponent(incidentId)}`);
    const r = await fetch(docUrl, { method: "GET" });
    const t = await r.text();
    let j: any = null;
    try { j = JSON.parse(t); } catch { /* ignore */ }

    if (!r.ok) return json(false, { error: j?.error?.message || t || `HTTP ${r.status}` }, 404);

    const fields = j?.fields || {};
    const immutable = !!readField(fields, "immutable");
    const immutableAt = readField(fields, "immutableAt");
    const immutableBy = readField(fields, "immutableBy");

    return json(true, { orgId, incidentId, projectId, immutable, immutableAt, immutableBy }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
TS

# --------------------------
# Route: POST finalize (lock)
# --------------------------
cat > "$ROUTE_ROOT/finalizeIncidentV1/route.ts" <<'TS'
import { NextResponse } from "next/server";

function json(ok: boolean, obj: any, status = 200) {
  return NextResponse.json({ ok, ...obj }, { status });
}

function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function firestoreDocUrl(projectId: string, path: string) {
  const base = envOrThrow("FIRESTORE_EMULATOR_REST").replace(/\/+$/, "");
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const orgId = String(body?.orgId || "");
    const incidentId = String(body?.incidentId || "");
    const immutableBy = String(body?.immutableBy || "ui");
    const immutableReason = String(body?.immutableReason || "");

    const projectId = process.env.PROJECT_ID || process.env.NEXT_PUBLIC_PROJECT_ID || "peakops-pilot";
    if (!orgId || !incidentId) return json(false, { error: "orgId and incidentId required" }, 400);

    const docUrl = firestoreDocUrl(projectId, `incidents/${encodeURIComponent(incidentId)}`);

    const gr = await fetch(docUrl, { method: "GET" });
    const gt = await gr.text();
    let getJ: any = null;
    try { getJ = JSON.parse(gt); } catch { /* ignore */ }
    if (!gr.ok) return json(false, { error: getJ?.error?.message || gt || `HTTP ${gr.status}` }, 404);

    const alreadyImmutable = !!getJ?.fields?.immutable?.booleanValue;
    if (alreadyImmutable) {
      return json(true, {
        orgId, incidentId, projectId,
        immutable: true,
        immutableAt: getJ?.fields?.immutableAt?.stringValue || null,
        immutableBy: getJ?.fields?.immutableBy?.stringValue || null,
        note: "already immutable",
      }, 200);
    }

    const nowIso = new Date().toISOString();
    const patchUrl =
      docUrl +
      `?updateMask.fieldPaths=immutable` +
      `&updateMask.fieldPaths=immutableAt` +
      `&updateMask.fieldPaths=immutableBy` +
      (immutableReason ? `&updateMask.fieldPaths=immutableReason` : "");

    const patchBody: any = {
      fields: {
        immutable: { booleanValue: true },
        immutableAt: { stringValue: nowIso },
        immutableBy: { stringValue: immutableBy },
      },
    };
    if (immutableReason) patchBody.fields.immutableReason = { stringValue: immutableReason };

    const pr = await fetch(patchUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patchBody),
    });

    const pt = await pr.text();
    let pj: any = null;
    try { pj = JSON.parse(pt); } catch { /* ignore */ }
    if (!pr.ok) return json(false, { error: pj?.error?.message || pt || `HTTP ${pr.status}` }, 500);

    return json(true, { orgId, incidentId, projectId, immutable: true, immutableAt: nowIso, immutableBy }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
TS

echo "✅ routes written: getIncidentLockV1 + finalizeIncidentV1"

# Restart Next cleanly
echo "<0001f9f9> clearing Next cache"
rm -rf "$NEXT_DIR/.next" 2>/dev/null || true

echo "🚀 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo "==> sanity: lock read"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentLockV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80 || true

echo
echo "✅ Open bundle page:"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" 2>/dev/null || true

echo
echo "NEXT:"
echo "  1) Verify ZIP (green)"
echo "  2) Click Finalize Incident"
echo "  3) Hard refresh"
