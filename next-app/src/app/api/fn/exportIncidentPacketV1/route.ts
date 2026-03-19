import { proxyGET } from "../_lib/fnProxy";

export const runtime = "nodejs";

// GET /api/fn/exportIncidentPacketV1?orgId=...&incidentId=...&force=1
export async function GET(req: Request) {
  return proxyGET(req, "exportIncidentPacketV1");
}
