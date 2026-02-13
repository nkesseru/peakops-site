import { NextResponse } from "next/server";

// Proxy to Functions (emulator or prod) based on env.
// Uses NEXT_PUBLIC_FUNCTIONS_BASE (you already have this in .env.local).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const base =
      process.env.NEXT_PUBLIC_FUNCTIONS_BASE ||
      process.env.NEXT_PUBLIC_API_BASE ||
      "";

    if (!base) {
      return NextResponse.json({ ok: false, error: "Missing NEXT_PUBLIC_FUNCTIONS_BASE / NEXT_PUBLIC_API_BASE" }, { status: 500 });
    }

    const url = `${base}/startFieldSessionV1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });

    const txt = await res.text().catch(() => "");
    return new NextResponse(txt, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
