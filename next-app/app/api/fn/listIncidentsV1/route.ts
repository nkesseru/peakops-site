import { enforceOrgAndProxy } from "../_orgProxy";

export const runtime = "nodejs";

// PEAKOPS_LIST_INCIDENTS_ROUTE_V1 (2026-04-29)
// Dedicated route file mirroring getIncidentV1 / closeIncidentV1.
// Functionally equivalent to the catch-all `[name]` route but
// explicit — eliminates any dynamic-segment ambiguity that could
// route differently between dev and production. Goes through the
// same enforceOrgAndProxy that:
//   - verifies the Firebase ID token (Authorization: Bearer <token>),
//   - confirms orgId is present in the user's verified orgIds claim,
//   - strips client-provided actorUid / actorRole,
//   - re-injects server-derived identity via x-peakops-* headers,
//   - forwards to the upstream Cloud Function.
//
// The Mission Control dashboard fires GET /api/fn/listIncidentsV1?
// orgId=<org>&limit=<n> via authedFetch — the bearer token is
// attached by lib/apiClient.ts. The frontend never sends actorUid.

export async function GET(req: Request) {
  return enforceOrgAndProxy(req, "listIncidentsV1");
}

export async function POST(req: Request) {
  return enforceOrgAndProxy(req, "listIncidentsV1");
}
