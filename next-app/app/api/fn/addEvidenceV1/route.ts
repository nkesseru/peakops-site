import { enforceOrgAndProxy } from "../_orgProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return enforceOrgAndProxy(req, "addEvidenceV1");
}

export async function POST(req: Request) {
  return enforceOrgAndProxy(req, "addEvidenceV1");
}
