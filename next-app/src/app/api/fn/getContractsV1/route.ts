import { NextRequest, NextResponse } from "next/server";

const FN_BASE = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const target = `${FN_BASE}/getContractsV1${qs ? "?" + qs : ""}`;

  try {
    const init: RequestInit = { method: "GET" };
    if ("GET" === "POST") {
      const body = await req.text();
      init.headers = { "Content-Type": "application/json" };
      init.body = body;
    }
    const r = await fetch(target, init);
    const txt = await r.text();
    return new NextResponse(txt, {
      status: r.status,
      headers: { "Content-Type": r.headers.get("content-type") || "application/json" },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
