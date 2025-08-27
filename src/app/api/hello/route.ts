import { getHello } from "@/lib/api/hello";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getHello();
  return Response.json(data);
}
