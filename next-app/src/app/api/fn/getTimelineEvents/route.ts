import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  // IMPORTANT: function alias in emulator is getTimelineEvents (points to getTimelineEventsV1)
  return proxyGET(req, "getTimelineEvents");
}
