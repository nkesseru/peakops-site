#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

# --- Resolve ROOT + NEXT_DIR regardless of launch location ---
PWD0="$(pwd)"
if [[ -d "./next-app/src/app" ]]; then
  ROOT="$PWD0"
  NEXT_DIR="$ROOT/next-app"
elif [[ -d "./src/app" && "$(basename "$PWD0")" == "next-app" ]]; then
  ROOT="$(cd .. && pwd)"
  NEXT_DIR="$PWD0"
else
  ROOT="$PWD0"
  while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app/src/app" ]]; do
    ROOT="$(cd "$ROOT/.." && pwd)"
  done
  [[ -d "$ROOT/next-app/src/app" ]] || { echo "❌ Can't find repo root with next-app/src/app"; exit 1; }
  NEXT_DIR="$ROOT/next-app"
fi

LOGDIR="$ROOT/.logs"
BAKDIR="$ROOT/scripts/dev/_bak"
mkdir -p "$LOGDIR" "$BAKDIR"

echo "==> ROOT=$ROOT"
echo "==> NEXT_DIR=$NEXT_DIR"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID"

# --- Paths ---
BUNDLE_ROUTE_DIR="$NEXT_DIR/src/app/api/fn/downloadIncidentBundleZip"
BUNDLE_ROUTE_FILE="$BUNDLE_ROUTE_DIR/route.ts"

PACKET_ROUTE_FILE="$NEXT_DIR/src/app/api/fn/downloadIncidentPacketZip/route.ts"
[[ -f "$PACKET_ROUTE_FILE" ]] || { echo "❌ Missing packet zip route: $PACKET_ROUTE_FILE"; exit 1; }

BUNDLE_PAGE="$NEXT_DIR/src/app/admin/incidents/[id]/bundle/page.tsx"
[[ -f "$BUNDLE_PAGE" ]] || { echo "❌ Missing bundle page: $BUNDLE_PAGE"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"

cp "$PACKET_ROUTE_FILE" "$BAKDIR/downloadIncidentPacketZip_route_${TS}.ts"
cp "$BUNDLE_PAGE" "$BAKDIR/bundle_page_${TS}.tsx"

# --- (1) Write downloadIncidentBundleZip route (proxy to packet zip, stable now) ---
mkdir -p "$BUNDLE_ROUTE_DIR"
cat > "$BUNDLE_ROUTE_FILE" <<'TSX'
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Bundle ZIP = stable alias of the canonical packet ZIP for now.
// Later: can expand to include additional bundle-only material without breaking clients.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const incidentId = url.searchParams.get("incidentId") || "";
  const contractId = url.searchParams.get("contractId") || "";

  if (!orgId || !incidentId) {
    return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
  }

  // Call local Next route that generates the packet ZIP (already wired & tested)
  const target =
    `${url.origin}/api/fn/downloadIncidentPacketZip` +
    `?orgId=${encodeURIComponent(orgId)}` +
    `&incidentId=${encodeURIComponent(incidentId)}` +
    (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "");

  const r = await fetch(target, { method: "GET" });
  const bytes = new Uint8Array(await r.arrayBuffer());

  // Pass-through errors
  if (!r.ok) {
    const txt = Buffer.from(bytes).toString("utf8");
    return NextResponse.json(
      { ok: false, error: `downloadIncidentPacketZip failed (HTTP ${r.status})`, sample: txt.slice(0, 200) },
      { status: 502 }
    );
  }

  const headers = new Headers(r.headers);

  // Rename to "bundle" to make intent explicit
  const filename = `incident_${incidentId}_bundle.zip`;
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  headers.set("Cache-Control", "no-store");

  // Helpful debugging header to prove which route served it
  headers.set("X-PeakOps-Bundle-Alias", "downloadIncidentPacketZip");

  return new NextResponse(bytes, { status: 200, headers });
}

// Optional HEAD to support fast UI checks
export async function HEAD(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const incidentId = url.searchParams.get("incidentId") || "";
  const contractId = url.searchParams.get("contractId") || "";

  if (!orgId || !incidentId) return new NextResponse(null, { status: 400 });

  const target =
    `${url.origin}/api/fn/downloadIncidentPacketZip` +
    `?orgId=${encodeURIComponent(orgId)}` +
    `&incidentId=${encodeURIComponent(incidentId)}` +
    (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "");

  const r = await fetch(target, { method: "HEAD" });
  const headers = new Headers(r.headers);

  headers.set("Content-Disposition", `attachment; filename="incident_${incidentId}_bundle.zip"`);
  headers.set("Cache-Control", "no-store");
  headers.set("X-PeakOps-Bundle-Alias", "downloadIncidentPacketZip");

  return new NextResponse(null, { status: r.status, headers });
}
TSX
echo "✅ wrote $BUNDLE_ROUTE_FILE"

# --- (2) Patch bundle page: add colored "Download Bundle (ZIP)" button near Download Packet (ZIP) ---
python3 - <<'PY'
from pathlib import Path
import re

p = Path(r"""'"$BUNDLE_PAGE"'""")
s = p.read_text()

# If already present, don't double-insert
if "Download Bundle (ZIP)" in s or "downloadIncidentBundleZip" in s:
    print("ℹ️ bundle button already present — skipping UI patch")
    raise SystemExit(0)

insert = r'''
<a
  href={`/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}${contractId ? `&contractId=${encodeURIComponent(contractId)}` : ""}`}
  style={{
    ...btn(true),
    marginLeft: 10,
    border: "1px solid color-mix(in oklab, #7dd3fc 35%, transparent)",
    background: "color-mix(in oklab, #7dd3fc 18%, transparent)",
  }}
>
  Download Bundle (ZIP)
</a>
'''.strip("\n")

# Strategy:
# 1) Try insert right after the existing "Download Packet (ZIP)" anchor close tag.
m = re.search(r'(Download Packet \(ZIP\)[\s\S]{0,200}?</a>)', s)
if m:
    s = s[:m.end(1)] + "\n" + insert + s[m.end(1):]
    p.write_text(s)
    print("✅ inserted Bundle ZIP button after Download Packet (ZIP)")
    raise SystemExit(0)

# 2) Fallback: find Packet Meta section and insert after the button row/container
m2 = re.search(r'(<div[^>]*style=\{\{[^}]*display:\s*"flex"[^}]*\}\}[^>]*>\s*)([\s\S]*?)(</div>)', s)
if m2:
    s = s[:m2.end(0)] + "\n" + insert + "\n" + s[m2.end(0):]
    p.write_text(s)
    print("✅ inserted Bundle ZIP button under first flex row (fallback)")
    raise SystemExit(0)

# 3) Last resort: insert near top of Packet Meta card
m3 = re.search(r'(Packet Meta[\s\S]{0,400})', s)
if m3:
    pos = m3.end(1)
    s = s[:pos] + "\n" + insert + "\n" + s[pos:]
    p.write_text(s)
    print("✅ inserted Bundle ZIP button near Packet Meta (last resort)")
    raise SystemExit(0)

print("⚠️ Could not find insert point. Add manually:")
print(insert)
PY

# --- (3) Restart Next + smoke bundle zip ---
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
sleep 2

BASE="http://127.0.0.1:3000"
URL="$BASE/api/fn/downloadIncidentBundleZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"

echo "==> smoke HEAD bundle zip"
curl -fsSI "$URL" | head -n 25

echo "==> smoke GET + unzip required files"
TMP="/tmp/incident_bundle_zip_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$URL" -o "$TMP/bundle.zip"

unzip -l "$TMP/bundle.zip" | grep -E "manifest\.json|hashes\.json|packet_meta\.json" >/dev/null || {
  echo "❌ expected files not found in bundle.zip"
  unzip -l "$TMP/bundle.zip" | head -n 120
  exit 1
}
echo "✅ bundle.zip contains manifest.json + hashes.json + packet_meta.json"

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo "  $BASE/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 160 $LOGDIR/next.log"
