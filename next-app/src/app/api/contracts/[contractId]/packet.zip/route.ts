import { proxyGET } from "../../../fn/_lib/fnProxy";

export const runtime = "nodejs";

function b64ToUint8(b64: string) {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf);
}

export async function GET(req: Request) {
  const r = await proxyGET(req, "exportContractPacketV1");
  const j = await r.json().catch(() => null);

  if (!j?.ok) {
    return new Response(JSON.stringify(j || { ok:false, error:"exportContractPacketV1 failed" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const bytes = b64ToUint8(j.zipBase64 || "");
  const filename = (j.filename || "contract_packet.zip").replace(/[^a-zA-Z0-9._-]/g, "_");

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
