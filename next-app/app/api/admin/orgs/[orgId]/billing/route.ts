// PEAKOPS_ADMIN_BILLING_ROUTE_V1 (2026-05-13)
//
// POST /api/admin/orgs/{orgId}/billing
//
// Companion route to /admin/orgs/{orgId}/billing. Accepts the
// HTML form submission, validates + merges into
// orgs/{orgId}/billing/state, and 303-redirects back to the editor
// with ?saved=1.
//
// Gate: inherited from next-app/middleware.ts — the /admin/* matcher
// guards /api/admin/* indirectly because the editor page is /admin
// and the form action lives on the same origin. The middleware
// matcher is specifically `/admin/:path*`, so this /api/admin/*
// path is NOT covered by middleware. We therefore re-check the
// stormwatch-auth cookie here before writing. Defense in depth.

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";

export const runtime = "nodejs";

const STATUSES = new Set(["active", "suspended", "cancelled"]);
const FEATURE_KEYS = ["riskDefenseModule", "api", "sso", "whiteLabel"] as const;
const LIMIT_KEYS = [
  "capacityIncluded",
  "capacityPurchased",
  "storageGB",
  "filingsPerMonth",
  "retentionDays",
] as const;

function parseNonNegNumber(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  // Defense in depth: middleware matcher covers /admin/* but not
  // /api/admin/*, so the form action would be reachable without
  // the cookie unless we re-check here.
  const cookie = req.cookies.get("stormwatch-auth")?.value;
  if (cookie !== "ok") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;
  const cleanOrgId = String(orgId || "").trim();
  if (!cleanOrgId) {
    return NextResponse.json({ ok: false, error: "orgId required" }, { status: 400 });
  }

  const fd = await req.formData();

  const update: Record<string, unknown> = {
    lastUpdatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: "internal-admin",
  };

  // plan: free-form string (informational label).
  update.plan = String(fd.get("plan") || "").trim();

  // status: strict enum.
  const status = String(fd.get("status") || "").trim().toLowerCase();
  if (STATUSES.has(status)) {
    update.status = status;
  }

  // entitlements: boolean per known key. Checkbox absence in the
  // FormData payload means false, so we always write a complete
  // object — this is intentional, so toggling OFF actually persists.
  const entitlements: Record<string, boolean> = {};
  for (const k of FEATURE_KEYS) {
    entitlements[k] = fd.get(`entitlements.${k}`) === "on";
  }
  update.entitlements = entitlements;

  // limits: numbers per known key; skip blank inputs (preserves
  // pre-existing values via the merge:true write).
  const limits: Record<string, number> = {};
  for (const k of LIMIT_KEYS) {
    const n = parseNonNegNumber(fd.get(`limits.${k}`));
    if (n !== null) limits[k] = n;
  }
  if (Object.keys(limits).length > 0) {
    update.limits = limits;
  }

  // stripe references: trimmed strings (always written so the field
  // can be cleared via the form).
  update.stripeCustomerId = String(fd.get("stripeCustomerId") || "").trim();
  update.stripeSubscriptionId = String(fd.get("stripeSubscriptionId") || "").trim();

  // notes: textarea, preserved verbatim (no trim — operators may
  // want trailing newlines / formatting).
  update.notes = String(fd.get("notes") || "");

  await adminDb
    .doc(`orgs/${cleanOrgId}/billing/state`)
    .set(update, { merge: true });

  // 303 See Other converts the POST to a GET so a browser refresh
  // does not re-submit the form.
  const back = new URL(
    `/admin/orgs/${encodeURIComponent(cleanOrgId)}/billing`,
    req.url,
  );
  back.searchParams.set("saved", "1");
  return NextResponse.redirect(back, { status: 303 });
}
