import { NextResponse } from "next/server";
import { proxyGET } from "../../_lib/fnProxy";

export const runtime = "nodejs";

// GET /api/fn/exportIncidentPacketV1?orgId=...&incidentId=...&requestedBy=summary_ui
export async function GET(req: Request) {
  const res = await proxyGET(req, "exportIncidentPacketV1");
  const text = await res.text().catch(() => "");
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return new NextResponse(text || "", {
      status: res.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (body && typeof body === "object") {
    const u = new URL(req.url);
    const orgId = String(u.searchParams.get("orgId") || "").trim();
    const incidentId = String(u.searchParams.get("incidentId") || "").trim();
    if (orgId && incidentId) {
      body.downloadUrl = `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
    }
  }

  return NextResponse.json(body, { status: res.status });
}
