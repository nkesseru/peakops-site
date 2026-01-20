import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const dynamic = "force-dynamic";

function sha256Hex(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return crypto.createHash("sha256").update(b).digest("hex");
}

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "missing orgId or incidentId" }, { status: 400 });
    }

    const origin = new URL(req.url).origin;

    // Fetch packet.zip from our own route (same deterministic build)
    const packetUrl = `${origin}/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
    const pr = await fetch(packetUrl, { method: "GET", cache: "no-store" });
    if (!pr.ok) {
      const t = await pr.text();
      throw new Error(`packet.zip failed: HTTP ${pr.status} ${t.slice(0, 160)}`);
    }
    const packetBuf = Buffer.from(await pr.arrayBuffer());

    const generatedAtIso = pr.headers.get("x-peakops-generatedat") || "2000-01-01T00:00:00.000Z";
    const fixedZipDate = new Date(generatedAtIso);
    const packetHash = pr.headers.get("x-peakops-packethash") || "";
    const packetZipSha = pr.headers.get("x-peakops-zip-sha256") || sha256Hex(packetBuf);

    const bundleManifest = {
      orgId,
      incidentId,
      generatedAt: generatedAtIso,
      packetHash,
      files: [
        { path: "packet.zip", bytes: packetBuf.length, sha256: packetZipSha },
        { path: "bundle_manifest.json", bytes: 0, sha256: "" },
      ],
    };

    const manifestText = JSON.stringify(bundleManifest, null, 2);
    bundleManifest.files[1].bytes = Buffer.byteLength(manifestText, "utf8");
    bundleManifest.files[1].sha256 = sha256Hex(manifestText);

    const zip = new JSZip();
    zip.file("packet.zip", packetBuf, { binary: true, date: fixedZipDate });
    zip.file("bundle_manifest.json", JSON.stringify(bundleManifest, null, 2), { date: fixedZipDate });

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zipSha256 = sha256Hex(buf);

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="incident_${incidentId}_bundle.zip"`,
        "x-peakops-generatedat": generatedAtIso,
        "x-peakops-packethash": packetHash,
        "x-peakops-zip-sha256": zipSha256,
        "x-peakops-zip-size": String(buf.length),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
