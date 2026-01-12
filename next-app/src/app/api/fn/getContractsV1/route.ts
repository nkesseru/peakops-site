import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getContractsV1");
}
