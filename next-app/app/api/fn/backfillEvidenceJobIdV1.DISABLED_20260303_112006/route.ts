import { proxyPOST } from "../../_lib/fnProxy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  return proxyPOST(req, "backfillEvidenceJobIdV1", body);
}

