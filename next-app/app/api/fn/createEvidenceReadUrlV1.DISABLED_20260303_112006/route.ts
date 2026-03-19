import { proxyPOST } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  if (!body.storagePath && body.path) body.storagePath = body.path;
  return proxyPOST(req, "createEvidenceReadUrlV1", body);
}
