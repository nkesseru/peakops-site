#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
echo "▶ running from repo root: $ROOT"
set +H 2>/dev/null || true

mkdir -p .logs

ROUTE_DIR="next-app/src/app/api/fn/createIncidentV1"
PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"

mkdir -p "$ROUTE_DIR"
test -f "$PAGE" || { echo "❌ missing $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_create_incident_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_create_incident_*"

cat > "$ROUTE_DIR/route.ts" <<'TS'
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function firestoreBase() {
  const rest = process.env.FIRESTORE_EMULATOR_REST;
  if (rest) return rest.replace(/\/+$/, "");
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

function newId() {
  // inc_YYYYMMDD_HHMMSS_rand
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  const rand = Math.random().toString(16).slice(2, 8);
  return `inc_${stamp}_${rand}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const orgId = String(body?.orgId || "");
    const title = String(body?.title || "New Incident");
    const startTime = String(body?.startTime || new Date().toISOString());

    if (!orgId) return json(false, { error: "orgId required" }, 400);

    const incidentId = newId();
    const docUrl =
      `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

    const patchUrl =
      docUrl +
      `?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime`;

    const payload = {
      fields: {
        orgId: { stringValue: orgId },
        title: { stringValue: title },
        startTime: { stringValue: startTime },
      },
    };

    const r = await fetch(patchUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const t = await r.text();
    let j: any = null;
    try { j = JSON.parse(t); } catch {}

    if (!r.ok) return json(false, { error: j?.error?.message || t || `HTTP ${r.status}` }, 500);

    return json(true, { orgId, incidentId, title, startTime }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
TS

echo "✅ wrote route: $ROUTE_DIR/route.ts"

# Patch incident page to add button + handler (idempotent)
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

if "handleCreateIncidentV1" not in s:
  # Insert handler near other helpers (after btn() if present)
  handler = r'''
  async function handleCreateIncidentV1() {
    try {
      const r = await fetch("/api/fn/createIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, title: "New Incident" }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `Create failed (HTTP ${r.status})`);
      const newId = j.incidentId;
      window.location.href = `/admin/incidents/${encodeURIComponent(newId)}?orgId=${encodeURIComponent(orgId)}`;
    } catch (e: any) {
      alert(String(e?.message || e));
    }
  }
'''
  # place after btn helper if exists else after first function in file
  m = re.search(r'function\s+btn\s*\([^)]*\)\s*:\s*React\.CSSProperties\s*\{[\s\S]*?\n\}\n', s)
  if m:
    s = s[:m.end()] + "\n" + handler + "\n" + s[m.end():]
  else:
    # fallback: after imports
    mi = re.search(r'^(import[\s\S]+?\n)\n', s, re.M)
    if not mi:
      raise SystemExit("❌ could not find import block to insert handler")
    s = s[:mi.end()] + handler + "\n" + s[mi.end():]

if "Create New Incident" not in s:
  # add button near top action row: find an existing button line and insert after it
  # If your page has a "Refresh" button, add next to it.
  s = s.replace(
    '{busy ? "Loading…" : "Refresh"}',
    '{busy ? "Loading…" : "Refresh"}\n        </button>\n        <button style={pill(false)} onClick={handleCreateIncidentV1}>\n          + Create New Incident',
    1
  )

p.write_text(s)
print("✅ patched incident page: Create New Incident button + handler")
PY

echo "🧹 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open incident page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true
echo "LOGS: tail -n 120 .logs/next.log"
