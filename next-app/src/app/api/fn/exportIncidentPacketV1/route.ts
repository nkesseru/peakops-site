import { proxyGET } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return proxyGET(req, "exportIncidentPacketV1");
}
