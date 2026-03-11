export const runtime = "nodejs";

export async function GET() {
  return Response.json(
    { ok: false, error: "storage_proxy_deprecated_use_minted_url" },
    { status: 410 }
  );
}

export async function POST() {
  return Response.json(
    { ok: false, error: "storage_proxy_deprecated_use_minted_url" },
    { status: 410 }
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
