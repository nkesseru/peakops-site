import { NextResponse } from "next/server";

function pickBase() {
  return process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
}

// Emulator base includes /us-central1; Cloud Run base does NOT.
// This keeps both working.
function buildUrl(req: Request, fnName: string) {
  const base = pickBase().replace(/\/+$/, "");
  const inUrl = new URL(req.url);

  const target = new URL(base);
  const isCloudRun = base.includes(".a.run.app");
  target.pathname = isCloudRun
    ? `/${String(fnName).replace(/^\//, "")}`
    : `${target.pathname.replace(/\/+$/, "")}/${String(fnName).replace(/^\//, "")}`;

  target.search = inUrl.search;
  return target.toString();
}

function cleanHeaders(hIn: Headers) {
  const h = new Headers(hIn);
  // remove headers that can confuse fetch/proxies
  h.delete("host");
  h.delete("connection");
  h.delete("content-length");
  return h;
}

async function safeJsonOrText(r: Response) {
  const text = await r.text();
  if (!text || !text.trim()) {
    return { kind: "json" as const, body: { ok: false, error: `Upstream returned empty body (HTTP ${r.status})` } };
  }
  try {
    return { kind: "json" as const, body: JSON.parse(text) };
  } catch {
    return { kind: "text" as const, body: text };
  }
}

export async function proxyGET(req: Request, fnName: string) {
  const url = buildUrl(req, fnName);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: cleanHeaders(new Headers(req.headers)),
      signal: ac.signal,
    });

    const parsed = await safeJsonOrText(r);
    if (parsed.kind === "json") return NextResponse.json(parsed.body, { status: r.status });

    // Return text but keep status so UI can show the real failure
    return new Response(parsed.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `proxyGET failed: ${String(e?.message || e)}` }, { status: 502 });
  } finally {
    clearTimeout(t);
  }
}

export async function proxyPOST(req: Request, fnName: string, bodyObj: any) {
  const url = buildUrl(req, fnName);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: (() => {
        const h = cleanHeaders(new Headers(req.headers));
        if (!h.get("content-type")) h.set("content-type", "application/json");
        return h;
      })(),
      body: JSON.stringify(bodyObj ?? {}),
      signal: ac.signal,
    });

    const parsed = await safeJsonOrText(r);
    if (parsed.kind === "json") return NextResponse.json(parsed.body, { status: r.status });

    return new Response(parsed.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `proxyPOST failed: ${String(e?.message || e)}` }, { status: 502 });
  } finally {
    clearTimeout(t);
  }
}
