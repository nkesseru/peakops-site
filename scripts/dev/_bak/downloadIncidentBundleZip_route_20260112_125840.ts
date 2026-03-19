import { NextResponse } from "next/server";
import JSZip from "jszip";

export const runtime = "nodejs";

async function readBytes(resp: Response): Promise<Uint8Array> {
  const ab = await resp.arrayBuffer();
  return new Uint8Array(ab);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    // Fetch the existing PACKET zip (canonical artifact)
    const packetUrl =
      `${url.origin}/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;

    const packetResp = await fetch(packetUrl, { method: "GET" });
    if (!packetResp.ok) {
      const sample = (await packetResp.text().catch(() => "")).slice(0, 200);
      return NextResponse.json(
        { ok: false, error: `downloadIncidentPacketZip failed (HTTP ${packetResp.status})`, sample },
        { status: 502 }
      );
    }

    const packetZipBytes = await readBytes(packetResp);

    // Build a "bundle.zip" that includes packet.zip + tiny manifest
    const bundle = new JSZip();

    // Put the packet as a child file
    bundle.file("packet.zip", packetZipBytes);

    const generatedAt = new Date().toISOString();

    const bundleManifest = {
      bundleVersion: "v1",
      orgId,
      incidentId,
      generatedAt,
      files: ["packet.zip"],
      notes: "Bundle contains the canonical immutable packet plus optional convenience files.",
    };

    bundle.file("bundle_manifest.json", JSON.stringify(bundleManifest, null, 2));
    bundle.file(
      "README.txt",
      [
        "PeakOps Incident Bundle (v1)",
        "",
        "This ZIP is a wrapper around the canonical immutable incident packet.",
        "",
        "- packet.zip: the immutable artifact (hashes, manifest, payloads)",
        "- bundle_manifest.json: metadata about this bundle wrapper",
        "",
        `generatedAt: ${generatedAt}`,
      ].join("\n")
    );

    const bundleZipBytes = await bundle.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const filename = `incident_${incidentId}_bundle.zip`;

    return new NextResponse(bundleZipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-Bundle-GeneratedAt": generatedAt,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
