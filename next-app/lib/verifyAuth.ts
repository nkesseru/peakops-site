import type { DecodedIdToken } from "firebase-admin/auth";
import { adminAuth } from "./firebaseAdmin";

export type OrgAuthContext = {
  uid: string;
  email: string;
  orgIds: string[];
  role: string;
  orgId: string;
};

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function verifyAuthHeader(req: Request): Promise<DecodedIdToken> {
  const header = req.headers.get("authorization") || "";
  if (!header.trim()) {
    throw new AuthError("Missing Authorization header", 401);
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : "";
  if (!token) {
    throw new AuthError("Invalid token", 401);
  }

  try {
    return await adminAuth.verifyIdToken(token);
  } catch {
    throw new AuthError("Invalid token", 401);
  }
}

/**
 * Phase 3 enforcement: verify the bearer token AND check that the
 * verified user is allowed to act on the requested org.
 *
 * Failure semantics:
 *   - missing/invalid token → AuthError(401)
 *   - missing requestedOrgId → AuthError(400)
 *   - decoded.orgIds claim missing or not an array → AuthError(403)
 *   - requestedOrgId not in decoded.orgIds → AuthError(403)
 *
 * On success the returned context is the only trusted source of identity
 * for the request. Callers MUST stop trusting body/query actorUid /
 * actorRole and use these fields instead.
 */
export async function requireOrgAccess(
  req: Request,
  requestedOrgId: string,
): Promise<OrgAuthContext> {
  const decoded = await verifyAuthHeader(req); // 401 if bad/missing

  const orgId = String(requestedOrgId || "").trim();
  if (!orgId) {
    throw new AuthError("Missing orgId", 400);
  }

  // PEAKOPS_SLICE17C_LEGACY_ORGID_ACCEPT_V1 (2026-05-07)
  // Slice 12 introduced the orgIds (plural array) claim shape. Some
  // existing pilot accounts still carry the legacy orgId (singular
  // string) shape minted by the pre-Slice-17C setClaims.cjs. Accept
  // either: prefer the array, fall back to a single-element array
  // built from the string. The singular form is transitional —
  // Slice 17C's setClaims.cjs writes both fields so newly-minted
  // tokens always have orgIds populated. Returns OrgAuthContext with
  // orgIds as array regardless of which input shape was present, so
  // every downstream caller sees a single canonical shape.
  let orgIds: string[];
  const claimsOrgIds = (decoded as any).orgIds;
  const claimsLegacyOrgId = (decoded as any).orgId;
  if (Array.isArray(claimsOrgIds)) {
    orgIds = claimsOrgIds.map((v) => String(v));
  } else if (typeof claimsLegacyOrgId === "string" && claimsLegacyOrgId.trim()) {
    orgIds = [String(claimsLegacyOrgId).trim()];
  } else {
    throw new AuthError("Forbidden: missing orgIds claim", 403);
  }

  if (!orgIds.includes(orgId)) {
    throw new AuthError("Forbidden: orgId not allowed", 403);
  }

  return {
    uid: String(decoded.uid || ""),
    email: String(decoded.email || ""),
    orgIds,
    role: String((decoded as any).role || ""),
    orgId,
  };
}
