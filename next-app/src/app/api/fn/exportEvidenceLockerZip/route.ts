import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const incidentId = url.searchParams.get("incidentId") || "";
  const limit = url.searchParams.get("limit") || "200";

  const base = process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE || "";
  if (!base) {
    return NextResponse.json({ ok:false, error:"NEXT_PUBLIC_PEAKOPS_FN_BASE not set" }, { status: 500 });
  }
  if (!orgId || !incidentId) {
    return NextResponse.json({ ok:false, error:"Missing orgId/incidentId" }, { status: 400 });
  }

  const upstream = `${base}/exportEvidenceLockerZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=${encodeURIComponent(limit)}`;
  const r = await fetch(upstream);
  const j = await r.json().catch(() => ({}));
  return NextResponse.json(j, { status: r.ok ? 200 : r.status });
}
