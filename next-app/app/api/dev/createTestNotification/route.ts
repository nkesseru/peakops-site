import { NextResponse } from "next/server";
// PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
// Dev-only test write. Bypasses the production fan-out path so we
// can verify the bell's READ pipeline is healthy independently of
// whether the producer triggers (submitFieldSessionV1,
// exportIncidentPacketV1) are firing.
//
// Relative imports (not the @/ alias) because tsconfig paths
// resolve `@/lib/*` to `src/lib/*` first; the firebase-admin and
// verifyAuth helpers here live at the root `lib/`. Same pattern
// /api/reports/[incidentId]/download uses.
import { adminDb } from "../../../../lib/firebaseAdmin";
import { AuthError, verifyAuthHeader } from "../../../../lib/verifyAuth";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

/**
 * POST /api/dev/createTestNotification
 *
 * Writes a test notification doc to users/{currentUid}/notifications.
 * Useful for proving the bell's read path works before chasing
 * producer triggers.
 *
 * Gated on:
 *   - dev mode: NODE_ENV !== "production" OR the request URL has
 *     `?dev=1`. Production requests without ?dev=1 get 404 so the
 *     route never accidentally pollutes prod data.
 *   - bearer token: must verify via Firebase Admin so we know
 *     whose feed to write into.
 *
 * Returns:
 *   200 { ok: true, id, path } on success
 *   401/403 on auth failure
 *   404 in production without ?dev=1
 */
function isDevAllowed(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    const url = new URL(req.url);
    const flag = String(url.searchParams.get("dev") || "").trim();
    return flag === "1" || flag.toLowerCase() === "true";
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!isDevAllowed(req)) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }

  let uid = "";
  try {
    const decoded = await verifyAuthHeader(req);
    uid = String(decoded.uid || "");
  } catch (e: any) {
    const status = e instanceof AuthError ? Number(e.status) : 401;
    return NextResponse.json(
      { ok: false, error: status === 403 ? "forbidden" : "unauthorized" },
      { status },
    );
  }
  if (!uid) {
    return NextResponse.json(
      { ok: false, error: "no_uid" },
      { status: 401 },
    );
  }

  // PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
  // Spec payload — verbatim from the debug ask. orgId hard-coded
  // to "demo-org" for parity with the dev environment; if the
  // caller passes orgId in the body we honor that override.
  let bodyObj: any = null;
  try {
    const bodyText = await req.text();
    if (bodyText) bodyObj = JSON.parse(bodyText);
  } catch {
    /* ignore — we'll fall back to defaults */
  }
  const orgIdOverride = String(bodyObj?.orgId || "").trim();
  const orgId = orgIdOverride || "demo-org";
  const targetUrl = String(bodyObj?.targetUrl || "").trim()
    || `/incidents?orgId=${encodeURIComponent(orgId)}`;

  try {
    const ref = adminDb
      .collection("users").doc(uid)
      .collection("notifications").doc();
    const docPath = `users/${uid}/notifications/${ref.id}`;
    await ref.set({
      type: "test",
      title: "Test notification",
      message: "Notification write path is working.",
      orgId,
      incidentId: null,
      targetUrl,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    // eslint-disable-next-line no-console
    console.log(`[notify-debug] dev test write uid=${uid} path=${docPath}`);
    return NextResponse.json({ ok: true, id: ref.id, path: docPath }, { status: 200 });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn("[notify-debug] dev test write failed", {
      uid,
      code: e?.code || null,
      message: String(e?.message || e),
    });
    return NextResponse.json(
      { ok: false, error: "write_failed", code: e?.code || null, message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
