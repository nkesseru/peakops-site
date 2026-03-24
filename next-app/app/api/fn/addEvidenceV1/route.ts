import { proxy } from "../_proxy";

export async function POST(req: Request) {
  return proxy(req, "addEvidenceV1");
}

export async function GET(req: Request) {
  return proxy(req, "addEvidenceV1");
}
