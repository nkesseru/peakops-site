import { NextResponse } from "next/server";

/**
 * /api/media?bucket=...&path=...
 * Streams bytes from the Firebase Storage emulator and forces inline headers so images render in <img>.
 */
function guessContentType(path: string): string {
  const p = String(path || "").toLowerCase();
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".heic")) return "image/heic";
  if (p.endsWith(".heif")) return "image/heif";
  if (p.endsWith(".mp4")) return "video/mp4";
  if (p.endsWith(".mov")) return "video/quicktime";
  return "application/octet-stream";
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const bucket = String(url.searchParams.get("bucket") || "").trim();
    const path = String(url.searchParams.get("path") || "").trim();

    // PEAKOPS_MEDIA_DECODE_V1
    // If caller pre-encoded the path (orgs%2F...), decode it once so we don’t double-encode.
    let decodedPath = path;
    try { decodedPath = decodeURIComponent(path); } catch (_) {}


    if (!bucket || !path) {
      return NextResponse.json({ ok: false, error: "bucket and path required" }, { status: 400 });
    }

    const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
    const upstream = `http://${host}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(decodedPath)}?alt=media`;

    const upstreamRes = await fetch(upstream, {
      method: "GET",
      // Pass Range through if browser requests it (helps video + big images)
      headers: req.headers.get("range") ? { Range: req.headers.get("range")! } : undefined,
      cache: "no-store",
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      const txt = await upstreamRes.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: "upstream_failed", status: upstreamRes.status, details: txt.slice(0, 300) },
        { status: upstreamRes.status || 502 }
      );
    }

    const h = new Headers(upstreamRes.headers);

    // Force image-friendly headers
    h.set("content-type", guessContentType(decodedPath));
    const fileName = decodeURIComponent(String(decodedPath).split("/").pop() || "file");
    h.set("content-disposition", `inline; filename="${fileName}"`);

    // Prevent caching weirdness in dev
    h.set("cache-control", "no-store");

    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: h });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e || "error") }, { status: 500 });
  }
}
