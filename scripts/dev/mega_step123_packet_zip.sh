#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
CONTRACT_ID="${3:-car_abc123}"

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
BAK="scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

mkdir -p scripts/dev/_bak .logs

echo "==> backup"
cp "$FILE" "$BAK"
echo "✅ backup: $BAK"

echo "==> write clean route.ts (manifest + hashes + packet_meta + contract snapshot + filings stub)"
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
    if (!text || !text.trim()) {
      return { ok: false, error: `empty body`, status: r.status, sample };
    }
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
    bytes: utf8(
      JSON.stringify(
        {
          ok: true,
          stub: true,
          title,
          ...extra,
        },
        null,
        2
      )
    ),
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
          "- hashes.json      : path->sha256 map",
          "- workflow.json    : guided workflow state snapshot (v1 stub)",
          "- timeline/events.json : timeline events snapshot",
          "- contract/contract.json : contract snapshot (or stub if missing)",
          "- filings/* : filings payload stubs (until fully wired)",
        ].join("\n")
      ),
    });

    // workflow.json (from existing Next proxy)
    const wfR = await safeJsonFetch(`${origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    if (wfR.ok) {
      files.push({ path: "workflow.json", bytes: utf8(JSON.stringify(wfR.v, null, 2)) });
    } else {
      files.push(
        stubFile("workflow.json", "Workflow snapshot unavailable", {
          ok: false,
          error: wfR.error,
          status: wfR.status,
          sample: wfR.sample,
        })
      );
    }

    // timeline/events.json (real if endpoint exists, else stub)
    const tlR = await safeJsonFetch(
      `${origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`
    );
    if (tlR.ok) {
      files.push({ path: "timeline/events.json", bytes: utf8(JSON.stringify(tlR.v, null, 2)) });
    } else {
      files.push(
        stubFile("timeline/events.json", "Timeline snapshot unavailable", {
          ok: false,
          error: tlR.error,
          status: tlR.status,
          sample: tlR.sample,
        })
      );
    }

    // contract snapshot
    if (contractId) {
      const cR = await safeJsonFetch(
        `${origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`
      );
      if (cR.ok) {
        files.push({ path: "contract/contract.json", bytes: utf8(JSON.stringify(cR.v, null, 2)) });
      } else {
        files.push(
          stubFile("contract/contract.json", "Contract not found or not accessible", {
            ok: false,
            error: cR.error,
            status: cR.status,
            sample: cR.sample,
            contractId,
          })
        );
      }
    } else {
      files.push(
        stubFile("contract/contract.json", "No contractId provided — stub", {
          contractId: null,
        })
      );
    }

    // filings folder stub
    const filingsIndex = {
      ok: true,
      stub: true,
      generatedAt: nowIso,
      message: "Filings folder stub. Replace with real DIRS/OE-417/NORS/SAR/BABA payloads once incident-based generation is wired.",
      files: ["dirs.json", "oe417.json", "nors.json", "sar.json", "baba.json"],
    };
    files.push({ path: "filings/index.json", bytes: utf8(JSON.stringify(filingsIndex, null, 2)) });
    files.push(stubFile("filings/dirs.json", "DIRS payload (stub)", { schema: "dirs.v1" }));
    files.push(stubFile("filings/oe417.json", "OE-417 payload (stub)", { schema: "oe_417.v1" }));
    files.push(stubFile("filings/nors.json", "NORS payload (stub)", { schema: "nors.v1" }));
    files.push(stubFile("filings/sar.json", "SAR payload (stub)", { schema: "sar.v1" }));
    files.push(stubFile("filings/baba.json", "BABA payload (stub)", { schema: "baba.v1" }));

    // hashes + manifest (computed BEFORE packet_meta so packetHash can be stable)
    const hashes: Record<string, string> = {};
    const manifest: { path: string; sha256: string; sizeBytes: number }[] = [];

    for (const f of files) {
      const h = sha256(f.bytes);
      hashes[f.path] = h;
      manifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
    }

    // packetHash: derived from hashes.json content (stable)
    const packetHash = sha256(utf8(JSON.stringify(hashes, null, 2)));

    const packetMeta = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      packetHash,
      fileCount: files.length + 3, // + packet_meta + manifest + hashes
      note: "packet_meta.json is included inside the ZIP; X-PeakOps headers include zip sha/size for transport.",
    };

    files.push({ path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMeta, null, 2)) });
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

echo "✅ wrote $FILE"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > "../.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke download + verify zip contains core files"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&contractId=${CONTRACT_ID}"

curl -fsSI "$DURL" | head -n 25

TMP="/tmp/packet_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"

unzip -l "$TMP/packet.zip" | egrep -q "packet_meta\.json" || { echo "❌ missing packet_meta.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "manifest\.json" || { echo "❌ missing manifest.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "hashes\.json" || { echo "❌ missing hashes.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "contract/contract\.json" || { echo "❌ missing contract/contract.json"; exit 1; }
unzip -l "$TMP/packet.zip" | egrep -q "filings/index\.json" || { echo "❌ missing filings/index.json"; exit 1; }

echo "✅ zip contains packet_meta + manifest + hashes + contract snapshot + filings stub"

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "DONE ✅"
