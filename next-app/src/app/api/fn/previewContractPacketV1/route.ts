import { proxyGET } from "../_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const r = await proxyGET(req, "exportContractPacketV1");
  const text = await r.text();

  try {
    const j = JSON.parse(text);
    // Remove huge zipBase64 for preview endpoint
    if (j && typeof j === "object" && "zipBase64" in j) delete j.zipBase64;
    return new Response(JSON.stringify(j), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(text, { status: r.status, headers: { "Content-Type": "text/plain" } });
  }
}
