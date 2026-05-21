import { NextResponse } from "next/server";
import { proxy } from "../../fn/_proxy";
import { requireOrgAccess, AuthError } from "../../../../lib/verifyAuth";

// PEAKOPS_RAPID_ACCESS_RECOVERY_V1 (PR 49)
//
// POST /api/team/recovery
//
// Customer-app side of the Rapid Access Recovery flow. Verifies the
// caller is authenticated and a member of the target org via the same
// Bearer + orgIds claim gate the rest of /api/fn uses, then proxies
// to teamRecoveryV1 (which enforces role + audits the
// action server-side).
//
// We do NOT enforce role here — that lives in the Cloud Function so a
// single source of truth gates the action. The Next-side check
// short-circuits anonymous / cross-org calls before they cross the
// wire, but isn't authoritative on its own.

export const runtime = "nodejs";

type RecoveryBody = {
  orgId?: string;
  targetEmail?: string;
  mode?: string;
  reason?: string;
};

export async function POST(req: Request) {
  // Parse the body once so we can extract orgId for the auth gate.
  // The proxy needs to forward the original body, so we re-serialize
  // and re-attach it to a fresh Request.
  let body: RecoveryBody;
  try {
    body = (await req.json()) as RecoveryBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const orgId = String(body?.orgId || "").trim();
  if (!orgId) {
    return NextResponse.json(
      { ok: false, error: "missing_orgId", message: "orgId is required." },
      { status: 400 },
    );
  }

  // Auth + org-membership. Role gating is in the Cloud Function.
  try {
    await requireOrgAccess(req, orgId);
  } catch (e: unknown) {
    const status = e instanceof AuthError ? Number(e.status) : 401;
    return NextResponse.json(
      {
        ok: false,
        error: status === 403 ? "forbidden" : "unauthorized",
        message:
          status === 403
            ? "You don't have access to this organization."
            : "Sign in and try again.",
      },
      { status },
    );
  }

  // Rebuild the request with the validated body, then forward via the
  // shared functions proxy. We use the proxy directly (rather than the
  // generic /api/fn route) so the upstream function name is fixed
  // server-side — the client never gets to pick it.
  const forwardedHeaders = new Headers();
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (["host", "connection", "content-length"].includes(key)) return;
    forwardedHeaders.set(k, v);
  });
  forwardedHeaders.set("content-type", "application/json");

  const forwarded = new Request(req.url, {
    method: "POST",
    headers: forwardedHeaders,
    body: JSON.stringify(body),
  });

  return proxy(forwarded, "teamRecoveryV1");
}
