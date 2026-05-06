import { enforceOrgAndProxy } from "../_orgProxy";

export const runtime = "nodejs";

// Next 16: params is async
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return enforceOrgAndProxy(req, String(name || ""));
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return enforceOrgAndProxy(req, String(name || ""));
}
