export function functionsBase(): string {
  // Prefer env override, else default emulator
  const base =
    process.env.NEXT_PUBLIC_FUNCTIONS_BASE ||
    process.env.FUNCTIONS_BASE ||
    "http://127.0.0.1:5004/peakops-pilot/us-central1";
  return String(base).replace(/\/+$/, "");
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

  const upstream = await fetch(target, {
    method,
    headers,
    body: body ? Buffer.from(body) : undefined,
    // keep things deterministic in dev
    cache: "no-store",
  });

  // Stream response back
  const respHeaders = new Headers();
  upstream.headers.forEach((v, k) => respHeaders.set(k, v));

  const buf = await upstream.arrayBuffer();
  return new Response(buf, { status: upstream.status, headers: respHeaders });
}
