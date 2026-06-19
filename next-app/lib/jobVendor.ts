// PEAKOPS_VENDOR_ASSIGNMENT_V2 (2026-05-06)
// Phase 1 Slice 9: vendor assignment now goes through the
// assignVendorToJobV1 callable (functions_clean/assignVendorToJobV1).
// The previous version performed a direct client setDoc on
// incidents/{incidentId}/jobs/{jobId} with merge:true; the Slice 8
// firestore.rules pass allowed that write narrowly under a
// supervisor/admin gate with an affectedKeys() restriction. Slice 9
// drops that allowance — every lifecycle write now routes through
// _authz.js.
//
// Path used: incidents/{incidentId}/jobs/{jobId} (unchanged on the
// server; only the actor changes — server-side via Admin SDK).
//
// Why preserve a thin client wrapper instead of inlining the fetch
// at the call site: the call site (IncidentClient's VendorPicker
// onChange) wants a stable typed function. Keeping a wrapper here
// also keeps error-shape conversion in one place (the function maps
// non-200 responses to a thrown Error with `code` so the picker's
// catch block can react to "vendor_archived", "vendor_not_found",
// etc. distinctly from a generic failure).
//
// Function signature change vs. v1: orgId is now required as the
// first parameter. There's only one call site (IncidentClient.tsx)
// and orgId is already in scope there; passing it through is a
// small wiring change with no UX implication.

import { loadVendors, type Vendor } from "./orgVendors";
import { authedFetch } from "./apiClient";

export type JobVendor = {
  vendorId: string;
  vendorName: string;
};

// "Service provider" is the customer-facing word for the same
// concept. Reports use it; the admin UI keeps "Vendor" because
// that's the term in the data model and admin vocabulary.
export const NO_VENDOR_LABEL = "No vendor assigned";

// Active-only vendor list for the picker. Archived vendors are
// preserved as plain text on tasks they were already assigned to,
// but never appear as a selectable option.
export async function loadActiveVendorsForOrg(orgId: string): Promise<Vendor[]> {
  if (!orgId) return [];
  const all = await loadVendors(orgId);
  return all.filter((v) => v.status === "active");
}

export class AssignVendorError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Assign or clear a vendor on a job. Pass `null` (or undefined) to
 * clear the assignment. The server resolves the canonical
 * vendorName from the vendor doc (orgs/{orgId}/vendors/{vendorId})
 * — body.vendorName is a hint only.
 */
export async function assignVendorToJob(
  orgId: string,
  incidentId: string,
  jobId: string,
  vendor: JobVendor | null,
): Promise<void> {
  if (!orgId) throw new AssignVendorError("orgId required", "invalid-argument", 400);
  if (!incidentId) throw new AssignVendorError("incidentId required", "invalid-argument", 400);
  if (!jobId) throw new AssignVendorError("jobId required", "invalid-argument", 400);

  // PEAKOPS_SLICE12_AUTHED_FETCH_MIGRATE_V1 (2026-05-06)
  // Replaces the previous raw `fetch` + body-supplied actorUid with
  // authedFetch, which attaches `Authorization: Bearer <Firebase
  // ID token>` and lets the proxy at /api/fn/[name] derive actor
  // identity from the verified token (enforceOrgAndProxy strips
  // any client-supplied actorUid and re-injects the verified one).
  const body = {
    orgId,
    incidentId,
    jobId,
    vendorId: vendor?.vendorId ?? null,
    vendorName: vendor?.vendorName ?? null,
  };

  let res: Response;
  try {
    res = await authedFetch("/api/fn/assignVendorToJobV1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirectOnUnauth: false,
    });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    throw new AssignVendorError(`network: ${msg}`, "unavailable", 0);
  }

  if (res.ok) return;

  // Map server error codes onto an Error the call site can branch
  // on without sniffing strings.
  let payload: { ok?: boolean; error?: string } = {};
  try {
    payload = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON; leave payload empty */
  }
  const code = String(payload?.error || "").trim() || `http_${res.status}`;
  throw new AssignVendorError(
    payload?.error ? `assignVendorToJob: ${payload.error}` : `assignVendorToJob failed (${res.status})`,
    code,
    res.status,
  );
}
