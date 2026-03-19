import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const qs = url.searchParams.toString();
    const base =
      process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE ||
      "http://127.0.0.1:5001/peakops-pilot/us-central1";

    const r = await fetch(`${base}/getContractsV1?${qs}`, { method: "GET" });

    const text = await r.text();
    let j: any = {};
    try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 500) }; }

    return NextResponse.json(j, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
