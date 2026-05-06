// PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
// Job → vendor assignment. Stores `vendorId` + `vendorName` on the
// job doc itself (denormalized name) so:
//   - Read paths (Review, Summary, audit/customer reports) can show
//     the vendor without a second collection lookup.
//   - Historical tasks keep the vendor's display name even after the
//     vendor is archived or its display name later changes — the
//     name is "frozen" at assignment time, matching how approver
//     labels are frozen on the export.
//
// Path used: incidents/{incidentId}/jobs/{jobId}. Same canonical
// path the export function reads from. Direct client-side write,
// gated by admin/supervisor role at the UI; production rules will
// enforce server-side.
import {
  doc,
  serverTimestamp,
  setDoc,
  type DocumentReference,
} from "firebase/firestore";
import { db } from "./firebaseClient";
import { loadVendors, type Vendor } from "./orgVendors";

export type JobVendor = {
  vendorId: string;
  vendorName: string;
};

// PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
// "Service provider" is the customer-facing word for the same
// concept. Reports use it; the admin UI keeps "Vendor" because
// that's the term in the data model and admin vocabulary.
export const NO_VENDOR_LABEL = "No vendor assigned";

function jobRef(incidentId: string, jobId: string): DocumentReference {
  return doc(db, "incidents", incidentId, "jobs", jobId);
}

// Active-only vendor list for the picker. Archived vendors are
// preserved as plain text on tasks they were already assigned to,
// but never appear as a selectable option.
export async function loadActiveVendorsForOrg(orgId: string): Promise<Vendor[]> {
  if (!orgId) return [];
  const all = await loadVendors(orgId);
  return all.filter((v) => v.status === "active");
}

// Assign or clear a vendor on a job. Pass `null` (or undefined) to
// clear the assignment. Both vendorId and vendorName are written —
// vendorName is the snapshot at assignment time, used by every
// downstream display surface.
export async function assignVendorToJob(
  incidentId: string,
  jobId: string,
  vendor: JobVendor | null,
): Promise<void> {
  if (!incidentId || !jobId) throw new Error("incidentId and jobId required");
  // setDoc + merge:true lets us write only the vendor fields without
  // disturbing the rest of the job doc (status, notes, approvals).
  await setDoc(
    jobRef(incidentId, jobId),
    vendor
      ? {
          vendorId: String(vendor.vendorId || "").trim(),
          vendorName: String(vendor.vendorName || "").trim(),
          updatedAt: serverTimestamp(),
        }
      : {
          // Explicit nulls — Firestore drops these fields cleanly so
          // the job doc reads as "unassigned" and downstream code
          // treats missing/empty/null identically.
          vendorId: null,
          vendorName: null,
          updatedAt: serverTimestamp(),
        },
    { merge: true },
  );
}
