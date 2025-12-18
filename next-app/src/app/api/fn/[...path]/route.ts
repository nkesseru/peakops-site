import { NextRequest } from "next/server";

const BASE = process.env.NEXT_PUBLIC_FN_BASE
  || "http://127.0.0.1:5001/peakops-pilot/us-central1";

async function handler(req: NextRequest, { params }: { params: { path: string[] } }) {
  const subpath = params.path.join("/");
  const url = new URL(`${BASE}/${subpath}`);

  // forward query params
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const method = req.method;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const bodyText = method === "GET" ? undefined : await req.text();

  const resp = await fetch(url.toString(), {
    method,
    headers,
    body: bodyText && bodyText.length ? bodyText : undefined,
  });

  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { "Content-Type": "application/json" } });
}

export async function GET(req: NextRequest, ctx: any) { return handler(req, ctx); }
export async function POST(req: NextRequest, ctx: any) { return handler(req, ctx); }
