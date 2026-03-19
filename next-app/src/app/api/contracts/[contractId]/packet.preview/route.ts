import { proxyGET } from "../../../fn/_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // proxy to exportContractPacketV1 (returns JSON with zipBase64)
  // then strip the base64 to keep preview light
  const r = await proxyGET(req, "exportContractPacketV1");
  const j = await r.json().catch(() => null);

  if (!j?.ok) return new Response(JSON.stringify(j || { ok:false, error:"preview failed" }), { status: 400, headers:{ "Content-Type":"application/json" } });

  const { zipBase64, ...rest } = j;
  return new Response(JSON.stringify({ ok:true, preview: rest }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
