import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const base = String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim().replace(/\/+$/, "");
  if (!base) {
    return NextResponse.json(
      { ok: false, error: "NEXT_PUBLIC_FUNCTIONS_BASE missing for exportIncidentArtifactV1 proxy" },
      { status: 500 }
    );
  }
  const targetUrl = `${base}/exportIncidentArtifactV1`;
  try {
    const auth = req.headers.get("authorization");
    const demo = req.headers.get("x-peakops-demo");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = auth;
    if (demo) headers["x-peakops-demo"] = demo;
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
    });
    const txt = await upstream.text().catch(() => "");
    let payload: any = {};
    try { payload = txt ? JSON.parse(txt) : {}; } catch { payload = { ok: false, error: "upstream_non_json", raw: String(txt || "").slice(0, 500) }; }
    return NextResponse.json(payload, { status: upstream.status });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "proxy_post_failed", details: { targetUrl, message: String(e?.message || e) } },
      { status: 502 }
    );
  }
}
