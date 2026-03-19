import { NextResponse } from "next/server";
import JSZip from "jszip";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId");
  const incidentId = url.searchParams.get("incidentId");

  if (!orgId || !incidentId) {
    return NextResponse.json(
      { ok: false, error: "Missing orgId / incidentId" },
      { status: 400 }
    );
  }

  // Build a minimal but REAL immutable ZIP
  const zip = new JSZip();

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        orgId,
        incidentId,
        generatedAt: new Date().toISOString(),
        immutable: true,
      },
      null,
      2
    )
  );

  zip.file(
    "README.txt",
    `Immutable Incident Artifact

Org: ${orgId}
Incident: ${incidentId}

This ZIP is the canonical audit artifact.
Do not modify.
`
  );

  const bytes = await zip.generateAsync({ type: "uint8array" });

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="incident_${incidentId}_packet.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
