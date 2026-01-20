#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

NEXT_DIR="next-app"
LOGDIR=".logs"
PAGE="$NEXT_DIR/src/app/admin/incidents/[id]/bundle/page.tsx"

mkdir -p "$LOGDIR"
test -d "$NEXT_DIR" || { echo "❌ missing $NEXT_DIR/"; exit 1; }
test -f "$PAGE" || { echo "❌ missing $PAGE"; exit 1; }

echo "✅ repo root: $ROOT"
echo "✅ page: $PAGE"
echo "✅ logs: $LOGDIR/"

# -------------------------------------------------------------------
# 1) Write API routes (correct paths, no leading /)
# -------------------------------------------------------------------
write_route () {
  local rel="$1"
  local content="$2"
  local full="$NEXT_DIR/src/app/api/fn/$rel/route.ts"
  mkdir -p "$(dirname "$full")"
  cp -f "$full" "$full.bak_$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
  printf "%s\n" "$content" > "$full"
  echo "✅ wrote $full"
}

GET_LOCK_TS='// AUTO-GENERATED (mega_finalize_incident_v1_FIXED)
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
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

function readField(fields: any, key: string): any {
  const v = fields?.[key];
  if (!v) return null;
  return v.booleanValue ?? v.stringValue ?? v.integerValue ?? v.doubleValue ?? null;
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    if (!orgId) return json(false, { error: "orgId required" }, 400);
    if (!incidentId) return json(false, { error: "incidentId required" }, 400);

    const docUrl =
      `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

    const r = await fetch(docUrl, { method: "GET" });
    const t = await r.text();
    let j: any = null;
    try { j = JSON.parse(t); } catch {}

    if (!r.ok) return json(false, { error: j?.error?.message || t || `HTTP ${r.status}` }, 404);

    const fields = j?.fields || {};
    const immutable = !!readField(fields, "immutable");
    const immutableAt = readField(fields, "immutableAt");
    const immutableBy = readField(fields, "immutableBy");
    const immutableReason = readField(fields, "immutableReason");

    return json(true, { orgId, incidentId, projectId: projectId(), immutable, immutableAt, immutableBy, immutableReason }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
'

FINALIZE_TS='// AUTO-GENERATED (mega_finalize_incident_v1_FIXED)
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
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const orgId = String(body?.orgId || "");
    const incidentId = String(body?.incidentId || "");
    const immutableBy = String(body?.immutableBy || "ui");
    const immutableReason = String(body?.immutableReason || "");
    if (!orgId) return json(false, { error: "orgId required" }, 400);
    if (!incidentId) return json(false, { error: "incidentId required" }, 400);

    const nowIso = new Date().toISOString();
    const docUrl =
      `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

    // read first (idempotent)
    const gr = await fetch(docUrl, { method: "GET" });
    const gt = await gr.text();
    let gj: any = null;
    try { gj = JSON.parse(gt); } catch {}
    if (!gr.ok) return json(false, { error: gj?.error?.message || gt || `HTTP ${gr.status}` }, 404);

    const alreadyImmutable = !!gj?.fields?.immutable?.booleanValue;
    if (alreadyImmutable) {
      return json(true, {
        orgId, incidentId, projectId: projectId(),
        immutable: true,
        immutableAt: gj?.fields?.immutableAt?.stringValue || null,
        immutableBy: gj?.fields?.immutableBy?.stringValue || null,
        note: "already immutable",
      }, 200);
    }

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
    try { pj = JSON.parse(pt); } catch {}

    if (!pr.ok) return json(false, { error: pj?.error?.message || pt || `HTTP ${pr.status}` }, 500);

    return json(true, { orgId, incidentId, projectId: projectId(), immutable: true, immutableAt: nowIso, immutableBy }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
'

write_route "getIncidentLockV1" "$GET_LOCK_TS"
write_route "finalizeIncidentV1" "$FINALIZE_TS"

# -------------------------------------------------------------------
# 2) Patch bundle page: add Finalize button/handler + hydrate lock on load
#    (pure python edits; no perl)
# -------------------------------------------------------------------
cp "$PAGE" "$PAGE.bak_finalize_$(date +%Y%m%d_%H%M%S)"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# Ensure state exists (immutable already in your file; leave if present)
# Add finalize handler if missing
if "async function handleFinalizeIncident()" not in s:
    anchor = "async function handleGeneratePacket"
    if anchor not in s:
        raise SystemExit("❌ could not find handleGeneratePacket anchor")

    handler = r'''
  async function handleFinalizeIncident() {
    if (busyAction) return;
    if (immutable) return pushToast("Already immutable.", "warn");
    if (!zipVerified) return pushToast("Verify ZIP first (integrity), then finalize.", "warn");

    try {
      setBusyAction("Finalize");
      pushToast("Finalizing incident…", "ok");

      const r = await fetch("/api/fn/finalizeIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, incidentId, immutableBy: "ui" }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `Finalize failed (HTTP ${r.status})`);

      setImmutable(true);
      pushToast("Incident finalized (immutable) ✅", "ok");
    } catch (e: any) {
      pushToast(`Finalize failed: ${String(e?.message || e)}`, "err");
    } finally {
      setBusyAction("");
    }
  }

'''
    s = s.replace(anchor, handler + anchor)

# Add button after Verify ZIP if missing
if "Finalize Incident" not in s:
    s = s.replace(
        '<button onClick={handleVerifyZip} disabled={!!busyAction} style={btn(false)}>\n            Verify ZIP\n          </button>',
        '<button onClick={handleVerifyZip} disabled={!!busyAction} style={btn(false)}>\n            Verify ZIP\n          </button>\n\n          <button onClick={handleFinalizeIncident} disabled={!!busyAction || !zipVerified || immutable} style={btn(false)}>\n            {immutable ? "Finalized" : "Finalize Incident"}\n          </button>'
    )

# Make sure we hydrate immutable state on load by calling getIncidentLockV1 once during loadPacketMeta
# (only inject if not already present)
if "getIncidentLockV1" not in s:
    # insert a small fetch inside the "if (j.ok) {" block right after setImmutable(...)
    pat = r'if\s*\(j\.ok\)\s*\{\s*\n\s*setImmutable\(\!\!j\.immutable\);\s*'
    m = re.search(pat, s)
    if m:
        inject = (
            'if (j.ok) {\n'
            '        setImmutable(!!j.immutable);\n'
            '        // also hydrate immutable lock (source of truth)\n'
            '        try {\n'
            '          const lr = await fetch(`/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);\n'
            '          const lj = await lr.json().catch(() => null);\n'
            '          if (lj?.ok && typeof lj.immutable === "boolean") setImmutable(!!lj.immutable);\n'
            '        } catch { /* ignore */ }\n'
        )
        # replace the first occurrence of "if (j.ok) { setImmutable... " with inject
        s = re.sub(r'if\s*\(j\.ok\)\s*\{\s*\n\s*setImmutable\(\!\!j\.immutable\);\s*', inject, s, count=1)

# Ensure useEffect calls loadPacketMeta (and hydrateZipVerification if present)
# (you already have loadPacketMeta useEffect; we won't mutate it here)

p.write_text(s)
print("✅ patched bundle page: Finalize + immutable lock hydrate")
PY

# -------------------------------------------------------------------
# 3) Restart Next cleanly (log path fixed)
# -------------------------------------------------------------------
echo "🧹 clearing Next cache"
rm -rf "$NEXT_DIR/.next" 2>/dev/null || true

echo "🚀 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo "==> sanity: server up?"
curl -I -sS "http://127.0.0.1:3000/" | head -n 1 || true

echo "==> sanity: lock read"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentLockV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80 || true

echo
echo "✅ Open bundle page:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" 2>/dev/null || true

echo
echo "NEXT:"
echo "  1) Verify ZIP (green)"
echo "  2) Click Finalize Incident"
echo "  3) Hard refresh -> Immutable badge should stay ON"
