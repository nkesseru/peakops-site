// PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
// Typed read/write for orgs/{orgId}/members/{memberId}. The
// /settings/team page is the only consumer today. Security rules
// gate writes to admin members of the org; reads to any authenticated
// member of the org.
import {
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

// PEAKOPS_TEAM_OWNER_ROLE_V1 (2026-05-07)
// Slice 17 internal-alpha smoke caught Nick (role: "owner" set by
// bootstrapPilotOrgV1) rendering as "FIELD CREW" on the team page,
// because every helper in this file was admin/supervisor/field-only.
// Adding "owner" + "viewer" widens the type but keeps the
// user-assignable subset (ORG_ROLES) at admin/supervisor/field —
// owner is a bootstrap-only role; viewer is read-only.
export type OrgRole = "owner" | "admin" | "supervisor" | "field" | "viewer";

// PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
// Lifecycle status. "active" = real signed-up member, "invited" =
// placeholder doc waiting for the invitee to sign up, "archived" =
// admin removed them from the active roster (historical records
// stay intact). Replaces the older boolean `invited` flag — that
// flag is still read for backward compat on existing docs but new
// writes use `status`.
export type MemberStatus = "active" | "invited" | "archived";

export const MEMBER_STATUSES: MemberStatus[] = ["active", "invited", "archived"];

export function isMemberStatus(v: unknown): v is MemberStatus {
  return v === "active" || v === "invited" || v === "archived";
}

export type OrgMember = {
  id: string;            // Firestore doc id (uid for real users, "pending_<...>" for invites)
  displayName: string;
  email: string;
  role: OrgRole;
  status: MemberStatus;
  invited?: boolean;     // legacy — kept for backward compat with pre-V2 docs
  archivedAt?: any;
  archivedBy?: string;
  archiveReason?: string;
  // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
  // Snapshot of the member's status the moment archive was applied.
  // Used by reactivate to restore the right status — specifically so
  // an invited-then-archived member comes back as "invited", not
  // forced to "active". Cleared on reactivate.
  preArchiveStatus?: MemberStatus;
  createdAt?: any;
  updatedAt?: any;
};

// User-assignable subset shown in role-edit dropdowns. Owner is
// deliberately excluded — it's set only by bootstrapPilotOrgV1.
// Viewer is excluded for now until we expose viewer-invite UX.
export const ORG_ROLES: OrgRole[] = ["admin", "supervisor", "field"];

// Display sort: owner first (executive), admin next, then supervisor,
// then field crew (most numerous), then viewer (read-only observers).
const ROLE_RANK: Record<OrgRole, number> = {
  owner: 0,
  admin: 1,
  supervisor: 2,
  field: 3,
  viewer: 4,
};

export function isOrgRole(v: unknown): v is OrgRole {
  return (
    v === "owner" ||
    v === "admin" ||
    v === "supervisor" ||
    v === "field" ||
    v === "viewer"
  );
}

export function prettyRoleLabel(role: OrgRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "supervisor") return "Supervisor";
  if (role === "viewer") return "Viewer";
  return "Field crew";
}

function membersCol(orgId: string): CollectionReference {
  return collection(db, "orgs", orgId, "members");
}

function memberRef(orgId: string, memberId: string): DocumentReference {
  return doc(db, "orgs", orgId, "members", memberId);
}

// PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
// Status resolution priority on read:
//   1) explicit status field (V2+ writes)
//   2) legacy invited:true → "invited"
//   3) presence of archivedAt → "archived" (defensive: a
//      half-written doc that lost its status)
//   4) "active" — the safe default
// Lets the new UI render correctly over a mix of legacy and current
// docs without a one-off backfill migration.
function coerceMemberStatus(raw: any): MemberStatus {
  if (isMemberStatus(raw?.status)) return raw.status;
  if (raw?.invited === true) return "invited";
  if (raw?.archivedAt) return "archived";
  return "active";
}

function coerceMember(id: string, raw: any): OrgMember | null {
  if (!raw || typeof raw !== "object") return null;
  const role = isOrgRole(raw.role) ? raw.role : "field";
  return {
    id,
    displayName: typeof raw.displayName === "string" ? raw.displayName : "",
    email: typeof raw.email === "string" ? raw.email : "",
    role,
    status: coerceMemberStatus(raw),
    invited: raw.invited === true ? true : undefined,
    archivedAt: raw.archivedAt || null,
    archivedBy: typeof raw.archivedBy === "string" ? raw.archivedBy : undefined,
    archiveReason: typeof raw.archiveReason === "string" ? raw.archiveReason : undefined,
    // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
    // Coerce to a valid status or drop. "archived" is intentionally
    // not allowed as a preArchiveStatus — it would create an
    // unresolvable restore loop.
    preArchiveStatus: isMemberStatus(raw.preArchiveStatus) && raw.preArchiveStatus !== "archived"
      ? raw.preArchiveStatus
      : undefined,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

export async function loadOrgMembers(orgId: string): Promise<OrgMember[]> {
  if (!orgId) return [];
  const snap = await getDocs(membersCol(orgId));
  const out: OrgMember[] = [];
  snap.forEach((d) => {
    const m = coerceMember(d.id, d.data());
    if (m) out.push(m);
  });
  // PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
  // Sort: admin first, then supervisor, then field — within each
  // tier, alphabetical by displayName (falling back to email so
  // pending invites without a name still group sensibly).
  out.sort((a, b) => {
    const r = ROLE_RANK[a.role] - ROLE_RANK[b.role];
    if (r !== 0) return r;
    const aKey = (a.displayName || a.email || "").toLowerCase();
    const bKey = (b.displayName || b.email || "").toLowerCase();
    return aKey.localeCompare(bKey);
  });
  return out;
}

export async function updateMemberRole(
  orgId: string,
  memberId: string,
  role: OrgRole,
): Promise<void> {
  if (!orgId || !memberId) throw new Error("orgId and memberId required");
  if (!isOrgRole(role)) throw new Error("invalid role");
  await updateDoc(memberRef(orgId, memberId), {
    role,
    updatedAt: serverTimestamp(),
  });
}

// PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
// Normalize once at every comparison boundary so we don't depend on
// any single writer doing the trim/lowercase. The on-disk shape is
// already lowercased by sanitizeInput, but defensive normalization
// here means a hand-edited doc or legacy data (mixed case, trailing
// whitespace) doesn't slip past the dedup check.
export function normalizeEmail(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

// Find an existing member (real or pending invite) whose email
// matches the given input. Used by the invite flow to block
// duplicates BEFORE the Firestore write happens.
export function findMemberByEmail(
  members: OrgMember[],
  email: string,
): OrgMember | null {
  const target = normalizeEmail(email);
  if (!target) return null;
  return members.find((m) => normalizeEmail(m.email) === target) || null;
}

// Group members by normalized email and return the duplicate sets.
// Dev-only diagnostic — surfaces existing data corruption (e.g.,
// from earlier turns that shipped without dedup) so an operator can
// clean it up manually. Never auto-deletes.
export function findDuplicateEmails(
  members: OrgMember[],
): { email: string; ids: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const m of members) {
    const e = normalizeEmail(m.email);
    if (!e) continue;
    if (!buckets.has(e)) buckets.set(e, []);
    buckets.get(e)!.push(m.id);
  }
  const out: { email: string; ids: string[] }[] = [];
  for (const [email, ids] of buckets) {
    if (ids.length > 1) out.push({ email, ids });
  }
  return out;
}

export type InvitePayload = {
  displayName: string;
  email: string;
  role: OrgRole;
};

export async function inviteOrgMember(
  orgId: string,
  payload: InvitePayload,
): Promise<string> {
  if (!orgId) throw new Error("orgId required");
  const displayName = String(payload.displayName || "").trim();
  const email = String(payload.email || "").trim().toLowerCase();
  const role = isOrgRole(payload.role) ? payload.role : "field";

  // PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
  // Generate a "pending" placeholder id so the doc is distinguishable
  // from a real-user member doc (whose id is the Firebase Auth uid).
  // When the invitee actually signs up, an admin tool can merge the
  // placeholder into the real-uid doc — out of scope for v1.
  const pendingId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await setDoc(memberRef(orgId, pendingId), {
    displayName,
    email,
    role,
    // PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
    // New writes use `status` as the canonical lifecycle field. The
    // legacy `invited: true` flag is also written so older readers
    // (if any still exist) keep working until they're upgraded.
    status: "invited" as MemberStatus,
    invited: true,
    createdAt: serverTimestamp(),
  });
  return pendingId;
}

// PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
// Pre-mutation check: an admin cannot remove their own admin role
// (would orphan the org with no admin if they're the last one).
// Enforced at the UI by disabling the dropdown for the current
// user's row; this helper is the same check the rule logic and
// any future server-side safety net would use.
export function canEditMemberRole(
  currentUid: string,
  currentRole: string,
  member: OrgMember,
): boolean {
  // PEAKOPS_TEAM_OWNER_ROLE_V1 (2026-05-07)
  // Owner role inherits admin-equivalent member-management privilege.
  // Mirrors firestore.rules:isOwnerOrAdmin and the same predicate
  // pattern used by SettingsVendorsClient. Viewer / field /
  // supervisor remain read-only — unchanged.
  const cr = String(currentRole || "").toLowerCase();
  if (cr !== "admin" && cr !== "owner") return false; // non-privileged can't change anyone
  if (member.id === currentUid) return false;         // can't change your own role
  // PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
  if (member.status === "archived") return false;     // archived members are read-only
  // PEAKOPS_TEAM_OWNER_ROLE_V1 (2026-05-07)
  // Don't let a non-owner admin change an owner's role. The
  // user-assignable role list (ORG_ROLES) excludes "owner" anyway,
  // so a successful role-change against an owner row would silently
  // demote them. Refusing here makes that path explicit.
  if (member.role === "owner" && cr !== "owner") return false;
  return true;
}

// PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
// Auto-seed the signed-in user's member doc when it's missing —
// stops the Team page from silently rendering an empty list for a
// real org member. Only writes when the doc doesn't already exist;
// existing docs are left untouched (so an existing role can never
// be downgraded by a re-visit). The role written matches the user's
// custom claim (admin / supervisor / field), which the Firestore
// rule will validate to prevent self-promotion.
export type SeedProfile = {
  displayName: string;
  email: string;
  claimRole: string; // raw claim string; coerced to a valid OrgRole here
};

function roleFromClaim(claimRole: string): OrgRole {
  const r = String(claimRole || "").toLowerCase();
  if (isOrgRole(r)) return r;
  return "field"; // safe default — never elevates above field via seed
}

export async function seedCurrentUserMember(
  orgId: string,
  uid: string,
  profile: SeedProfile,
): Promise<void> {
  if (!orgId || !uid) throw new Error("orgId and uid required");
  // setDoc with merge:true means concurrent writes from a different
  // path (e.g. an admin invite that lands first) keep their data —
  // we only fill in fields that aren't already set.
  await setDoc(
    memberRef(orgId, uid),
    {
      displayName: String(profile.displayName || "").trim(),
      email: normalizeEmail(profile.email),
      role: roleFromClaim(profile.claimRole),
      // PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
      status: "active" as MemberStatus,
      createdAt: serverTimestamp(),
    },
    { merge: true },
  );
}

// PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
// Soft-remove a member. Sets status: "archived" + audit metadata.
// The Firestore rule keeps update admin-only, so the rule layer
// already prevents non-admins from calling this. The "can't archive
// the last admin" and "can't archive yourself" guards live in the
// caller (UI) — they need access to the loaded list to make the
// decision and are deliberately UI-side for v1.
export type ArchivePayload = {
  archivedBy: string;        // uid of the admin doing the archiving
  archiveReason?: string;    // optional, free-form
  // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
  // Snapshot of the member's lifecycle status BEFORE archive (the
  // value the caller saw in the loaded list). Persisted as
  // `preArchiveStatus` so reactivate can restore it. The caller's
  // in-memory member is the source of truth here — passing it in
  // keeps the helper from needing an extra read round-trip.
  preArchiveStatus: MemberStatus;
};

export async function archiveMember(
  orgId: string,
  memberId: string,
  payload: ArchivePayload,
): Promise<void> {
  if (!orgId || !memberId) throw new Error("orgId and memberId required");
  // Defensive: never persist "archived" as the pre-archive status
  // (that would orphan the restore). Fall back to "active" — the
  // safe default that matches Reactivate's own fallback.
  const preStatus: MemberStatus =
    payload.preArchiveStatus === "active" || payload.preArchiveStatus === "invited"
      ? payload.preArchiveStatus
      : "active";
  await setDoc(
    memberRef(orgId, memberId),
    {
      status: "archived" as MemberStatus,
      archivedAt: serverTimestamp(),
      archivedBy: String(payload.archivedBy || "").trim(),
      archiveReason: String(payload.archiveReason || "").trim(),
      preArchiveStatus: preStatus,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

// PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
// Reactivate restores the pre-archive status. Caller passes the
// snapshot value (read from the in-memory member doc); helper falls
// back to "active" if the snapshot is missing or invalid. Clears
// every archive audit field on the way out so the row reads as a
// normal active/invited member.
export type ReactivateOptions = {
  preArchiveStatus?: MemberStatus;
};

export async function reactivateMember(
  orgId: string,
  memberId: string,
  opts: ReactivateOptions = {},
): Promise<void> {
  if (!orgId || !memberId) throw new Error("orgId and memberId required");
  const candidate = opts.preArchiveStatus;
  const restoreStatus: MemberStatus =
    candidate === "active" || candidate === "invited" ? candidate : "active";
  await updateDoc(memberRef(orgId, memberId), {
    status: restoreStatus,
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    preArchiveStatus: null,
    updatedAt: serverTimestamp(),
  });
}

// Last-active-admin guard. Returns true when archiving the given
// member would leave the org with zero active admins. The UI uses
// this to short-circuit the archive flow with a specific toast
// instead of letting the write succeed and orphaning the org.
export function isLastActiveAdmin(
  members: OrgMember[],
  memberId: string,
): boolean {
  const target = members.find((m) => m.id === memberId);
  if (!target || target.role !== "admin" || target.status === "archived") return false;
  const otherActiveAdmins = members.filter(
    (m) => m.role === "admin" && m.status !== "archived" && m.id !== memberId,
  );
  return otherActiveAdmins.length === 0;
}
