#!/usr/bin/env bash
set -euo pipefail
setopt NO_NOMATCH 2>/dev/null || true
set +H 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }

echo "==> backup bundle page"
cp "$PAGE" "$PAGE.bak_zip_verified_lock_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved"

echo "==> write API routes: getZipVerificationV1 + persistZipVerificationV1 (Firestore emulator REST)"
mkdir -p next-app/src/app/api/fn/getZipVerificationV1
mkdir -p next-app/src/app/api/fn/persistZipVerificationV1

cat > next-app/src/app/api/fn/getZipVerificationV1/route.ts <<'TS'
import { NextRequest } from "next/server";

function json(status: number, obj: any) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getEmuHost(): string | null {
  // FIRESTORE_EMULATOR_HOST is usually "127.0.0.1:8080"
  const h = process.env.FIRESTORE_EMULATOR_HOST;
  if (h && h.includes(":")) return h;
  return null;
}

function docUrl(projectId: string, incidentId: string, fieldMask?: string[]) {
  const host = getEmuHost();
  if (!host) return null;
  const base = `http://${host}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;
  if (fieldMask && fieldMask.length) {
    const qp = fieldMask.map((f) => `mask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    return `${base}?${qp}`;
  }
  return base;
}

function readString(fields: any, path: string): string | null {
  const parts = path.split(".");
  let cur = fields;
  for (const p of parts) {
    const v = cur?.[p];
    if (!v) return null;
    if (v.mapValue?.fields) cur = v.mapValue.fields;
    else cur = v;
  }
  return cur?.stringValue ?? null;
}

function readInt(fields: any, path: string): number | null {
  const parts = path.split(".");
  let cur = fields;
  for (const p of parts) {
    const v = cur?.[p];
    if (!v) return null;
    if (v.mapValue?.fields) cur = v.mapValue.fields;
    else cur = v;
  }
  const iv = cur?.integerValue;
  if (iv == null) return null;
  const n = Number(iv);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId") || "";
  const incidentId = sp.get("incidentId") || "";
  const projectId = sp.get("projectId") || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "peakops-pilot";

  if (!orgId || !incidentId) return json(400, { ok: false, error: "Missing orgId/incidentId" });

  const url = docUrl(projectId, incidentId, [
    "orgId",
    "packetMeta.zipMeta",
  ]);
  if (!url) return json(501, { ok: false, error: "Firestore emulator not configured (FIRESTORE_EMULATOR_HOST missing)" });

  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  if (!r.ok) {
    return json(200, { ok: true, orgId, incidentId, zipMeta: null, note: "incident missing or no zipMeta" });
  }

  let doc: any = null;
  try { doc = JSON.parse(text); } catch { doc = null; }
  const fields = doc?.fields || {};
  const docOrg = fields?.orgId?.stringValue || "";

  const zipMetaFields = fields?.packetMeta?.mapValue?.fields?.zipMeta?.mapValue?.fields || null;

  const zipMeta = zipMetaFields ? {
    zipSha256: zipMetaFields.zipSha256?.stringValue || "",
    zipSize: zipMetaFields.zipSize?.integerValue ? Number(zipMetaFields.zipSize.integerValue) : 0,
    zipGeneratedAt: zipMetaFields.zipGeneratedAt?.stringValue || "",
    verifiedAt: zipMetaFields.verifiedAt?.stringValue || "",
    verifiedBy: zipMetaFields.verifiedBy?.stringValue || "",
  } : null;

  return json(200, {
    ok: true,
    orgId,
    incidentId,
    projectId,
    docOrg,
    zipMeta,
  });
}
TS

cat > next-app/src/app/api/fn/persistZipVerificationV1/route.ts <<'TS'
import { NextRequest } from "next/server";

function json(status: number, obj: any) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getEmuHost(): string | null {
  const h = process.env.FIRESTORE_EMULATOR_HOST;
  if (h && h.includes(":")) return h;
  return null;
}

function docPatchUrl(projectId: string, incidentId: string) {
  const host = getEmuHost();
  if (!host) return null;

  const base = `http://${host}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;
  const masks = [
    "orgId",
    "packetMeta.zipMeta.zipSha256",
    "packetMeta.zipMeta.zipSize",
    "packetMeta.zipMeta.zipGeneratedAt",
    "packetMeta.zipMeta.verifiedAt",
    "packetMeta.zipMeta.verifiedBy",
  ].map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");

  return `${base}?${masks}`;
}

export async function POST(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId") || "";
  const incidentId = sp.get("incidentId") || "";
  const projectId = sp.get("projectId") || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "peakops-pilot";

  if (!orgId || !incidentId) return json(400, { ok: false, error: "Missing orgId/incidentId" });

  const url = docPatchUrl(projectId, incidentId);
  if (!url) return json(501, { ok: false, error: "Firestore emulator not configured (FIRESTORE_EMULATOR_HOST missing)" });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }

  const zipSha256 = String(body?.zipSha256 || "");
  const zipSize = Number(body?.zipSize || 0) || 0;
  const zipGeneratedAt = String(body?.zipGeneratedAt || "");
  const verifiedAt = String(body?.verifiedAt || new Date().toISOString());
  const verifiedBy = String(body?.verifiedBy || "ui");

  if (!zipSha256 || !zipSize || !zipGeneratedAt) {
    return json(400, { ok: false, error: "Missing zipSha256/zipSize/zipGeneratedAt" });
  }

  // Firestore REST document fields encoding
  const payload = {
    fields: {
      orgId: { stringValue: orgId },
      packetMeta: {
        mapValue: {
          fields: {
            zipMeta: {
              mapValue: {
                fields: {
                  zipSha256: { stringValue: zipSha256 },
                  zipSize: { integerValue: String(zipSize) },
                  zipGeneratedAt: { stringValue: zipGeneratedAt },
                  verifiedAt: { stringValue: verifiedAt },
                  verifiedBy: { stringValue: verifiedBy },
                }
              }
            }
          }
        }
      }
    }
  };

  const r = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) {
    return json(500, { ok: false, error: `Firestore PATCH failed (HTTP ${r.status})`, raw: text.slice(0, 300) });
  }

  return json(200, {
    ok: true,
    orgId,
    incidentId,
    projectId,
    zipMeta: { zipSha256, zipSize, zipGeneratedAt, verifiedAt, verifiedBy },
  });
}
TS

echo "==> patch bundle page to: (A) hydrate zipMeta from Firestore, (B) persist after verify success"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Ensure we have a state for zipVerified sticky (reuse existing zipMeta if present).
# We'll inject a helper: hydrateZipVerification() and call it in useEffect after loadPacketMeta.
if "getZipVerificationV1" not in s:
    # Find loadPacketMeta() function end or near existing loadPacketMeta.
    m = re.search(r'async function loadPacketMeta\(\)\s*\{', s)
    if not m:
        raise SystemExit("❌ Could not find loadPacketMeta() to anchor patch.")

    # Insert helper after loadPacketMeta definition block (first closing brace after it)
    # This is intentionally conservative: insert after first occurrence of "async function loadPacketMeta() { ... }"
    # We'll locate the end by counting braces from the function start.
    start = m.start()
    i = m.end()
    depth = 1
    while i < len(s) and depth > 0:
        ch = s[i]
        if ch == "{": depth += 1
        elif ch == "}": depth -= 1
        i += 1
    func_end = i  # position after closing brace

    helper = r'''
async function hydrateZipVerification() {
  try {
    const u =
      `/api/fn/getZipVerificationV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;
    const r = await fetch(u, { method: "GET" });
    const j = await r.json().catch(() => null);
    const zm = j?.zipMeta || null;
    if (zm?.zipSha256) {
      // Merge into existing packetMeta shape without blowing away canonical fields
      setPacketMeta((prev: any) => {
        const base = prev || {};
        return {
          ...base,
          zipSha256: base.zipSha256 || zm.zipSha256,
          zipSize: base.zipSize || zm.zipSize,
          zipGeneratedAt: base.zipGeneratedAt || zm.zipGeneratedAt,
          zipVerifiedAt: zm.verifiedAt || base.zipVerifiedAt,
          zipVerifiedBy: zm.verifiedBy || base.zipVerifiedBy,
        };
      });
    }
  } catch {
    // swallow
  }
}
'''
    s = s[:func_end] + "\n" + helper + "\n" + s[func_end:]

# 2) Make useEffect call hydrateZipVerification() after loadPacketMeta()
# Find the existing useEffect that calls loadPacketMeta
s = re.sub(
    r'void\s+loadPacketMeta\(\);\s*\n',
    'void loadPacketMeta();\n    void hydrateZipVerification();\n',
    s,
    count=1
)

# 3) After a successful verify in handleVerifyZip, call persistZipVerificationV1
# We'll inject right after success toast line "ZIP verified ✅" or similar.
if "persistZipVerificationV1" not in s:
    # Find handleVerifyZip function
    m = re.search(r'async function handleVerifyZip\(\)\s*\{', s)
    if not m:
        raise SystemExit("❌ Could not find handleVerifyZip()")

    # Inject a persist call near the success path: look for "ZIP verified" toast
    # If not found, inject before finally { setBusyAction("") }
    inject_point = None
    toast = re.search(r'pushToast\([^\n]*ZIP verified[^;]*;', s)
    if toast:
        inject_point = toast.end()
    else:
        fin = re.search(r'\}\s*finally\s*\{', s[m.start():])
        if fin:
            inject_point = m.start() + fin.start()
        else:
            raise SystemExit("❌ Could not find a safe injection point in handleVerifyZip()")

    persist = r'''
      // Persist "ZIP Verified" into Firestore so it survives refresh/restart
      try {
        const u =
          `/api/fn/persistZipVerificationV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
        await fetch(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            zipSha256: String(zipSha256),
            zipSize: Number(zipSize || 0),
            zipGeneratedAt: String(zipGeneratedAt || new Date().toISOString()),
            verifiedAt: new Date().toISOString(),
            verifiedBy: "ui",
          }),
        });
      } catch {
        // ignore persistence failure in UI flow
      }
'''
    s = s[:inject_point] + "\n" + persist + "\n" + s[inject_point:]

p.write_text(s)
print("✅ bundle page patched: hydrate + persist ZIP verification")
PY

echo "==> restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: persisted zipMeta endpoint"
curl -sS "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | head -c 300; echo

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" || true

echo
echo "NEXT:"
echo "  1) Click Verify ZIP once (should go green)"
echo "  2) Hard refresh page -> should remain ZIP Verified (sticky)"
