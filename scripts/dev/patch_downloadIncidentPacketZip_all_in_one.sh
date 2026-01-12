#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

if [ ! -f "$FILE" ]; then
  echo "❌ file not found: $FILE"
  exit 1
fi

cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

cat > "$FILE" <<'TS'
import { NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const runtime = "nodejs";

type AnyJson = any;

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function utf8(s: string): Uint8Array {
  return Buffer.from(s, "utf8");
}

async function safeFetchJson(url: string): Promise<{ ok: true; json: AnyJson } | { ok: false; status: number; text: string }> {
  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  if (!text || !text.trim()) return { ok: false, status: r.status, text: "" };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, status: r.status, text };
  }
}

/**
 * Packet contents we want (v1):
 * - README.txt
 * - packet_meta.json
 * - manifest.json (list of file entries)
 * - hashes.json (path->sha256)
 * - workflow.json (from /api/fn/getWorkflowV1)
 * - timeline/events.json (from /api/fn/getTimelineEvents)
 * - contract/contract.json (if contractId provided, from /api/fn/getContractV1)
 * - filings/index.json + stubs: filings/dirs.json, filings/oe417.json, filings/nors.json, filings/sar.json, filings/baba.json
 */
async function buildPacket(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const incidentId = url.searchParams.get("incidentId") || "";
  const contractId = url.searchParams.get("contractId") || "";
  if (!orgId || !incidentId) {
    throw new Error("Missing orgId/incidentId");
  }

  const nowIso = new Date().toISOString();
  const origin = url.origin;

  // Pull sources (best-effort; keep stable even if missing)
  const wfResp = await safeFetchJson(
    `${origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`
  );
  const timelineResp = await safeFetchJson(
    `${origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`
  );

  let contractJson: AnyJson = null;
  if (contractId) {
    const cResp = await safeFetchJson(
      `${origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`
    );
    if (cResp.ok && cResp.json?.ok !== false) {
      contractJson = cResp.json;
    } else {
      contractJson = { ok: false, error: "Contract not found", status: cResp.ok ? 200 : cResp.status };
    }
  }

  // Build file list (excluding meta/hashes/manifest until computed)
  const files: { path: string; bytes: Uint8Array }[] = [];

  files.push({
    path: "README.txt",
    bytes: utf8(
      [
        "PeakOps — Immutable Incident Artifact (v1)",
        "",
        `orgId: ${orgId}`,
        `incidentId: ${incidentId}`,
        `contractId: ${contractId || "(none)"}`,
        `generatedAt: ${nowIso}`,
        "",
        "This zip is the canonical shareable artifact for audits + evidence.",
      ].join("\n")
    ),
  });

  // workflow.json
  const wfJson = wfResp.ok ? wfResp.json : { ok: false, error: `workflow non-JSON/empty (HTTP ${wfResp.status})`, sample: wfResp.text?.slice(0, 200) };
  files.push({ path: "workflow.json", bytes: utf8(JSON.stringify(wfJson, null, 2)) });

  // timeline/events.json
  const tJson = timelineResp.ok ? timelineResp.json : { ok: false, error: `timeline non-JSON/empty (HTTP ${timelineResp.status})`, sample: timelineResp.text?.slice(0, 200) };
  files.push({ path: "timeline/events.json", bytes: utf8(JSON.stringify(tJson, null, 2)) });

  // contract snapshot
  if (contractId) {
    files.push({ path: "contract/contract.json", bytes: utf8(JSON.stringify(contractJson, null, 2)) });
  }

  // filings folder stub
  const filingsIndex = {
    packetVersion: "v1",
    note: "Stub. These will become incident-generated payloads (DIRS/OE-417/NORS/SAR/BABA).",
    files: ["filings/dirs.json", "filings/oe417.json", "filings/nors.json", "filings/sar.json", "filings/baba.json"],
  };
  files.push({ path: "filings/index.json", bytes: utf8(JSON.stringify(filingsIndex, null, 2)) });

  const filingStub = (type: string) => ({
    ok: true,
    stub: true,
    type,
    orgId,
    incidentId,
    generatedAt: nowIso,
    note: "Not wired yet. This is a placeholder artifact file so the packet structure is stable.",
  });

  files.push({ path: "filings/dirs.json", bytes: utf8(JSON.stringify(filingStub("DIRS"), null, 2)) });
  files.push({ path: "filings/oe417.json", bytes: utf8(JSON.stringify(filingStub("OE_417"), null, 2)) });
  files.push({ path: "filings/nors.json", bytes: utf8(JSON.stringify(filingStub("NORS"), null, 2)) });
  files.push({ path: "filings/sar.json", bytes: utf8(JSON.stringify(filingStub("SAR"), null, 2)) });
  files.push({ path: "filings/baba.json", bytes: utf8(JSON.stringify(filingStub("BABA"), null, 2)) });

  // Compute hashes + manifest
  const hashes: Record<string, string> = {};
  const manifest: { path: string; sha256: string; sizeBytes: number }[] = [];

  for (const f of files) {
    const h = sha256(f.bytes);
    hashes[f.path] = h;
    manifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
  }

  // Stable packetHash derived from hashes.json (not zip)
  const packetHash = sha256(utf8(JSON.stringify(hashes, null, 2)));

  const packetMeta = {
    packetVersion: "v1",
    orgId,
    incidentId,
    contractId: contractId || null,
    generatedAt: nowIso,
    packetHash,
    fileCount: files.length + 2, // + manifest + hashes
  };

  // Add meta files LAST so they're included in hashes/manifest below? (No — we want manifest/hashes to include themselves.)
  // Approach: include packet_meta.json, manifest.json, hashes.json, then recompute a final hashes/manifest that includes them.
  // This makes the packet truly self-describing.

  // First add placeholders, then compute final
  files.push({ path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMeta, null, 2)) });
  files.push({ path: "manifest.json", bytes: utf8(JSON.stringify(manifest, null, 2)) });
  files.push({ path: "hashes.json", bytes: utf8(JSON.stringify(hashes, null, 2)) });

  // Final recompute to include the 3 meta files themselves
  const finalHashes: Record<string, string> = {};
  const finalManifest: { path: string; sha256: string; sizeBytes: number }[] = [];

  for (const f of files) {
    const h = sha256(f.bytes);
    finalHashes[f.path] = h;
    finalManifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
  }

  const finalPacketHash = sha256(utf8(JSON.stringify(finalHashes, null, 2)));

  const finalPacketMeta = {
    ...packetMeta,
    packetHash: finalPacketHash,
    fileCount: files.length,
  };

  // Overwrite meta files with final versions
  const replaceFile = (path: string, bytes: Uint8Array) => {
    const idx = files.findIndex((x) => x.path === path);
    if (idx >= 0) files[idx] = { path, bytes };
    else files.push({ path, bytes });
  };

  replaceFile("packet_meta.json", utf8(JSON.stringify(finalPacketMeta, null, 2)));
  replaceFile("manifest.json", utf8(JSON.stringify(finalManifest, null, 2)));
  replaceFile("hashes.json", utf8(JSON.stringify(finalHashes, null, 2)));

  // ZIP
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.bytes);

  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const zipSha = sha256(zipBytes);

  return {
    orgId,
    incidentId,
    contractId: contractId || null,
    generatedAt: nowIso,
    packetHash: finalPacketHash,
    zipSha,
    zipSize: zipBytes.byteLength,
    zipBytes,
  };
}

export async function HEAD(req: Request) {
  try {
    const pkt = await buildPacket(req);
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-PeakOps-GeneratedAt": pkt.generatedAt,
        "X-PeakOps-PacketHash": pkt.packetHash,
        "X-PeakOps-Zip-SHA256": pkt.zipSha,
        "X-PeakOps-Zip-Size": String(pkt.zipSize),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const pkt = await buildPacket(req);
    const filename = `incident_${pkt.incidentId}_packet.zip`;
    return new NextResponse(pkt.zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-GeneratedAt": pkt.generatedAt,
        "X-PeakOps-PacketHash": pkt.packetHash,
        "X-PeakOps-Zip-SHA256": pkt.zipSha,
        "X-PeakOps-Zip-Size": String(pkt.zipSize),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

echo "✅ wrote clean $FILE (manifest + hashes + packet_meta + contract snapshot + filings stubs + generatedAt)"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> SMOKE (HEAD + ZIP listing)"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123"

echo "-- HEAD --"
curl -fsSI "$DURL" | egrep -i "HTTP/|content-type|content-disposition|x-peakops-generatedat|x-peakops-packethash|x-peakops-zip-sha256|x-peakops-zip-size" || true

echo
echo "-- ZIP contents (top) --"
TMP="/tmp/packet_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | head -n 60

echo
echo "-- Required files check --"
unzip -l "$TMP/packet.zip" | egrep -q "packet_meta\.json" || { echo "❌ missing packet_meta.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "manifest\.json" || { echo "❌ missing manifest.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "hashes\.json" || { echo "❌ missing hashes.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "contract/contract\.json" || { echo "❌ missing contract/contract.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "filings/index\.json" || { echo "❌ missing filings/index.json"; exit 1; }
echo "✅ required files present"

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "✅ DONE"
