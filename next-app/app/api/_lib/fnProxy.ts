import { NextResponse } from "next/server";
import { getFunctionsBase } from "@/lib/functionsBase";

function pickBase() {
  const canonical = String(getFunctionsBase() || "").trim();
  const base =
    canonical ||
    String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim() ||
    String(process.env.FUNCTIONS_BASE || "").trim() ||
    String(process.env.FN_BASE || "").trim();
  if (!base) {
    return {
      ok: false as const,
      error: "envMissing:functions_base",
      checked: ["NEXT_PUBLIC_FUNCTIONS_BASE", "FUNCTIONS_BASE", "FN_BASE"],
    };
  }
  return { ok: true as const, base };
}

// Emulator base includes /us-central1; Cloud Run base does NOT.
// This keeps both working.
function buildUrl(req: Request, fnName: string, base: string) {
  const normalized = base.replace(/\/+$/, "");
  const inUrl = new URL(req.url);

  const target = new URL(normalized);
  const isCloudRun = normalized.includes(".a.run.app");
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
  if (!String(fnName || "").trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_fn_name",
        details: { method: "GET", reqUrl: req.url },
      },
      { status: 400 }
    );
  }
  const p = pickBase();
  if (!p.ok) {
    return NextResponse.json(
      { ok: false, error: p.error, details: { checked: p.checked, method: "GET", fnName } },
      { status: 500 }
    );
  }
  const url = buildUrl(req, fnName, p.base);

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

    return NextResponse.json(
      {
        ok: false,
        error: "upstream_non_json",
        details: {
          targetUrl: url,
          method: "GET",
          status: r.status,
          bodySnippet: String(parsed.body || "").slice(0, 500),
        },
      },
      { status: r.status >= 400 ? r.status : 502 }
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "proxy_get_failed",
        details: {
          targetUrl: url,
          method: "GET",
          status: 0,
          message: String(e?.message || e),
        },
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(t);
  }
}

export async function proxyPOST(req: Request, fnName: string, bodyObj: any) {
  if (!String(fnName || "").trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_fn_name",
        details: { method: "POST", reqUrl: req.url },
      },
      { status: 400 }
    );
  }
  const p = pickBase();
  if (!p.ok) {
    return NextResponse.json(
      { ok: false, error: p.error, details: { checked: p.checked, method: "POST", fnName } },
      { status: 500 }
    );
  }
  const url = buildUrl(req, fnName, p.base);

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

    return NextResponse.json(
      {
        ok: false,
        error: "upstream_non_json",
        details: {
          targetUrl: url,
          method: "POST",
          status: r.status,
          bodySnippet: String(parsed.body || "").slice(0, 500),
        },
      },
      { status: r.status >= 400 ? r.status : 502 }
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "proxy_post_failed",
        details: {
          targetUrl: url,
          method: "POST",
          status: 0,
          message: String(e?.message || e),
        },
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(t);
  }
}
