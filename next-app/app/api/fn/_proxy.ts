function isLocalDev() {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENV === "local";
}

function normalizeLocalFunctionsBase(v: string): string {
  const b = String(v || "").replace(/\/+$/, "");
  if (!b || !isLocalDev()) return b;
  return b
    .replace("://127.0.0.1:5001/", "://127.0.0.1:5004/")
    .replace("://localhost:5001/", "://localhost:5004/");
}

export function functionsBase(): string {
  // PEAKOPS_PROXY_FN_BASE_RESOLVE_V1 (2026-05-07)
  // Resolution order:
  //   1. NEXT_PUBLIC_PEAKOPS_FN_BASE — canonical name documented in
  //      INTERNAL_ALPHA_DEPLOY_CHECKLIST.md and matched by the legacy
  //      src/app/api/fn/[...path]/route.ts proxy. This is the value
  //      Vercel Production has set.
  //   2. NEXT_PUBLIC_FUNCTIONS_BASE — legacy alias, kept for any
  //      environment that already wires this name. .env.local.example
  //      still references it for emulator-mode dev.
  //   3. FUNCTIONS_BASE — server-side companion for emulator dev.
  //   4. Local emulator fallback for first-run dev sessions.
  const base =
    process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE ||
    process.env.NEXT_PUBLIC_FUNCTIONS_BASE ||
    process.env.FUNCTIONS_BASE ||
    "http://127.0.0.1:5004/peakops-pilot/us-central1";
  return normalizeLocalFunctionsBase(String(base));
}

function copyHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    // Don't forward hop-by-hop headers
    if (["host", "connection", "content-length"].includes(key)) return;
    out[k] = v;
  });
  return out;
}

export async function proxy(req: Request, name: string): Promise<Response> {
  const url = new URL(req.url);
  const target = `${functionsBase()}/${encodeURIComponent(name)}${url.search}`;

  const method = req.method.toUpperCase();
  const headers = copyHeaders(req);

  // IMPORTANT: forward body RAW for POST/PUT/PATCH (multipart, binary, etc.)
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: body ? Buffer.from(body) : undefined,
      // keep things deterministic in dev
      cache: "no-store",
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Functions backend unreachable",
        detail: String(e?.message || e),
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // PEAKOPS_PROXY_UPSTREAM_DIAG_V1 (2026-04-30)
  // Dev-only: when the upstream Cloud Function returns a non-2xx,
  // log the function name + status + body snippet so a regression
  // like the listIncidentsV1 401 is visible in the server log
  // without having to attach Cloud Run logs. Production stays silent.
  if (process.env.NODE_ENV !== "production" && upstream.status >= 400) {
    try {
      const cloned = upstream.clone();
      const peek = await cloned.text();
      // eslint-disable-next-line no-console
      console.warn(`[proxy] ${name} upstream ${upstream.status}`, peek.slice(0, 280));
    } catch {
      /* ignore — diagnostic only */
    }
  }

  // If upstream returned non-JSON, wrap as JSON so callers can safely r.json()
  const ct = upstream.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await upstream.text();
    return new Response(
      JSON.stringify({ ok: false, error: text || `Upstream returned ${upstream.status}` }),
      { status: upstream.status, headers: { "content-type": "application/json" } },
    );
  }

  // Stream JSON response back
  const respHeaders = new Headers();
  upstream.headers.forEach((v, k) => respHeaders.set(k, v));

  const buf = await upstream.arrayBuffer();
  return new Response(buf, { status: upstream.status, headers: respHeaders });
}
