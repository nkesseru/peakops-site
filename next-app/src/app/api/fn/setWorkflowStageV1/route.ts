import { proxyPOST } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function POST(req: Request) { return proxyPOST(req, "setWorkflowStageV1"); }
