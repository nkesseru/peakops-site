export async function GET() {
  return Response.json({ ok: true, ts: Date.now() });
}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
