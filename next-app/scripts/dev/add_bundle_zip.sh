#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"
LOGDIR=".logs"
mkdir -p "$LOGDIR" "scripts/dev/_bak"

PKT_ROUTE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
BUNDLE_ROUTE_DIR="next-app/src/app/api/fn/downloadIncidentBundleZip"
BUNDLE_ROUTE="$BUNDLE_ROUTE_DIR/route.ts"
BUNDLE_PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"

TS="$(date +%Y%m%d_%H%M%S)"

backup() {
  local f="$1"
  if [ -f "$f" ]; then
    cp "$f" "scripts/dev/_bak/$(basename "$f").bak_$TS"
  fi
}

echo "==> backups"
backup "$PKT_ROUTE"
backup "$BUNDLE_PAGE"

echo "==> (1) ensure HEAD works for downloadIncidentPacketZip"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# If HEAD already exists, do nothing.
if re.search(r'export\s+async\s+function\s+HEAD\s*\(', s):
    print("✅ HEAD already exists")
    raise SystemExit(0)

# Insert a HEAD handler near the end (before the final catch block if possible).
# We’ll implement HEAD by calling GET and returning only headers, empty body.
head_impl = r'''

// HEAD: return the same headers as GET, without streaming the body.
export async function HEAD(req: Request) {
  const res: any = await GET(req);
  // NextResponse-like: copy headers if present
  const headers = new Headers((res && res.headers) ? res.headers : undefined);
  return new Response(null, { status: (res && res.status) ? res.status : 200, headers });
}
'''

# Add after GET function (after its closing brace). We’ll append at end safely.
s = s.rstrip() + "\n" + head_impl + "\n"
p.write_text(s)
print("✅ added HEAD() to downloadIncidentPacketZip")
PY

echo "==> (2) create /api/fn/downloadIncidentBundleZip as an alias of downloadIncidentPacketZip"
mkdir -p "$BUNDLE_ROUTE_DIR"
cat > "$BUNDLE_ROUTE" <<'TS'
import { GET as PacketGET, HEAD as PacketHEAD } from "../downloadIncidentPacketZip/route";

export const runtime = "nodejs";

// Bundle ZIP is currently the same as Packet ZIP (stable alias).
export async function GET(req: Request) {
  return PacketGET(req);
}

export async function HEAD(req: Request) {
  // If packet route has HEAD, use it; otherwise fall back to GET.
  if (typeof PacketHEAD === "function") return PacketHEAD(req as any);
  return PacketGET(req);
}
TS
echo "✅ wrote $BUNDLE_ROUTE"

echo "==> (3) add a 'Download Bundle (ZIP)' button on the bundle page (if the page exists)"
if [ -f "$BUNDLE_PAGE" ]; then
  python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# Only add once
if "downloadIncidentBundleZip" in s:
    print("✅ bundle page already references downloadIncidentBundleZip")
    raise SystemExit(0)

# Insert an anchor button next to existing download button if present,
# otherwise insert into the top "Packet Meta" section.
# We look for "Download Packet (ZIP)" label and append Bundle button after it.
insert = r'''
      <a
        href={`/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}${contractId ? `&contractId=${encodeURIComponent(contractId)}` : ""}`}
        style={btn(true)}
      >
        Download Bundle (ZIP)
      </a>
'''

# Try to insert after the existing "Download Packet (ZIP)" button block.
m = re.search(r'(Download Packet \(ZIP\).*?\</a\>)', s, flags=re.S)
if m:
    # insert right after the first matching </a>
    end = m.end(1)
    s = s[:end] + "\n" + insert + s[end:]
    p.write_text(s)
    print("✅ inserted Bundle ZIP button after Packet ZIP button")
else:
    # fallback: insert after first occurrence of "Packet Meta" card heading or first section
    m2 = re.search(r'(<div[^>]*>\s*Packet Meta\s*</div>)', s, flags=re.S)
    if m2:
        s = s[:m2.end(1)] + "\n" + insert + s[m2.end(1):]
        p.write_text(s)
        print("✅ inserted Bundle ZIP button under Packet Meta heading (fallback)")
    else:
        print("⚠️ couldn't find a safe insert point. Please add manually:")
        print(insert)
PY
else
  echo "ℹ️ bundle page not found at $BUNDLE_PAGE (skipping UI button)"
fi

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo "==> smoke (HEAD) bundle zip"
URL="http://127.0.0.1:3000/api/fn/downloadIncidentBundleZip?orgId=org_001&incidentId=inc_TEST"
curl -fsSI "$URL" | head -n 25

echo "==> smoke (GET) bundle zip contains manifest.json"
TMP="/tmp/incident_bundle_zip_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$URL" -o "$TMP/bundle.zip"
unzip -l "$TMP/bundle.zip" | grep -E "manifest\.json|hashes\.json|packet_meta\.json" || {
  echo "❌ expected files not found in bundle.zip"
  unzip -l "$TMP/bundle.zip" | head -n 80
  exit 1
}

echo "✅ bundle zip looks good"
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
