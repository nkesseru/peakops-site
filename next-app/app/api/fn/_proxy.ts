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
  // Prefer env override, else default emulator
  const base =
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
