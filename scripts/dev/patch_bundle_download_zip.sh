#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

BUNDLE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
DL_ROUTE_DIR="next-app/src/app/api/fn/downloadIncidentPacketZip"
DL_ROUTE="$DL_ROUTE_DIR/route.ts"

cp "$BUNDLE" "scripts/dev/_bak/bundle_page_${TS}.tsx"
echo "✅ backup: $BUNDLE -> scripts/dev/_bak/bundle_page_${TS}.tsx"

mkdir -p "$DL_ROUTE_DIR"

cat > "$DL_ROUTE" <<'TS'
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function b64ToUint8(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const incidentId = url.searchParams.get("incidentId") || "";

  if (!orgId || !incidentId) {
    return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
  }

  // Call our existing Next proxy export endpoint
  const exportUrl =
    `${url.origin}/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
    `&incidentId=${encodeURIComponent(incidentId)}`;

  const r = await fetch(exportUrl, { method: "GET" });
  const text = await r.text();

  // If backend gave non-JSON, return it as error.
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { ok: false, error: `exportIncidentPacketV1 returned non-JSON (HTTP ${r.status})`, sample: text.slice(0, 200) },
      { status: 502 }
    );
  }

  if (j?.ok === false) {
    return NextResponse.json(j, { status: 500 });
  }

  const b64 = String(j?.zipBase64 || "");
  if (!b64) {
    return NextResponse.json(
      { ok: false, error: "exportIncidentPacketV1 missing zipBase64 (wire function to return zipBase64)" },
      { status: 500 }
    );
  }

  const filename = String(j?.filename || `incident_${incidentId}_packet.zip`);
  const bytes = b64ToUint8(b64);

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
TS
echo "✅ wrote: $DL_ROUTE"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# Replace any existing download href that calls exportIncidentPacketV1 directly, to the new download route
s2 = re.sub(
  r'href=\{`/api/fn/exportIncidentPacketV1\?orgId=\$\{encodeURIComponent$begin:math:text$orgId$end:math:text$\}&incidentId=\$\{encodeURIComponent$begin:math:text$incidentId$end:math:text$\}`\}',
  'href={`/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`}',
  s
)

# Also catch single-quoted template literals / minor variants
s2 = re.sub(
  r'href=\{`/api/fn/exportIncidentPacketV1\?orgId=\$\{encodeURIComponent$begin:math:text$orgId$end:math:text$\}.*?incidentId=\$\{encodeURIComponent$begin:math:text$incidentId$end:math:text$\}.*?`\}',
  'href={`/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`}',
  s2
)

if s2 == s:
  print("⚠️ bundle page: did not find an exportIncidentPacketV1 href to replace (maybe already updated).")
else:
  p.write_text(s2)
  print("✅ bundle page: Download Packet button now hits /api/fn/downloadIncidentPacketZip")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

INC_URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
BUNDLE_URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"

echo "==> smoke incident page"
curl -fsS "$INC_URL" >/dev/null && echo "✅ incident page OK" || { echo "❌ incident page failing"; tail -n 140 .logs/next.log; exit 1; }

echo "==> smoke bundle page"
curl -fsS "$BUNDLE_URL" >/dev/null && echo "✅ bundle page OK" || { echo "❌ bundle page failing"; tail -n 140 .logs/next.log; exit 1; }

echo "✅ PATCH 1 DONE"
echo "OPEN:"
echo "  $INC_URL"
echo "  $BUNDLE_URL"
