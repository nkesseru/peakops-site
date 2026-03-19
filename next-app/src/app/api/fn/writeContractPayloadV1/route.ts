import { proxyPOST } from "../_lib/proxy";
export const runtime = "nodejs";
export async function POST(req: Request) { return proxyPOST(req, "writeContractPayloadV1"); }
