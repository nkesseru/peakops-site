#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

cat > "$FILE" <<'TS'
import { NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const runtime = "nodejs";

type AnyObj = Record<string, any>;

function sha256Hex(buf: Buffer | Uint8Array | string) {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : Buffer.from(buf);
  return crypto.createHash("sha256").update(b).digest("hex");
}

async function safeJson(r: Response) {
  const text = await r.text();
  if (!text || !text.trim()) return { ok: false, error: `empty body (HTTP ${r.status})`, raw: "" };
  try {
    return { ok: true, value: JSON.parse(text), raw: text };
  } catch (e: any) {
    return { ok: false, error: `non-JSON (HTTP ${r.status}): ${String(e?.message || e)}`, raw: text.slice(0, 500) };
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    const origin = url.origin;

    // Helper that calls our Next proxy endpoints (already wired to emulator/prod via FN_BASE)
    const call = async (path: string) => {
      const r = await fetch(`${origin}${path}`, { method: "GET" });
      return { r, ...(await safeJson(r)) };
    };

    // 1) Pull core “packet state” pieces we already have
    const wfRes = await call(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    const tlRes = await call(`/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=500`);

    // 2) Try to pull linked contract (best-effort). If your incident doc eventually contains contractId, we’ll use it.
    // For now, we’ll look for a seeded/incidental contractId in the workflow payload (optional) or fall back to car_abc123 if present in URL.
    const contractId = url.searchParams.get("contractId") || "car_abc123";

    const contractRes = await call(`/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
    const payloadsRes = await call(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=500`);

    // 3) Try filings meta (optional) – if present we’ll include later; no-op for now.
    const filingsRes = await call(`/api/fn/generateFilingsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);

    // 4) Build ZIP
    const zip = new JSZip();

    const readme =
`PeakOps Incident Bundle (DEV)
orgId=${orgId}
incidentId=${incidentId}
contractId=${contractId}

This ZIP is an immutable shareable artifact (v1).
Includes workflow, timeline, contract, payloads, and a manifest w/ sha256.`;

    const files: { path: string; bytes: Uint8Array | string; contentType: "text" | "json" }[] = [];

    files.push({ path: "README.txt", bytes: readme, contentType: "text" });

    // packet_meta: lightweight summary
    const packetMeta: AnyObj = {
      orgId,
      incidentId,
      contractId,
      generatedAt: new Date().toISOString(),
      workflowOk: wfRes.ok === true,
      timelineOk: tlRes.ok === true,
      contractOk: contractRes.ok === true,
      payloadsOk: payloadsRes.ok === true,
      filingsOk: filingsRes.ok === true,
    };
    files.push({ path: "packet_meta.json", bytes: JSON.stringify(packetMeta, null, 2), contentType: "json" });

    // workflow
    const workflow = wfRes.ok ? wfRes.value : { ok: false, error: wfRes.error, sample: wfRes.raw };
    files.push({ path: "workflow.json", bytes: JSON.stringify(workflow, null, 2), contentType: "json" });

    // timeline
    const timeline = tlRes.ok ? tlRes.value : { ok: false, error: tlRes.error, sample: tlRes.raw };
    files.push({ path: "timeline/events.json", bytes: JSON.stringify(timeline, null, 2), contentType: "json" });

    // contract + payloads (best effort; ok if contract is missing in some incidents)
    const contract = contractRes.ok ? contractRes.value : { ok: false, error: contractRes.error, sample: contractRes.raw };
    files.push({ path: "contract/contract.json", bytes: JSON.stringify(contract, null, 2), contentType: "json" });

    const payloads = payloadsRes.ok ? payloadsRes.value : { ok: false, error: payloadsRes.error, sample: payloadsRes.raw };
    files.push({ path: "payloads/_index.json", bytes: JSON.stringify(payloads, null, 2), contentType: "json" });

    // If payloads includes docs array, also write each doc as a file for easy diffing
    const docs = (payloads as any)?.docs;
    if (Array.isArray(docs)) {
      for (const d of docs) {
        const id = String(d?.id || "unknown");
        files.push({ path: `payloads/${id}.json`, bytes: JSON.stringify(d, null, 2), contentType: "json" });
      }
    }

    // filings meta (optional)
    const filings = filingsRes.ok ? filingsRes.value : { ok: false, error: filingsRes.error, sample: filingsRes.raw };
    files.push({ path: "filings/_meta.json", bytes: JSON.stringify(filings, null, 2), contentType: "json" });

    // 5) manifest + hashes (sha256 of each file’s bytes)
    const manifest: AnyObj = { version: "v1", orgId, incidentId, contractId, generatedAt: new Date().toISOString(), files: [] as any[] };
    const hashes: AnyObj = { version: "v1", files: {} as Record<string, string> };

    for (const f of files) {
      const content = f.bytes;
      const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      const h = sha256Hex(buf);
      (manifest.files as any[]).push({ path: f.path, sha256: h, bytes: buf.length });
      hashes.files[f.path] = h;

      zip.file(f.path, buf);
    }

    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("hashes.json", JSON.stringify(hashes, null, 2));

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
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

echo "✅ wrote: $FILE"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: download route (should be 200 + application/zip)"
URL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123"
curl -fsSI "$URL" | head -n 20

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
