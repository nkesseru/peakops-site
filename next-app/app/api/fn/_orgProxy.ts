import { NextResponse } from "next/server";
import { proxy } from "./_proxy";
import { requireOrgAccess } from "../../../lib/verifyAuth";

// PEAKOPS_PROXY_TOKEN_ONLY_ALLOWLIST_V1 (Chunk 2 verification hotfix, 2026-06-22)
//
// A small allowlist of upstream Cloud Functions that take a single-use
// token as their credential and intentionally run WITHOUT a Bearer
// header. The customer-facing review flow is the canonical example —
// a customer opens /review/{token} in a browser with no login and the
// page calls these endpoints unauthenticated.
//
// Each allowlisted function MUST do its own token validation server-
// side (see _customerReviewToken.js + getCustomerReviewV1 /
// submitCustomerReviewV1 source). The proxy's only job for these
// routes is to forward the request without applying the Bearer-token
// gate. actorUid / actorRole are still stripped from inbound query +
// body so a client can't smuggle identity in via the request.
//
// Without this list, /api/fn/getCustomerReviewV1 returns
// 401 "Missing Authorization header" before the upstream function
// ever sees the token. Production customers saw "Couldn't load this
// packet — Missing Authorization header" on every review-link visit
// since PR #159 landed. Discovered during the post-deploy verification
// run for Chunks 1+2.
const UNAUTH_TOKEN_ROUTES = new Set<string>([
  "getCustomerReviewV1",
  "submitCustomerReviewV1",
]);

/**
 * Phase 3 enforcement gate for every /api/fn/* route. Pulls orgId out of
 * the request (query first, then JSON body), verifies the bearer token
 * and org membership via requireOrgAccess, strips client-provided
 * actorUid / actorRole (we never trust those again), re-injects values
 * derived from the verified token, and forwards the request to the
 * upstream Cloud Function via the existing proxy() helper.
 *
 * Routes call this with a single line:
 *   return enforceOrgAndProxy(req, "addEvidenceV1");
 *
 * Upstream functions can read the trusted identity from either the body
 * (actorUid / actorRole) or the new advisory headers
 * (x-peakops-uid / x-peakops-email / x-peakops-org / x-peakops-role).
 */
export async function enforceOrgAndProxy(
  req: Request,
  functionName: string,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // Read the body once so we can both inspect it for orgId and rebuild
  // it with server-derived actor fields. GETs are query-only.
  let bodyText = "";
  let bodyObj: any = null;
  if (method !== "GET" && method !== "HEAD") {
    bodyText = await req.text().catch(() => "");
    if (bodyText) {
      try {
        bodyObj = JSON.parse(bodyText);
      } catch {
        bodyObj = null;
      }
    }
  }

  // PEAKOPS_PROXY_TOKEN_ONLY_ALLOWLIST_V1 — token-only unauth routes
  // bypass the Bearer-token / orgId-membership gate and forward
  // directly. They still get actorUid / actorRole stripped from the
  // outbound request body so clients can't smuggle identity in.
  if (UNAUTH_TOKEN_ROUTES.has(functionName)) {
    url.searchParams.delete("actorUid");
    url.searchParams.delete("actorRole");
    let outBody: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (bodyObj && typeof bodyObj === "object") {
        delete bodyObj.actorUid;
        delete bodyObj.actorRole;
        outBody = JSON.stringify(bodyObj);
      } else {
        outBody = bodyText;
      }
    }
    const outHeadersUnauth = new Headers(req.headers);
    // Strip the trusted identity advisory headers — they should not
    // be present for unauth routes (token IS the identity).
    outHeadersUnauth.delete("x-peakops-uid");
    outHeadersUnauth.delete("x-peakops-email");
    outHeadersUnauth.delete("x-peakops-org");
    outHeadersUnauth.delete("x-peakops-role");
    if (outBody !== undefined && bodyObj && typeof bodyObj === "object") {
      outHeadersUnauth.set("content-type", "application/json");
      outHeadersUnauth.delete("content-length");
    }
    const initUnauth: RequestInit = { method, headers: outHeadersUnauth };
    if (outBody !== undefined) {
      (initUnauth as any).body = outBody;
    }
    const newReqUnauth = new Request(url.toString(), initUnauth);
    console.log(`[${functionName}] unauth-token-route`);
    return proxy(newReqUnauth, functionName);
  }

  // orgId precedence: query param wins; fall back to body.
  let requestedOrgId = String(url.searchParams.get("orgId") || "").trim();
  if (!requestedOrgId && bodyObj && typeof bodyObj === "object") {
    requestedOrgId = String(bodyObj.orgId || "").trim();
  }

  // Auth + org membership check.
  let authCtx;
  try {
    authCtx = await requireOrgAccess(req, requestedOrgId);
  } catch (e: any) {
    const status = Number(e?.status || 401);
    const message = String(e?.message || "unauthorized");
    return NextResponse.json({ ok: false, error: message }, { status });
  }

  console.log(`[${functionName}] org-authenticated`, {
    uid: authCtx.uid,
    email: authCtx.email,
    orgId: authCtx.orgId,
    role: authCtx.role,
  });

  // Strip client-provided actor identity from both query and body.
  url.searchParams.delete("actorUid");
  url.searchParams.delete("actorRole");

  let outBody: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (bodyObj && typeof bodyObj === "object") {
      bodyObj.actorUid = authCtx.uid;
      bodyObj.actorRole = authCtx.role || "";
      outBody = JSON.stringify(bodyObj);
    } else {
      // Non-JSON body (multipart, binary, empty). Pass through unchanged.
      outBody = bodyText;
    }
  }

  // Build the forwarded request. Preserve original headers, then
  // overlay the trusted identity advisory headers.
  const outHeaders = new Headers(req.headers);
  outHeaders.set("x-peakops-uid", authCtx.uid);
  outHeaders.set("x-peakops-email", authCtx.email);
  outHeaders.set("x-peakops-org", authCtx.orgId);
  outHeaders.set("x-peakops-role", authCtx.role || "");
  if (outBody !== undefined && bodyObj && typeof bodyObj === "object") {
    outHeaders.set("content-type", "application/json");
    outHeaders.delete("content-length"); // body length changed; let runtime recompute
  }

  const init: RequestInit = { method, headers: outHeaders };
  if (outBody !== undefined) {
    (init as any).body = outBody;
  }

  const newReq = new Request(url.toString(), init);
  return proxy(newReq, functionName);
}
