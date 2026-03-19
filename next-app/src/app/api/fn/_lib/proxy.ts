import { NextResponse } from "next/server";

export function fnBase(): string {
  // Prefer env, otherwise default to emulator
  const b =
    process.env.FN_BASE ||
    process.env.NEXT_PUBLIC_FN_BASE ||
    "http://127.0.0.1:5001/peakops-pilot/us-central1";
  return b.replace(/\/+$/, "");
}

export async function proxyGET(req: Request, fnName: string) {
  try {
    const base = fnBase();
    const url = new URL(req.url);

    // forward querystring
    const target = `${base}/${fnName}?${url.searchParams.toString()}`;

    const r = await fetch(target, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    const text = await r.text();

    // return raw JSON if possible; otherwise wrap
    try {
      const j = JSON.parse(text);
      return NextResponse.json(j, { status: r.status });
    } catch {
      return NextResponse.json(
        { ok: false, error: "NON_JSON_FROM_FN", status: r.status, preview: text.slice(0, 500) },
        { status: 500 }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

export async function proxyPOST(req: Request, fnName: string) {
  try {
    const base = fnBase();
    const url = new URL(req.url);

    const body = await req.text();
    const target = `${base}/${fnName}?${url.searchParams.toString()}`;

    const r = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });

    const text = await r.text();
    try {
      const j = JSON.parse(text);
      return NextResponse.json(j, { status: r.status });
    } catch {
      return NextResponse.json(
        { ok: false, error: "NON_JSON_FROM_FN", status: r.status, preview: text.slice(0, 500) },
        { status: 500 }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
