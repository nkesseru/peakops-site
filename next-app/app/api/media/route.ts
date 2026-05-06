import { NextResponse } from "next/server";

/**
 * /api/media?bucket=...&path=...
 * Streams bytes from the Firebase Storage EMULATOR and forces inline headers so
 * images render in <img>. Emulator-only by design — in production the browser
 * fetches real signed URLs directly from storage.googleapis.com.
 *
 * PEAKOPS_MEDIA_EMULATOR_GATE_V1 (2026-04-24)
 * Gate based on the Cloud Functions base the app is pointed at. If that's a
 * real cloudfunctions.net URL, this proxy has no legitimate reason to run —
 * refuse the request with 410 Gone so a stale emulator-URL leak from a
 * not-yet-redeployed backend doesn't hit 127.0.0.1:9199 from the Next
 * server-side runtime and surface as a confusing timeout/404.
 */
function isEmulatorFunctionsBase(): boolean {
  const base = String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim();
  // Also allow the FIREBASE_STORAGE_EMULATOR_HOST escape hatch when the
  // Storage emulator is explicitly running (e.g. `firebase emulators:start`
  // has injected this into the Next dev process via a wrapper script).
  const storageEmuHost = String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "").trim();
  if (storageEmuHost) return true;
  if (!base) return false;
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

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
    if (!isEmulatorFunctionsBase()) {
      // PEAKOPS_MEDIA_410_SANITIZE_V1 (2026-05-01)
      // Out of emulator, this proxy is intentionally disabled.
      // Customer-safe response — no internal function names, no URL
      // hints in the body. Diagnostic detail goes to server logs only.
      console.warn(
        "[/api/media] called outside emulator — disabled by design; caller should use a signed URL or /api/reports/<id>/download.",
      );
      return NextResponse.json(
        {
          ok: false,
          error: "download_unavailable",
          message: "This download link is unavailable. Refresh the page and try again.",
        },
        { status: 410 },
      );
    }

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
