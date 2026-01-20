#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

cat > "$FILE" <<'TS'
import { NextResponse } from "next/server";
import JSZip from "jszip";

export const runtime = "nodejs";

async function safeFetchJson(url: string) {
  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  if (!text || !text.trim()) {
    throw new Error(`Empty response from ${url} (HTTP ${r.status})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const sample = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Non-JSON from ${url} (HTTP ${r.status}): ${sample}`);
  }
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    // Pull what we can from existing Next proxy routes (read-only)
    const base = u.origin;

    const workflowUrl = `${base}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
    const timelineUrl = `${base}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
    const packetMetaUrl = `${base}/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;

    const [workflow, timeline, packetMeta] = await Promise.all([
      safeFetchJson(workflowUrl),
      safeFetchJson(timelineUrl),
      safeFetchJson(packetMetaUrl),
    ]);

    // Build a minimal-but-real ZIP. (Later we’ll expand to full manifest/hashes/payloads)
    const zip = new JSZip();
    zip.file("README.txt", `PeakOps Incident Bundle\norgId=${orgId}\nincidentId=${incidentId}\n`);
    zip.file("packet_meta.json", JSON.stringify(packetMeta, null, 2));
    zip.file("workflow.json", JSON.stringify(workflow, null, 2));
    zip.file("timeline/events.json", JSON.stringify(timeline, null, 2));

    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const filename = `incident_${incidentId}_packet.zip`;

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
TS

echo "✅ wrote: $FILE"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: download route (should be 200 + application/zip)"
URL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST"
curl -fsSI "$URL" | head -n 20
echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
