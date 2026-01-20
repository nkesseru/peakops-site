#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
CONTRACT_ID="${3:-car_abc123}"

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup saved"

cat > "$FILE" <<'TSX'
import { NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const runtime = "nodejs";

function sha256(buf: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(Buffer.from(buf)).digest("hex");
}
function utf8(s: string): Uint8Array {
  return Buffer.from(s, "utf8");
}

type FileItem = { path: string; bytes: Uint8Array };

async function safeJsonFetch(url: string): Promise<{ ok: true; v: any } | { ok: false; error: string; status: number; sample: string }> {
  try {
    const r = await fetch(url, { method: "GET" });
    const text = await r.text();
    const sample = (text || "").slice(0, 180).replace(/\s+/g, " ");
    if (!text || !text.trim()) return { ok: false, error: "empty body", status: r.status, sample };
    try {
      const v = JSON.parse(text);
      return { ok: true, v };
    } catch (e: any) {
      return { ok: false, error: `non-JSON: ${String(e?.message || e)}`, status: r.status, sample };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), status: 0, sample: "" };
  }
}

function stubFile(path: string, title: string, extra?: Record<string, any>): FileItem {
  return {
    path,
    bytes: utf8(JSON.stringify({ ok: true, stub: true, title, ...(extra || {}) }, null, 2)),
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    const contractId = url.searchParams.get("contractId") || "";

    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const origin = url.origin;

    const files: FileItem[] = [];

    // README
    files.push({
      path: "README.txt",
      bytes: utf8(
        [
          "PeakOps — Immutable Incident Artifact",
          "",
          `orgId: ${orgId}`,
          `incidentId: ${incidentId}`,
          `generatedAt: ${nowIso}`,
          "",
          "Contents:",
          "- packet_meta.json : packet-level metadata",
          "- manifest.json    : list of files + sha256 + sizeBytes",
          "- hashes.json      : path->sha256 map (does NOT include hashes.json itself)",
          "- workflow.json    : guided workflow snapshot",
          "- timeline/events.json : timeline events snapshot",
          "- contract/contract.json : contract snapshot (or stub if missing)",
          "- filings/* : filings payload stubs (until wired)",
        ].join("\n")
      ),
    });

    // workflow.json
    const wfR = await safeJsonFetch(`${origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    if (wfR.ok) files.push({ path: "workflow.json", bytes: utf8(JSON.stringify(wfR.v, null, 2)) });
    else files.push(stubFile("workflow.json", "Workflow snapshot unavailable", { ok: false, error: wfR.error, status: wfR.status, sample: wfR.sample }));

    // timeline/events.json
    const tlR = await safeJsonFetch(`${origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`);
    if (tlR.ok) files.push({ path: "timeline/events.json", bytes: utf8(JSON.stringify(tlR.v, null, 2)) });
    else files.push(stubFile("timeline/events.json", "Timeline snapshot unavailable", { ok: false, error: tlR.error, status: tlR.status, sample: tlR.sample }));

    // contract snapshot
    if (contractId) {
      const cR = await safeJsonFetch(`${origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
      if (cR.ok) files.push({ path: "contract/contract.json", bytes: utf8(JSON.stringify(cR.v, null, 2)) });
      else files.push(stubFile("contract/contract.json", "Contract not found or not accessible", { ok: false, error: cR.error, status: cR.status, sample: cR.sample, contractId }));
    } else {
      files.push(stubFile("contract/contract.json", "No contractId provided — stub", { contractId: null }));
    }

    // filings stub
    const filingsIndex = {
      ok: true,
      stub: true,
      generatedAt: nowIso,
      message: "Filings folder stub. Replace with real payloads once incident-based generation is wired.",
      files: ["dirs.json", "oe417.json", "nors.json", "sar.json", "baba.json"],
    };
    files.push({ path: "filings/index.json", bytes: utf8(JSON.stringify(filingsIndex, null, 2)) });
    files.push(stubFile("filings/dirs.json", "DIRS payload (stub)", { schema: "dirs.v1" }));
    files.push(stubFile("filings/oe417.json", "OE-417 payload (stub)", { schema: "oe_417.v1" }));
    files.push(stubFile("filings/nors.json", "NORS payload (stub)", { schema: "nors.v1" }));
    files.push(stubFile("filings/sar.json", "SAR payload (stub)", { schema: "sar.v1" }));
    files.push(stubFile("filings/baba.json", "BABA payload (stub)", { schema: "baba.v1" }));

    // --- IMPORTANT: packet_meta.json is part of base files ---
    // packetHash is derived from hashes.json (which will include packet_meta.json + base files)
    // but hashes.json itself is not included in the hashes map (to avoid recursion).
    // manifest.json similarly does not include itself.
    const packetMetaBase = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      packetHash: "", // fill after hashes computed
      fileCount: 0,   // fill after we add manifest/hashes
    };

    // We'll add a temp meta now; then re-write it after packetHash is known.
    files.push({ path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMetaBase, null, 2)) });

    // hashes + manifest over BASE FILES (including packet_meta.json)
    const hashes: Record<string, string> = {};
    const manifest: { path: string; sha256: string; sizeBytes: number }[] = [];

    for (const f of files) {
      const h = sha256(f.bytes);
      hashes[f.path] = h;
      manifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
    }

    const packetHash = sha256(utf8(JSON.stringify(hashes, null, 2)));

    // rewrite packet_meta.json with the real packetHash and fileCount
    const packetMeta = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      packetHash,
      fileCount: files.length + 2, // +manifest +hashes
      note: "hashes.json does not include itself; manifest.json does not include itself.",
    };

    // replace existing packet_meta.json entry in files
    for (let i = 0; i < files.length; i++) {
      if (files[i].path === "packet_meta.json") {
        files[i] = { path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMeta, null, 2)) };
        break;
      }
    }

    // now add manifest + hashes files
    files.push({ path: "manifest.json", bytes: utf8(JSON.stringify(manifest, null, 2)) });
    files.push({ path: "hashes.json", bytes: utf8(JSON.stringify(hashes, null, 2)) });

    // ZIP
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, f.bytes);

    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const zipSha = sha256(zipBytes);

    const filename = `incident_${incidentId}_packet.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-Zip-SHA256": zipSha,
        "X-PeakOps-Zip-Size": String(zipBytes.byteLength),
        "X-PeakOps-PacketHash": packetHash,
        "X-PeakOps-GeneratedAt": nowIso,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TSX

echo "✅ patched route.ts"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke zip contents"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&contractId=${CONTRACT_ID}"
TMP="/tmp/packet_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"

echo "--- ZIP list (top) ---"
unzip -l "$TMP/packet.zip" | head -n 50

echo "--- verify required files ---"
unzip -l "$TMP/packet.zip" | grep -q "packet_meta.json" || { echo "❌ missing packet_meta.json"; exit 1; }
unzip -l "$TMP/packet.zip" | grep -q "manifest.json" || { echo "❌ missing manifest.json"; exit 1; }
unzip -l "$TMP/packet.zip" | grep -q "hashes.json" || { echo "❌ missing hashes.json"; exit 1; }
unzip -l "$TMP/packet.zip" | grep -q "contract/contract.json" || { echo "❌ missing contract/contract.json"; exit 1; }
unzip -l "$TMP/packet.zip" | grep -q "filings/index.json" || { echo "❌ missing filings/index.json"; exit 1; }

echo "✅ packet_meta + manifest + hashes + contract snapshot + filings stub present"
echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
