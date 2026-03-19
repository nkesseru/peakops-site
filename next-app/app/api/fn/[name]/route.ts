import { proxy } from "../_proxy";

// Next 16: params is async
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return proxy(req, String(name || ""));
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return proxy(req, String(name || ""));
}
