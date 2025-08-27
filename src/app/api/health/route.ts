export const dynamic = "force-dynamic"; // never cache

export async function GET() {
  return Response.json({
    ok: true,
    ts: Date.now(),
    env: process.env.VERCEL ? "vercel" : "local",
  });
}
