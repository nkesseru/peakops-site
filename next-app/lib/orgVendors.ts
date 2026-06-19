// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
// Typed read/write for orgs/{orgId}/vendors/{vendorId}. The
// /settings/vendors page is the only consumer today. Security rules
// gate writes to admin members of the org; reads to any
// authenticated member of the org.
//
// Lifecycle: "active" | "archived". Replaces the v1 "active" |
// "inactive" pair — same intent (show the row but mark it
// non-selectable) plus audit metadata (archivedAt, archivedBy) so
// historical references can resolve to a vendor card without losing
// who pulled the trigger and when. Legacy "inactive" docs read as
// "archived" via the coercer below; no migration is required.
import {
  addDoc,
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type CollectionReference,
  type DocumentReference,
} from "firebase/firestore";
import { db } from "./firebaseClient";

export type VendorStatus = "active" | "archived";

// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Onboarding lifecycle stub. Captured on the doc but not yet wired
// to any flow — the UI displays a small "Onboarding: …" badge so
// the field becomes visible to operators without committing to a
// full email/onboarding workflow yet. Default "not_started" on all
// new and legacy docs.
export type OnboardingStatus = "not_started" | "requested" | "complete";

export const ONBOARDING_STATUSES: OnboardingStatus[] = ["not_started", "requested", "complete"];

export function isOnboardingStatus(v: unknown): v is OnboardingStatus {
  return v === "not_started" || v === "requested" || v === "complete";
}

export function prettyOnboardingStatus(s: OnboardingStatus): string {
  if (s === "requested") return "Requested";
  if (s === "complete") return "Complete";
  return "Not started";
}

export type Vendor = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  status: VendorStatus;
  createdAt?: any;
  updatedAt?: any;
  archivedAt?: any;
  archivedBy?: string;
  archiveReason?: string;
  onboardingStatus: OnboardingStatus;
};

export const VENDOR_STATUSES: VendorStatus[] = ["active", "archived"];

export function isVendorStatus(v: unknown): v is VendorStatus {
  return v === "active" || v === "archived";
}

export function prettyVendorStatus(status: VendorStatus): string {
  return status === "active" ? "Active" : "Archived";
}

// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
// Validators are exported so the UI can pre-flight inputs without
// duplicating the rules. Email is optional — only validated when
// non-empty. Same shape regex used in the team-invite modal.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidVendorEmail(raw: string): boolean {
  const v = String(raw || "").trim();
  if (!v) return true; // optional
  return EMAIL_RE.test(v);
}
export function isValidVendorName(raw: string): boolean {
  return String(raw || "").trim().length > 0;
}

// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
// VendorInput intentionally drops `status`. Status is set by lifecycle
// operations (addVendor → "active"; archiveVendor → "archived"),
// never by user-provided form data. This avoids "Save changes"
// silently re-activating an archived vendor, and keeps the modal
// schema focused on the editable contact details.
export type VendorInput = {
  name: string;
  contactName: string;
  email: string;
  phone: string;
};

function vendorsCol(orgId: string): CollectionReference {
  return collection(db, "orgs", orgId, "vendors");
}

function vendorRef(orgId: string, vendorId: string): DocumentReference {
  return doc(db, "orgs", orgId, "vendors", vendorId);
}

function coerceStatus(raw: any): VendorStatus {
  if (raw === "active") return "active";
  if (raw === "archived") return "archived";
  // PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
  // Legacy v1 docs wrote status: "inactive". Map to "archived" on
  // read so old data renders correctly without a backfill.
  if (raw === "inactive") return "archived";
  return "active";
}

function coerceVendor(id: string, raw: any): Vendor | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    contactName: typeof raw.contactName === "string" ? raw.contactName : "",
    email: typeof raw.email === "string" ? raw.email : "",
    phone: typeof raw.phone === "string" ? raw.phone : "",
    status: coerceStatus(raw.status),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    archivedAt: raw.archivedAt || null,
    archivedBy: typeof raw.archivedBy === "string" ? raw.archivedBy : undefined,
    archiveReason: typeof raw.archiveReason === "string" ? raw.archiveReason : undefined,
    // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
    // Default to "not_started" so older docs (created before this
    // field existed) render with a sensible badge instead of empty.
    onboardingStatus: isOnboardingStatus(raw.onboardingStatus) ? raw.onboardingStatus : "not_started",
  };
}

// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Dedup by name OR email (case-insensitive). Caller passes the
// edited vendor's id as `excludeId` so editing your own row doesn't
// trigger a self-match. Returns the first conflict found — caller
// decides whether to surface a "duplicate" or "archived — reactivate"
// toast based on the matched vendor's status.
export function normalizeVendorName(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}
export function findDuplicateVendor(
  vendors: Vendor[],
  opts: { name: string; email: string; excludeId?: string },
): Vendor | null {
  const targetName = normalizeVendorName(opts.name);
  const targetEmail = String(opts.email || "").trim().toLowerCase();
  for (const v of vendors) {
    if (opts.excludeId && v.id === opts.excludeId) continue;
    const vName = normalizeVendorName(v.name);
    const vEmail = String(v.email || "").trim().toLowerCase();
    if (targetName && vName && vName === targetName) return v;
    if (targetEmail && vEmail && vEmail === targetEmail) return v;
  }
  return null;
}

function sanitizeInput(raw: VendorInput): VendorInput {
  return {
    name: String(raw.name || "").trim(),
    contactName: String(raw.contactName || "").trim(),
    email: String(raw.email || "").trim().toLowerCase(),
    phone: String(raw.phone || "").trim(),
  };
}

export async function loadVendors(orgId: string): Promise<Vendor[]> {
  if (!orgId) return [];
  const snap = await getDocs(vendorsCol(orgId));
  const out: Vendor[] = [];
  snap.forEach((d) => {
    const v = coerceVendor(d.id, d.data());
    if (v) out.push(v);
  });
  // PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
  // Sort: active first, archived after, then alphabetical by name.
  // The UI partitions on status and renders archived in a separate
  // collapsible section; the sort keeps each partition stable.
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return out;
}

export async function addVendor(
  orgId: string,
  input: VendorInput,
): Promise<string> {
  if (!orgId) throw new Error("orgId required");
  const safe = sanitizeInput(input);
  if (!isValidVendorName(safe.name)) throw new Error("name required");
  if (!isValidVendorEmail(safe.email)) throw new Error("invalid email");
  // PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
  // New vendors always start active. Status is not user-editable.
  // PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
  // onboardingStatus seeded as "not_started"; the UI shows a small
  // badge so this field is observable. Future onboarding workflow
  // will flip it to "requested" / "complete".
  const ref = await addDoc(vendorsCol(orgId), {
    ...safe,
    status: "active" as VendorStatus,
    onboardingStatus: "not_started" as OnboardingStatus,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateVendor(
  orgId: string,
  vendorId: string,
  input: VendorInput,
): Promise<void> {
  if (!orgId || !vendorId) throw new Error("orgId and vendorId required");
  const safe = sanitizeInput(input);
  if (!isValidVendorName(safe.name)) throw new Error("name required");
  if (!isValidVendorEmail(safe.email)) throw new Error("invalid email");
  // PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04)
  // updateVendor never touches status. An archived vendor stays
  // archived after a contact-detail edit; reactivation is its own
  // explicit operation (not yet exposed in v1 — by design).
  await setDoc(
    vendorRef(orgId, vendorId),
    { ...safe, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

// PEAKOPS_MC_FILTERS_V1_1 (2026-05-04)
// Vendor slug helpers for URL-friendly filter params. Mission Control
// writes ?vendor=<slug> instead of ?vendor=<vendorId> so a shared
// link reads as `?vendor=summit-fiber-inc`, not `?vendor=MiQzsy…`.
//
// Slug rules:
//   - Lowercase the name, replace whitespace with `-`.
//   - Strip everything that isn't [a-z0-9-].
//   - Collapse runs of `-` and trim leading/trailing `-`.
//   - Cap at 60 chars so a wildly long company name doesn't bloat
//     the URL.
//   - Fall back to "vendor" when the name yields an empty slug.
//
// Duplicate handling: when two vendors normalize to the same slug,
// the second (and subsequent) get a short, stable suffix derived
// from the first 4 chars of the doc id (`-mi3z`). Stable means the
// same vendor always gets the same suffix as long as the colliding
// peer set doesn't change.
export function vendorSlug(name: string): string {
  let s = String(name || "").toLowerCase().trim();
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^a-z0-9-]+/g, "");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  s = s.slice(0, 60);
  return s || "vendor";
}

// Build slug → vendor and id → slug maps in one pass. Handles
// collisions: the FIRST vendor with a given slug keeps the bare
// slug; subsequent collisions get a `-<idPrefix>` suffix to keep
// them addressable. Sorting by id makes the "first" stable across
// page loads — important so a shared link stays valid even if the
// load order changes.
export function buildVendorSlugMap(vendors: Vendor[]): {
  slugToId: Map<string, string>;
  idToSlug: Map<string, string>;
} {
  const slugToId = new Map<string, string>();
  const idToSlug = new Map<string, string>();
  // PEAKOPS_MC_FILTERS_V1_2 (2026-05-04)
  // Track collisions so we can dev-warn once per build call. Two
  // vendors with the same base slug isn't broken (the suffixing
  // below keeps them addressable), but operators may want to
  // disambiguate by renaming. Production stays silent.
  const collisions: Array<{ base: string; ids: string[]; names: string[] }> = [];
  // Sort defensively so collision tie-breaking is deterministic.
  const sorted = [...vendors].sort((a, b) => a.id.localeCompare(b.id));
  for (const v of sorted) {
    const base = vendorSlug(v.name);
    let chosen = base;
    if (slugToId.has(chosen)) {
      // Record the collision against the vendor that already owns
      // the bare slug.
      const firstOwnerId = slugToId.get(chosen) || "";
      const firstOwner = vendors.find((x) => x.id === firstOwnerId);
      const existing = collisions.find((c) => c.base === base);
      if (existing) {
        existing.ids.push(v.id);
        existing.names.push(v.name);
      } else {
        collisions.push({
          base,
          ids: [firstOwnerId, v.id],
          names: [String(firstOwner?.name || ""), v.name],
        });
      }
      // Suffix with id prefix. Almost always unique; if even THAT
      // collides (vanishingly rare), fall back to the full id.
      const suffix = String(v.id || "").slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "") || "x";
      chosen = `${base}-${suffix}`;
      if (slugToId.has(chosen)) chosen = `${base}-${String(v.id).toLowerCase()}`;
    }
    slugToId.set(chosen, v.id);
    idToSlug.set(v.id, chosen);
  }
  if (collisions.length > 0 && process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[buildVendorSlugMap] vendor slug collisions detected; bare slug went to the first id, peers got suffixed.",
      collisions,
    );
  }
  return { slugToId, idToSlug };
}

// Resolve a `?vendor=` URL param to a Vendor. First treats the
// param as a slug; if no match, falls through to treating it as a
// raw vendorId for backward compat with pre-v1.1 URLs that contained
// the doc id directly. Returns null when neither lookup hits.
export function resolveVendorByParam(
  vendors: Vendor[],
  param: string,
): Vendor | null {
  const target = String(param || "").trim();
  if (!target) return null;
  const { slugToId } = buildVendorSlugMap(vendors);
  const idFromSlug = slugToId.get(target.toLowerCase());
  if (idFromSlug) {
    const m = vendors.find((v) => v.id === idFromSlug);
    if (m) return m;
  }
  // Backward-compat fallback: treat the param as a vendorId.
  const direct = vendors.find((v) => v.id === target);
  return direct || null;
}

// PEAKOPS_VENDOR_SETTINGS_V2 (2026-05-04) /
// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Soft archive: sets status:"archived" + audit metadata. The doc is
// never deleted — historical incident records that reference this
// vendorId continue to resolve to the original card, just marked
// archived in the UI. Mirrors the team-archive pattern. v1.1 adds
// optional archiveReason captured by the confirm modal.
export type VendorArchivePayload = {
  archivedBy: string;
  archiveReason?: string;
};

export async function archiveVendor(
  orgId: string,
  vendorId: string,
  payload: VendorArchivePayload,
): Promise<void> {
  if (!orgId || !vendorId) throw new Error("orgId and vendorId required");
  await setDoc(
    vendorRef(orgId, vendorId),
    {
      status: "archived" as VendorStatus,
      archivedAt: serverTimestamp(),
      archivedBy: String(payload.archivedBy || "").trim(),
      archiveReason: String(payload.archiveReason || "").trim(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

// PEAKOPS_VENDOR_SETTINGS_V1_1 (2026-05-04)
// Reactivate restores status: "active" and clears the archive audit
// fields. Mirrors the team reactivate helper. Vendor lifecycle is
// simpler than member lifecycle (no "invited" intermediate), so
// there's no preArchiveStatus to thread — restore is unconditional.
export async function reactivateVendor(
  orgId: string,
  vendorId: string,
): Promise<void> {
  if (!orgId || !vendorId) throw new Error("orgId and vendorId required");
  await updateDoc(vendorRef(orgId, vendorId), {
    status: "active" as VendorStatus,
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    updatedAt: serverTimestamp(),
  });
}
