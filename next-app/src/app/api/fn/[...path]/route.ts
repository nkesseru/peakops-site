import { NextRequest, NextResponse } from "next/server";

const BASE =
  process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE ||
  "http://127.0.0.1:5001/peakops-pilot/us-central1";

function targetUrl(req: NextRequest) {
  const url = new URL(req.url);
  const prefix = "/api/fn/";
  const subpath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  const target = new URL(`${BASE}/${subpath}`);
  url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
  return target;
}

async function forward(req: NextRequest) {
  const target = targetUrl(req);

  const headers = new Headers(req.headers);
  headers.delete("host");

  const init: RequestInit = { method: req.method, headers };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const res = await fetch(target.toString(), init);
  const text = await res.text();

  return new NextResponse(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "application/json",
    },
  });
}

export async function GET(req: NextRequest) { return forward(req); }
export async function POST(req: NextRequest) { return forward(req); }
export async function PUT(req: NextRequest) { return forward(req); }
export async function PATCH(req: NextRequest) { return forward(req); }
export async function DELETE(req: NextRequest) { return forward(req); }
