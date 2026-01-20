export const runtime = "nodejs";

function fnBase(): string {
  const base =
    process.env.FN_BASE ||
    process.env.NEXT_PUBLIC_FN_BASE ||
    "http://127.0.0.1:5001/peakops-pilot/us-central1";
  return base.replace(/\/+$/, "");
}

export async function proxyGET(req: Request, fnName: string) {
  const url = new URL(req.url);
  const upstream = `${fnBase()}/${fnName}?${url.searchParams.toString()}`;
  return fetch(upstream, { method: "GET" });
}

export async function proxyPOST(req: Request, fnName: string) {
  const url = new URL(req.url);
  const upstream = `${fnBase()}/${fnName}?${url.searchParams.toString()}`;

  // Always read JSON once and forward it as a clean JSON body.
  const body = await req.json().catch(() => ({}));

  return fetch(upstream, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
