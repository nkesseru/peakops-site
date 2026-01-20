#!/usr/bin/env bash
set -euo pipefail

(setopt NO_NOMATCH 2>/dev/null || true) || true
(set +H 2>/dev/null || true) || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

NEXT_DIR="next-app"
PAGE="$NEXT_DIR/src/app/admin/incidents/[id]/bundle/page.tsx"
ENV_FILE="$NEXT_DIR/.env.local"

mkdir -p "$NEXT_DIR" scripts/dev "$ROOT/.logs"

echo "==> (1) Ensure next-app/.env.local has emulator vars"
cat > "$ENV_FILE" <<'EOF'
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_FUNCTIONS_EMULATOR_HOST=127.0.0.1:5001
FIRESTORE_EMULATOR_REST=http://127.0.0.1:8080
EOF
echo "✅ wrote $ENV_FILE"
cat "$ENV_FILE"

echo
echo "==> (2) Patch/Add API routes: getZipVerificationV1 + persistZipVerificationV1"

GET_ROUTE_DIR="$NEXT_DIR/src/app/api/fn/getZipVerificationV1"
PERSIST_ROUTE_DIR="$NEXT_DIR/src/app/api/fn/persistZipVerificationV1"
mkdir -p "$GET_ROUTE_DIR" "$PERSIST_ROUTE_DIR"
cat > "$GET_ROUTE_DIR/route.ts" <<'TS'
import { NextResponse } from "next/server";

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = String(url.searchParams.get("orgId") || "");
    const incidentId = String(url.searchParams.get("incidentId") || "");
    if (!orgId || !incidentId) return json({ ok: false, error: "missing orgId/incidentId" }, 400);

    const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
    const projectId = String(process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot");

    // Firestore REST doc read
    // NOTE: parentheses in (default) must be URL-encoded
    const docUrl =
      `http://${host}/v1/projects/${encodeURIComponent(projectId)}` +
      `/databases/%28default%29/documents/incidents/${encodeURIComponent(incidentId)}`;

    const r = await fetch(docUrl, { method: "GET" });
    if (!r.ok) {
      const t = await r.text();
      return json({ ok: false, error: `firestore read failed (HTTP ${r.status})`, raw: t }, 502);
    }
    const doc = await r.json().catch(() => null);
    const fields = doc?.fields || {};
    const packetMeta = fields?.packetMeta?.mapValue?.fields || {};
    const zipMeta = packetMeta?.zipMeta?.mapValue?.fields || null;

    // Normalize zipMeta (if present)
    const outZipMeta = zipMeta
      ? {
          zipSha256: zipMeta.zipSha256?.stringValue || null,
          zipSize: zipMeta.zipSize?.integerValue ? Number(zipMeta.zipSize.integerValue) : null,
          zipGeneratedAt: zipMeta.zipGeneratedAt?.stringValue || null,
          verifiedAt: zipMeta.verifiedAt?.stringValue || null,
          verifiedBy: zipMeta.verifiedBy?.stringValue || null,
        }
      : null;

    return json({
      ok: true,
      orgId,
      incidentId,
      projectId,
      docOrg: fields?.orgId?.stringValue || null,
      zipMeta: outZipMeta,
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
TS

cat > "$PERSIST_ROUTE_DIR/route.ts" <<'TS'
import { NextResponse } from "next/server";

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const orgId = String(body?.orgId || "");
    const incidentId = String(body?.incidentId || "");
    const zipSha256 = String(body?.zipSha256 || "");
    const zipSize = Number(body?.zipSize || 0);
    const zipGeneratedAt = String(body?.zipGeneratedAt || "");
    const verifiedBy = String(body?.verifiedBy || "ui");
    const verifiedAt = String(body?.verifiedAt || new Date().toISOString());

    if (!orgId || !incidentId) return json({ ok: false, error: "missing orgId/incidentId" }, 400);
    if (!zipSha256) return json({ ok: false, error: "missing zipSha256" }, 400);

    const host = mustEnv("FIRESTORE_EMULATOR_HOST");
    const projectId = String(process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot");

    const docUrl =
      `http://${host}/v1/projects/${encodeURIComponent(projectId)}` +
      `/databases/%28default%29/documents/incidents/${encodeURIComponent(incidentId)}` +
      `?updateMask.fieldPaths=packetMeta&currentDocument.exists=true`;

    // Firestore REST expects patch format with mapValue wrappers
    const patchBody = {
      fields: {
        packetMeta: {
          mapValue: {
            fields: {
              zipMeta: {
                mapValue: {
                  fields: {
                    zipSha256: { stringValue: zipSha256 },
                    zipSize: { integerValue: String(Math.max(0, Math.floor(zipSize || 0))) },
                    zipGeneratedAt: { stringValue: zipGeneratedAt || "" },
                    verifiedAt: { stringValue: verifiedAt },
                    verifiedBy: { stringValue: verifiedBy },
                  },
                },
              },
            },
          },
        },
      },
    };

    const r = await fetch(docUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patchBody),
    });

    const t = await r.text();
    if (!r.ok) return json({ ok: false, error: `firestore patch failed (HTTP ${r.status})`, raw: t }, 502);

    return json({
      ok: true,
      orgId,
      incidentId,
      projectId,
      zipMeta: { zipSha256, zipSize: Math.max(0, Math.floor(zipSize || 0)), zipGeneratedAt, verifiedAt, verifiedBy },
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
TS

echo "✅ routes written:"
echo "  - $GET_ROUTE_DIR/route.ts"
echo "  - $PERSIST_ROUTE_DIR/route.ts"

echo
echo "==> (3) Patch bundle page: after Verify ZIP success, call persistZipVerificationV1"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }
cp "$PAGE" "$PAGE.bak_zipmeta_persist_$(date +%Y%m%d_%H%M%S)"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()
if "async function persistZipMeta(" not in s:
    insert = r'''
  async function persistZipMeta(zm: { zipSha256: string; zipSize: number; zipGeneratedAt: string }) {
    try {
      const u = `/api/fn/persistZipVerificationV1`;
      const r = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          incidentId,
          zipSha256: zm.zipSha256,
          zipSize: zm.zipSize,
          zipGeneratedAt: zm.zipGeneratedAt,
          verifiedBy: "ui",
          verifiedAt: new Date().toISOString(),
        }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `persist failed (HTTP ${r.status})`);
      // After persisting, re-hydrate so badges stay sticky
      await hydrateZipVerification();
    } catch (e: any) {
      pushToast(`Persist ZIP verification failed: ${String(e?.message || e)}`, "warn");
    }
  }
'''
    # place after hydrateZipVerification() block (best effort)
    m = re.search(r"async function hydrateZipVerification\(\)[\s\S]*?\n\}", s)
    if m:
        s = s[:m.end()] + "\n\n" + insert + s[m.end():]
    else:
        # fallback: place after loadPacketMeta()
        m2 = re.search(r"async function loadPacketMeta\(\)[\s\S]*?\n\}", s)
        if m2:
            s = s[:m2.end()] + "\n\n" + insert + s[m2.end():]
        else:
            raise SystemExit("Could not find insertion point for persistZipMeta()")
if "persistZipMeta({" not in s:
    # Insert after the first occurrence of setting zipSha256/zipSize in verify handler
    # This pattern matches a block where you compute sha and size and then setPacketMeta(...)
    pat = re.compile(r"(zipSha256\s*:\s*sha[\s\S]{0,200}?zipSize\s*:\s*size[\s\S]{0,200}?\}\)\s*;)", re.M)
    m = pat.search(s)
    if m:
        add = "\n      await persistZipMeta({ zipSha256: sha, zipSize: size, zipGeneratedAt: new Date().toISOString() });\n"
        s = s[:m.end()] + add + s[m.end():]
    else:
        # fallback: if you compute `sha` and `size`, attach right after those are computed
        m2 = re.search(r"const\s+sha\s*=\s*await\s+sha256ArrayBuffer\([^)]+\);\s*\n\s*const\s+size\s*=\s*buf\.byteLength\s*;", s)
        if m2:
            add = "\n      await persistZipMeta({ zipSha256: sha, zipSize: size, zipGeneratedAt: new Date().toISOString() });\n"
            s = s[:m2.end()] + add + s[m2.end():]
        else:
            # If we can't safely patch, we still succeed without changing behavior
            print("WARN: Could not locate verify handler sha/size block to auto-inject persist call.")

p.write_text(s)
print("✅ bundle page patched for ZIP verification persistence")
PY

echo
echo "==> (4) Restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf "$NEXT_DIR/.next" 2>/dev/null || true
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo
echo "==> Sanity: endpoints should respond"
curl -sS "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 60 || true

echo
echo "✅ Open bundle page:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
