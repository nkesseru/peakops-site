import { NextResponse } from "next/server";
// PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
// Relative imports (not the @/ alias) because the project's
// tsconfig paths resolve `@/lib/*` to `src/lib/*` first, and
// `src/lib/firebaseAdmin.ts` is a different file with a different
// shape than the root `lib/firebaseAdmin.ts`. Same for verifyAuth.
import { adminDb, adminStorage } from "../../../../../lib/firebaseAdmin";
import { requireOrgAccess, AuthError } from "../../../../../lib/verifyAuth";

export const runtime = "nodejs";

/**
 * PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
 *
 * GET /api/reports/<incidentId>/download?orgId=<orgId>
 *
 * Customer-facing report download. The URL exposes only the
 * incidentId — bucket and storagePath stay server-side. Auth and
 * org-membership are enforced via the same Bearer-token + orgIds
 * claim gate the rest of /api/fn/* uses.
 *
 * Resolution order for the report bytes (in order of preference):
 *   1. Local dev / emulator: stream the ZIP through this route. No
 *      reliance on signed-URL IAM; works without a service-account
 *      key. Tries the Storage emulator HTTP endpoint first, then
 *      falls back to the Admin SDK download() in case the bucket is
 *      a real GCS bucket fronted by ADC creds.
 *   2. Production: try a 5-minute v4 signed URL + 302 redirect. If
 *      that fails (most commonly because the runtime SA lacks
 *      `iam.serviceAccountTokenCreator`), fall through to streaming
 *      via Admin SDK so customers aren't blocked by an IAM gap we
 *      can fix at our leisure.
 *
 * Failure surface (all customer-safe — no bucket/path leaks):
 *   - 401 / 403 — auth or org-membership failure (`requireOrgAccess`)
 *   - 404 — incident not found, or no report yet generated
 *   - 502 — upstream Storage call failed
 *   - 503 — sign + stream both failed
 */

function devLog(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.debug("[report-download]", ...args);
  }
}

function isEmu(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB ||
    !!process.env.FIREBASE_STORAGE_EMULATOR_HOST
  );
}

function emuStorageHost(): string {
  return String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").trim();
}

type PacketInfo = {
  bucket: string;
  storagePath: string;
  zipName: string;
};

async function readPacketMeta(
  incidentId: string,
  orgId: string,
): Promise<PacketInfo | null> {
  // PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
  // Mirrors getIncidentV1 / exportIncidentPacketV1: try the
  // org-scoped doc first (where exports usually land), then fall
  // back to the canonical top-level path.
  let data: FirebaseFirestore.DocumentData | null = null;
  if (orgId) {
    const orgScoped = await adminDb
      .doc(`orgs/${orgId}/incidents/${incidentId}`)
      .get();
    if (orgScoped.exists) data = orgScoped.data() || null;
  }
  if (!data) {
    const top = await adminDb.collection("incidents").doc(incidentId).get();
    if (top.exists) data = top.data() || null;
  }
  if (!data) return null;

  const pm: any = data.packetMeta || null;
  if (!pm) return null;
  const bucket = String(pm.bucket || "").trim();
  const storagePath = String(pm.storagePath || "").trim();
  if (!bucket || !storagePath) return null;
  const zipName = storagePath.split("/").pop() || `report_${incidentId}.zip`;
  return { bucket, storagePath, zipName };
}

function streamHeaders(zipName: string): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/zip");
  headers.set("content-disposition", `attachment; filename="${zipName}"`);
  headers.set("cache-control", "no-store");
  return headers;
}

async function streamFromEmulator(info: PacketInfo): Promise<Response | null> {
  try {
    const host = emuStorageHost();
    const upstream =
      `http://${host}/download/storage/v1/b/${encodeURIComponent(info.bucket)}/o/` +
      `${encodeURIComponent(info.storagePath)}?alt=media`;
    const res = await fetch(upstream, { cache: "no-store" });
    if (!res.ok || !res.body) {
      devLog("emulator upstream non-ok", res.status);
      return null;
    }
    return new Response(res.body, { status: 200, headers: streamHeaders(info.zipName) });
  } catch (e) {
    devLog("emulator fetch failed", (e as any)?.message || e);
    return null;
  }
}

async function streamFromAdmin(info: PacketInfo): Promise<Response | null> {
  try {
    const file = adminStorage.bucket(info.bucket).file(info.storagePath);
    const [buf] = await file.download();
    // Copy into a fresh ArrayBuffer-backed Uint8Array. Node's Buffer
    // is backed by ArrayBufferLike (potentially Shared), which our
    // TS lib config rejects as a BlobPart / BodyInit.
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    const blob = new Blob([bytes], { type: "application/zip" });
    return new Response(blob, { status: 200, headers: streamHeaders(info.zipName) });
  } catch (e) {
    devLog("admin download failed", (e as any)?.message || e);
    return null;
  }
}

async function trySignedUrl(info: PacketInfo): Promise<string | null> {
  try {
    const file = adminStorage.bucket(info.bucket).file(info.storagePath);
    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 5 * 60 * 1000,
      responseDisposition: `attachment; filename="${info.zipName}"`,
    });
    return signedUrl;
  } catch (e) {
    devLog("sign failed", (e as any)?.message || e);
    return null;
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ incidentId: string }> },
) {
  const { incidentId: rawId } = await ctx.params;
  const incidentId = String(rawId || "").trim();
  if (!incidentId) {
    return NextResponse.json(
      { ok: false, error: "missing_incident", message: "Incident not specified." },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const orgId = String(url.searchParams.get("orgId") || "").trim();

  // Auth + org-membership.
  let authCtx;
  try {
    authCtx = await requireOrgAccess(req, orgId);
    devLog("auth ok", { uid: authCtx.uid, orgId: authCtx.orgId, incidentId });
  } catch (e: any) {
    const status = e instanceof AuthError ? Number(e.status) : 401;
    devLog("auth failed", status, e?.message);
    return NextResponse.json(
      {
        ok: false,
        error: status === 403 ? "forbidden" : "unauthorized",
        message:
          status === 403
            ? "You don't have access to this report."
            : "Sign in and try again.",
      },
      { status },
    );
  }
  devLog("org ok", { orgId });

  // Look up the report storage path from the incident doc.
  let info: PacketInfo | null;
  try {
    info = await readPacketMeta(incidentId, orgId);
  } catch (e) {
    devLog("lookup failed", (e as any)?.message || e);
    return NextResponse.json(
      {
        ok: false,
        error: "lookup_failed",
        message: "We couldn't load this report. Try again in a moment.",
      },
      { status: 503 },
    );
  }
  if (!info) {
    devLog("report path not found", { incidentId, orgId });
    return NextResponse.json(
      {
        ok: false,
        error: "report_not_ready",
        message: "No report has been generated for this incident yet.",
      },
      { status: 404 },
    );
  }
  devLog("report path found", { incidentId, zipName: info.zipName });

  // Local/dev/emulator path — stream through this route.
  if (isEmu()) {
    const emuRes = await streamFromEmulator(info);
    if (emuRes) {
      devLog("bytes streamed (emulator)", { zipName: info.zipName });
      devLog("response sent");
      return emuRes;
    }
    // Fall back to Admin SDK download in case the bucket isn't actually
    // emulated (e.g. dev pointed at a real GCS bucket via ADC).
    const adminRes = await streamFromAdmin(info);
    if (adminRes) {
      devLog("bytes streamed (admin fallback)", { zipName: info.zipName });
      devLog("response sent");
      return adminRes;
    }
    return NextResponse.json(
      {
        ok: false,
        error: "download_unavailable",
        message: "This download link is unavailable. Refresh the page and try again.",
      },
      { status: 502 },
    );
  }

  // Production path — prefer a short-lived signed URL + 302 redirect.
  // Bandwidth stays on Storage. Fall back to streaming if signing
  // fails (most common cause: missing serviceAccountTokenCreator).
  const signedUrl = await trySignedUrl(info);
  if (signedUrl) {
    devLog("signed url created");
    devLog("response sent");
    return NextResponse.redirect(signedUrl, 302);
  }
  const adminRes = await streamFromAdmin(info);
  if (adminRes) {
    devLog("bytes streamed (prod fallback)", { zipName: info.zipName });
    devLog("response sent");
    return adminRes;
  }
  return NextResponse.json(
    {
      ok: false,
      error: "download_unavailable",
      message: "This download link is unavailable. Refresh the page and try again.",
    },
    { status: 503 },
  );
}
