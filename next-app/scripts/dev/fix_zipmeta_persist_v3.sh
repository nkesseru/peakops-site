#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

NEXT_DIR="next-app"
PAGE="$NEXT_DIR/src/app/admin/incidents/[id]/bundle/page.tsx"
ENV_FILE="$NEXT_DIR/.env.local"
GET_ROUTE="$NEXT_DIR/src/app/api/fn/getZipVerificationV1/route.ts"
PERSIST_ROUTE="$NEXT_DIR/src/app/api/fn/persistZipVerificationV1/route.ts"

mkdir -p "$NEXT_DIR/src/app/api/fn/getZipVerificationV1" "$NEXT_DIR/src/app/api/fn/persistZipVerificationV1" scripts/dev "$ROOT/.logs"

echo "==> (1) Ensure next-app/.env.local has emulator vars"
cat > "$ENV_FILE" <<'EOF'
# Firebase Emulator (used by Next API routes)
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_FUNCTIONS_EMULATOR_HOST=127.0.0.1:5001
FIRESTORE_EMULATOR_REST=http://127.0.0.1:8080
EOF
echo "✅ wrote $ENV_FILE"

echo
echo "==> (2) Write/overwrite API routes (deterministic)"
cat > "$GET_ROUTE" <<'TS'
import { NextResponse } from "next/server";

function json(v: any, status = 200) {
  return new NextResponse(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Firestore emulator not configured (${name} missing)`);
  return v;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) return json({ ok: false, error: "Missing orgId or incidentId" }, 400);

    const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
    const base = `http://${host}/v1/projects/peakops-pilot/databases/(default)/documents`;
    const docPath = `orgs/${encodeURIComponent(orgId)}/incidents/${encodeURIComponent(incidentId)}/packetMeta/zipVerification`;

    const r = await fetch(`${base}/${docPath}`);
    if (r.status === 404) {
      return json({ ok: true, orgId, incidentId, projectId: "peakops-pilot", docOrg: orgId, zipMeta: null }, 200);
    }
    const j = await r.json().catch(() => null);
    const f = j?.fields || null;
    const sv = (x: any) => x?.stringValue ?? null;
    const iv = (x: any) => (x?.integerValue != null ? Number(x.integerValue) : null);

    const zipMeta = f
      ? {
          zipSha256: sv(f.zipSha256),
          zipSize: iv(f.zipSize),
          zipGeneratedAt: sv(f.zipGeneratedAt),
          verifiedAt: sv(f.verifiedAt),
          verifiedBy: sv(f.verifiedBy),
        }
      : null;

    return json({ ok: true, orgId, incidentId, projectId: "peakops-pilot", docOrg: orgId, zipMeta }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
TS

cat > "$PERSIST_ROUTE" <<'TS'
import { NextResponse } from "next/server";

function json(v: any, status = 200) {
  return new NextResponse(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Firestore emulator not configured (${name} missing)`);
  return v;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const orgId = String(body?.orgId || "");
    const incidentId = String(body?.incidentId || "");
    const zipSha256 = String(body?.zipSha256 || "");
    const zipSize = Number(body?.zipSize || 0) || 0;
    const zipGeneratedAt = String(body?.zipGeneratedAt || "");
    const verifiedBy = String(body?.verifiedBy || "ui");
    const verifiedAt = String(body?.verifiedAt || new Date().toISOString());

    if (!orgId || !incidentId || !zipSha256) return json({ ok: false, error: "Missing orgId/incidentId/zipSha256" }, 400);

    const host = mustEnv("FIRESTORE_EMULATOR_HOST");
    const base = `http://${host}/v1/projects/peakops-pilot/databases/(default)/documents`;
    const docPath = `orgs/${encodeURIComponent(orgId)}/incidents/${encodeURIComponent(incidentId)}/packetMeta/zipVerification`;

    const payload = {
      fields: {
        zipSha256: { stringValue: zipSha256 },
        zipSize: { integerValue: String(Math.max(0, Math.floor(zipSize))) },
        zipGeneratedAt: { stringValue: zipGeneratedAt || "" },
        verifiedAt: { stringValue: verifiedAt },
        verifiedBy: { stringValue: verifiedBy },
      },
    };

    const r = await fetch(`${base}/${docPath}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const j = await r.json().catch(() => null);
    if (!r.ok) return json({ ok: false, error: j?.error?.message || `Firestore write failed (HTTP ${r.status})`, raw: j }, 500);

    return json({ ok: true, orgId, incidentId, zipMeta: { zipSha256, zipSize, zipGeneratedAt, verifiedAt, verifiedBy } }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
TS

echo "✅ routes written:"
echo "  - $GET_ROUTE"
echo "  - $PERSIST_ROUTE"

echo
echo "==> (3) Patch bundle page: add persistZipMeta() + wire into handleVerifyZip (idempotent)"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }
cp "$PAGE" "$PAGE.bak_zipmeta_persist_v3_$(date +%Y%m%d_%H%M%S)"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# Ensure hydrateZipVerification is called on mount (once orgId/incidentId known)
if "hydrateZipVerification();" not in s:
    # find the main useEffect that calls loadPacketMeta (or create one)
    m = re.search(r"useEffect\(\(\)\s*=>\s*\{\s*void\s+loadPacketMeta\(\);\s*// eslint-disable-next-line react-hooks/exhaustive-deps\s*\}\s*,\s*\[orgId,\s*incidentId,\s*contractId\]\s*\);\s*", s)
    if m:
        block = m.group(0)
        block2 = block.replace("void loadPacketMeta();", "void loadPacketMeta();\n    void hydrateZipVerification();")
        s = s.replace(block, block2)
    else:
        # fallback: inject a new useEffect after state declarations
        anchor = re.search(r"const \[manifestItems, setManifestItems\] = useState<[^;]+;\s*\n", s)
        if anchor:
            ins = "\n  useEffect(() => {\n    void loadPacketMeta();\n    void hydrateZipVerification();\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [orgId, incidentId, contractId]);\n"
            s = s[:anchor.end()] + ins + s[anchor.end():]

# Add persistZipMeta helper if missing
if "async function persistZipMeta" not in s:
    helper = r'''
  async function persistZipMeta(args: { zipSha256: string; zipSize: number; zipGeneratedAt: string }) {
    try {
      const r = await fetch("/api/fn/persistZipVerificationV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          incidentId,
          zipSha256: args.zipSha256,
          zipSize: args.zipSize,
          zipGeneratedAt: args.zipGeneratedAt,
          verifiedBy: "ui",
          verifiedAt: new Date().toISOString(),
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `persist failed (HTTP ${r.status})`);
      setZipVerified(true);
      await hydrateZipVerification();
      pushToast("ZIP verification persisted ✅", "ok");
    } catch (e: any) {
      pushToast(`Persist ZIP verification failed: ${String(e?.message || e)}`, "warn");
    }
  }
'''
    # insert after hydrateZipVerification function
    m = re.search(r"async function hydrateZipVerification\(\)[\s\S]*?\n\}", s)
    if not m:
        raise SystemExit("Could not find hydrateZipVerification() to insert persistZipMeta() after.")
    s = s[:m.end()] + "\n" + helper + s[m.end():]

# Wire into handleVerifyZip: after sha match success, call persistZipMeta
# We look for the success toast "ZIP verified" or "sha256 matches" patterns
if "persistZipMeta(" not in s:
    # Find handleVerifyZip function block
    hv = re.search(r"async function handleVerifyZip\(\)[\s\S]*?\n\}", s)
    if not hv:
        raise SystemExit("Could not find handleVerifyZip() function.")
    block = hv.group(0)

    # We expect the code computed sha and has expectedSha from packetMeta?.zipSha256
    # Inject right after it sets zipVerified true OR right after success toast
    if "setZipVerified(true)" in block:
        block2 = block.replace(
            "setZipVerified(true);",
            "setZipVerified(true);\n      if (expectedSha && sha && expectedSha === sha) {\n        await persistZipMeta({ zipSha256: sha, zipSize: zipSize || 0, zipGeneratedAt: new Date().toISOString() });\n      }\n"
        )
    else:
        # fallback: inject near the success toast
        block2 = re.sub(
            r'pushToast\([\'"]ZIP verified[^;]*;\s*',
            lambda m: m.group(0) + "      if (expectedSha && sha && expectedSha === sha) { await persistZipMeta({ zipSha256: sha, zipSize: zipSize || 0, zipGeneratedAt: new Date().toISOString() }); }\n",
            block,
            count=1
        )
    s = s.replace(block, block2)

p.write_text(s)
print("✅ page patched: hydrate on load + persist on verify success")
PY

echo
echo "==> (4) Restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf "$NEXT_DIR/.next" 2>/dev/null || true
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo
echo "==> (5) Sanity checks"
echo "GET zip verification (expect ok:true, zipMeta:null BEFORE verify):"
curl -sS "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80 || true

echo
echo "✅ Open bundle page:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
