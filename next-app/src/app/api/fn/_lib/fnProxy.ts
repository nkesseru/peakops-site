export const runtime = "nodejs";

type Req = Request;

function getFnBase() {
  // Prefer env. Fall back to emulator.
  return (
    process.env.FN_BASE ||
    "http://127.0.0.1:5001/peakops-pilot/us-central1"
  ).replace(/\/+$/, "");
}

function requiredKeys(fnName: string) {
  // List endpoints: orgId only
  if (fnName === "getContractsV1" || fnName === "listContractsV1") {
    return ["orgId"];
  }
  // Contract-scoped endpoints
  if (
    fnName === "getContractV1" ||
    fnName === "getContractPayloadsV1" ||
    fnName === "writeContractPayloadV1" ||
    fnName === "exportContractPacketV1"
  ) {
    return ["orgId", "contractId"];
  }
  // Default: orgId only (safe)
  return ["orgId"];
}

function jsonResp(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function proxyFetch(req: Req, fnName: string, method: "GET" | "POST") {
  const base = getFnBase();
  const url = new URL(req.url);
  const sp = url.searchParams;

  // Normalize orgid/contractid aliases (defensive)
  if (!sp.get("orgId") && sp.get("orgid")) sp.set("orgId", sp.get("orgid")!);
  if (!sp.get("contractId") && sp.get("contractid")) sp.set("contractId", sp.get("contractid")!);
  if (!sp.get("contractId") && sp.get("id")) sp.set("contractId", sp.get("id")!);

  // Enforce required params per endpoint
  const reqKeys = requiredKeys(fnName);
  for (const k of reqKeys) {
    if (!sp.get(k)) {
      return jsonResp({ ok: false, error: `Missing ${k}` }, 400);
    }
  }

  // Build target
  const target = new URL(`${base}/${fnName}`);

  // Copy query params through for GET calls
  if (method === "GET") {
    for (const [k, v] of sp.entries()) target.searchParams.set(k, v);
    const r = await fetch(target.toString(), { method: "GET" });
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      return jsonResp(j, r.status);
    } catch {
      return new Response(text, { status: r.status, headers: { "Content-Type": "text/plain" } });
    }
  }

  // POST: forward JSON body
  const bodyText = await req.text();
  const contentType = req.headers.get("content-type") || "application/json";

  const r = await fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bodyText,
  });

  const text = await r.text();
  try {
    const j = JSON.parse(text);
    return jsonResp(j, r.status);
  } catch {
    return new Response(text, { status: r.status, headers: { "Content-Type": "text/plain" } });
  }
}

export async function proxyGET(req: Req, fnName: string) {
  return proxyFetch(req, fnName, "GET");
}
export async function proxyPOST(req: Req, fnName: string) {
  return proxyFetch(req, fnName, "POST");
}
