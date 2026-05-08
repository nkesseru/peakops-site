"use client";

// PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
// /settings/team — view and (for admins) manage members of the
// active org. Reads + writes go through orgs/{orgId}/members in
// Firestore. Permissions: any signed-in member can read; only
// admins can change roles or invite. Self-demote is disabled at
// the UI level (admins can't remove their own admin role).
//
// Active org resolution priority: URL ?orgId=… → localStorage
// (peakops_orgId) → first orgId in the auth claim. Same pattern
// as /settings.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import {
  ORG_ROLES,
  archiveMember,
  canEditMemberRole,
  findDuplicateEmails,
  findMemberByEmail,
  inviteOrgMember,
  isLastActiveAdmin,
  isOrgRole,
  loadOrgMembers,
  normalizeEmail,
  prettyRoleLabel,
  reactivateMember,
  seedCurrentUserMember,
  updateMemberRole,
  type InvitePayload,
  type OrgMember,
  type OrgRole,
} from "@/lib/orgMembers";

export default function SettingsTeamClient() {
  const sp = useSearchParams();
  const { user, loading: authLoading, claims } = useAuth();
  const uid = user?.uid || "";
  const myRole = String(claims.role || "").toLowerCase();

  // Active org (URL > localStorage > claim).
  const orgId = useMemo(() => {
    const fromQuery = String(sp?.get("orgId") || "").trim();
    let fromStorage = "";
    if (typeof window !== "undefined") {
      try {
        fromStorage = String(window.localStorage.getItem("peakops_orgId") || "").trim();
      } catch { /* ignore */ }
    }
    const fromClaims = (claims.orgIds[0] || "").trim();
    return fromQuery || fromStorage || fromClaims;
  }, [sp, claims.orgIds]);

  // PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
  // Cross-org access guard. The Firestore rule blocks reads when the
  // user's orgIds claim doesn't include the requested org, but the
  // page should fail closed BEFORE attempting the load — both for a
  // clearer error state and to avoid spurious "couldn't load the
  // team" toasts when the real cause is the user just doesn't
  // belong to this org. Admin authorization is downstream of this:
  // a user must be a member of the org first, and additionally have
  // the admin claim, to invite or change roles.
  // PEAKOPS_TEAM_OWNER_ROLE_V1 (2026-05-07)
  // Owner inherits admin-equivalent member-management privilege —
  // matches the canEditMemberRole helper, the SettingsVendorsClient
  // gate, and firestore.rules:isOwnerOrAdmin. Variable name is kept
  // as `isAdmin` (used in 14+ sites incl. MemberRow + ArchivedRow
  // props) and now reads as "admin-equivalent privilege gate."
  // Viewer / field / supervisor remain read-only.
  const isMemberOfOrg = !!orgId && claims.orgIds.includes(orgId);
  const isAdmin = isMemberOfOrg && (myRole === "admin" || myRole === "owner");

  const backHref = orgId ? `/incidents?orgId=${encodeURIComponent(orgId)}` : "/incidents";
  const profileHref = orgId ? `/settings?orgId=${encodeURIComponent(orgId)}` : "/settings";
  const vendorsHref = orgId ? `/settings/vendors?orgId=${encodeURIComponent(orgId)}` : "/settings/vendors";

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingRoleChange, setPendingRoleChange] = useState<string>("");
  const [toastMsg, setToastMsg] = useState<string>("");
  // PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
  const [archivingMember, setArchivingMember] = useState<OrgMember | null>(null);
  const [pendingArchive, setPendingArchive] = useState<string>("");
  const [archivedSectionOpen, setArchivedSectionOpen] = useState(false);

  // Partition the loaded list once. The archive section toggles
  // visibility but the data is loaded together so reactivate doesn't
  // need a separate fetch.
  const activeMembers = members.filter((m) => m.status !== "archived");
  const archivedMembers = members.filter((m) => m.status === "archived");

  function toast(msg: string, ms = 2200) {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), ms);
  }

  async function refresh() {
    if (!orgId) {
      setMembers([]);
      setLoaded(true);
      return;
    }
    try {
      const list = await loadOrgMembers(orgId);
      setMembers(list);
      // PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
      // Dev-only duplicate-email warning. Surfaces existing data
      // corruption (legacy demo seeds, earlier turns that shipped
      // without dedup) without auto-deleting anything. Production
      // stays silent.
      if (process.env.NODE_ENV !== "production") {
        const dups = findDuplicateEmails(list);
        if (dups.length > 0) {
          // eslint-disable-next-line no-console
          console.warn("[team-load] duplicate emails detected", {
            orgId,
            duplicates: dups,
            note: "Auto-cleanup is intentionally disabled. Resolve manually.",
          });
        }
      }
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[team-load]", {
          path: `orgs/${orgId}/members`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't load the team. Please refresh and try again.", 3500);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!uid) { setLoaded(true); return; }
    if (!isMemberOfOrg) { setLoaded(true); return; }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, uid, orgId, isMemberOfOrg]);

  // PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
  // Auto-seed: if the loaded list doesn't include the current user
  // AND we have everything we need to write a member doc, write
  // one and refresh. Guarded by a ref so a quick re-render doesn't
  // schedule a second write. Existing docs are NEVER touched —
  // satisfies "do not downgrade existing role" by precondition.
  const [seedAttempted, setSeedAttempted] = useState(false);
  useEffect(() => {
    if (!loaded || !user || !uid || !orgId || !isMemberOfOrg) return;
    if (seedAttempted) return;
    const alreadyHasMemberDoc = members.some((m) => m.id === uid);
    if (alreadyHasMemberDoc) return;
    setSeedAttempted(true);
    (async () => {
      try {
        await seedCurrentUserMember(orgId, uid, {
          displayName: user.displayName || "",
          email: user.email || "",
          claimRole: myRole,
        });
        await refresh();
      } catch (e: any) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[team-self-seed]", {
            path: `orgs/${orgId}/members/${uid}`,
            code: e?.code || null,
            message: String(e?.message || e),
          });
        }
        // Don't toast — the user didn't ask for this, it's silent
        // best-effort. They'll still see the existing roster (or
        // an empty one), and an admin can fix things if needed.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, user, uid, orgId, isMemberOfOrg, members, seedAttempted]);

  async function handleRoleChange(member: OrgMember, nextRole: OrgRole) {
    if (!isAdmin) return;
    if (!canEditMemberRole(uid, myRole, member)) return;
    if (member.role === nextRole) return;
    setPendingRoleChange(member.id);
    try {
      await updateMemberRole(orgId, member.id, nextRole);
      toast(`${member.displayName || member.email || "Member"} is now ${prettyRoleLabel(nextRole)}.`);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[team-role-change]", {
          path: `orgs/${orgId}/members/${member.id}`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't change that role. Please try again.", 3500);
    } finally {
      setPendingRoleChange("");
    }
  }

  async function handleInvite(payload: InvitePayload) {
    if (!isAdmin) return;
    // PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
    // Pre-write dedup against the loaded list. Cheap (no extra
    // round-trip), catches the common "admin invites the same
    // email twice" case. Race with a concurrent admin invite is
    // possible but extremely rare and produces the worst case of
    // one duplicate row — surfaced by findDuplicateEmails on the
    // next load and warned about in dev.
    const normalized = normalizeEmail(payload.email);
    if (normalized) {
      const existing = findMemberByEmail(members, normalized);
      if (existing) {
        // PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
        // Archived match gets a more actionable message — admin can
        // reactivate that doc instead of inviting a duplicate.
        if (existing.status === "archived") {
          // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
          // Updated copy: more specific + actionable. Tells the
          // admin exactly which control to use instead of asking a
          // question.
          toast("This email belongs to an archived team member. Use Reactivate to bring them back.", 4500);
        } else {
          toast("A team member with this email already exists.", 3500);
        }
        return;
      }
    }
    try {
      await inviteOrgMember(orgId, payload);
      toast(`Invite sent to ${payload.email || "team member"}.`);
      setInviteOpen(false);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[team-invite]", {
          path: `orgs/${orgId}/members`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't send that invite. Please try again.", 3500);
    }
  }

  // PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
  // Archive guards run BEFORE the modal opens (the dropdown to reach
  // the modal is also hidden for self/last-admin, so this is a
  // defensive double-check). The modal's submit then writes through
  // archiveMember() with audit metadata.
  async function handleArchiveSubmit(reason: string) {
    if (!isAdmin || !archivingMember) return;
    if (archivingMember.id === uid) {
      toast("You can't archive yourself.", 3000);
      return;
    }
    if (isLastActiveAdmin(members, archivingMember.id)) {
      toast("Can't archive the last admin. Promote another member to admin first.", 4000);
      return;
    }
    setPendingArchive(archivingMember.id);
    try {
      await archiveMember(orgId, archivingMember.id, {
        archivedBy: uid,
        archiveReason: reason,
        // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
        // Snapshot the lifecycle status before archive so Reactivate
        // can restore it. An invited-then-archived row comes back as
        // "invited" — not forced to "active".
        preArchiveStatus: archivingMember.status,
      });
      toast("Team member archived.");
      setArchivingMember(null);
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[team-archive]", {
          path: `orgs/${orgId}/members/${archivingMember.id}`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't archive that member. Please try again.", 3500);
    } finally {
      setPendingArchive("");
    }
  }

  async function handleReactivate(member: OrgMember) {
    if (!isAdmin) return;
    const confirmed = typeof window !== "undefined"
      ? window.confirm(`Reactivate ${member.displayName || member.email || "this member"}?`)
      : false;
    if (!confirmed) return;
    setPendingArchive(member.id);
    try {
      // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
      // Restore the pre-archive status when present. Falls back to
      // "active" inside the helper if the snapshot is missing or
      // invalid (e.g. a doc archived before V1.1 shipped).
      await reactivateMember(orgId, member.id, {
        preArchiveStatus: member.preArchiveStatus,
      });
      toast("Team member reactivated.");
      await refresh();
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[team-reactivate]", {
          path: `orgs/${orgId}/members/${member.id}`,
          code: e?.code || null,
          message: String(e?.message || e),
        });
      }
      toast("We couldn't reactivate that member. Please try again.", 3500);
    } finally {
      setPendingArchive("");
    }
  }

  // ---- Gate states ---------------------------------------------------------

  if (authLoading || !loaded) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} vendorsHref={vendorsHref} active="team" />
        <div style={cardStyle}><div style={{ fontSize: 12, color: "#6f6f6f" }}>Loading…</div></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} vendorsHref={vendorsHref} active="team" />
        <div style={cardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#b3b3b3" }}>
            You need to be signed in to view your team.
          </p>
          <div style={{ marginTop: 12 }}>
            <Link href="/login" style={primaryBtnStyle(true)}>Go to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!orgId) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} vendorsHref={vendorsHref} active="team" />
        <div style={cardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#b3b3b3" }}>
            No organization selected. Open Mission Control once to set your active org, then come back.
          </p>
        </div>
      </div>
    );
  }

  // PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
  // Cross-org access denial. orgId is set but the current user's
  // claim doesn't include it — render an explicit "no access" state
  // instead of attempting the load (which the rule would reject)
  // and showing a generic toast.
  if (!isMemberOfOrg) {
    return (
      <div style={pageStyle}>
        <Header backHref={backHref} profileHref={profileHref} vendorsHref={vendorsHref} active="team" />
        <div style={cardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#b3b3b3" }}>
            You don't have access to this organization's team.
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "#6f6f6f" }}>
            If this looks wrong, ask an admin to add you to{" "}
            <span style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace" }}>{orgId}</span>.
          </p>
        </div>
      </div>
    );
  }

  // ---- Render --------------------------------------------------------------

  return (
    <div style={pageStyle}>
      <Header backHref={backHref} profileHref={profileHref} vendorsHref={vendorsHref} active="team" />

      <section style={cardStyle}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 12, gap: 12,
        }}>
          <div>
            <h2 style={sectionHeadingStyle}>Team members</h2>
            <div style={{ fontSize: 12, color: "#6f6f6f" }}>
              {activeMembers.length === 0
                ? "No members yet."
                : `${activeMembers.length} member${activeMembers.length === 1 ? "" : "s"}`}
            </div>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              style={primaryBtnStyle(true)}
            >
              Invite user
            </button>
          )}
        </div>

        {!isAdmin && (
          <div style={{
            marginBottom: 12, padding: "8px 10px",
            border: "1px solid #1c1c1c", borderRadius: 6,
            background: "#0b0b0b",
            fontSize: 11, color: "#6f6f6f",
          }}>
            View only — only admins can change roles or invite people.
          </div>
        )}

        {activeMembers.length === 0 ? (
          <div style={{ fontSize: 13, color: "#6f6f6f", padding: "12px 0" }}>
            No members in this org yet.
            {isAdmin ? " Click \"Invite user\" to add the first one." : ""}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {activeMembers.map((m) => {
              // PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
              // The Archive button now renders for every editable
              // row — but is disabled (with an explanatory tooltip)
              // when archiving would orphan the org. Previously the
              // button was hidden entirely for last-admin rows; the
              // disabled-with-tooltip pattern surfaces the constraint
              // to the admin without leaving them confused as to why
              // they don't see the control.
              const wouldOrphan = isLastActiveAdmin(members, m.id);
              const archivable =
                isAdmin &&
                m.id !== uid &&
                m.status !== "archived" &&
                !wouldOrphan;
              const archiveBlockedReason: string | null = wouldOrphan
                ? "Cannot archive the last active admin."
                : null;
              return (
                <MemberRow
                  key={m.id}
                  member={m}
                  isAdmin={isAdmin}
                  isSelf={m.id === uid}
                  editable={canEditMemberRole(uid, myRole, m)}
                  pending={pendingRoleChange === m.id}
                  archivable={archivable}
                  archiveBlockedReason={archiveBlockedReason}
                  archiving={pendingArchive === m.id}
                  onRoleChange={(role) => handleRoleChange(m, role)}
                  onArchive={() => setArchivingMember(m)}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
          Archived section — collapsed by default. Hidden entirely
          when there are zero archived members so the page stays
          clean. Reactivate is admin-only; the row is read-only for
          non-admins. */}
      {archivedMembers.length > 0 && (
        <section style={cardStyle}>
          <button
            type="button"
            onClick={() => setArchivedSectionOpen((v) => !v)}
            style={{
              width: "100%",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: 0, background: "transparent", border: 0,
              cursor: "pointer", color: "#b3b3b3",
            }}
          >
            <div style={{ textAlign: "left" }}>
              <h2 style={sectionHeadingStyle}>Archived members</h2>
              <div style={{ fontSize: 12, color: "#6f6f6f" }}>
                {archivedMembers.length} archived
              </div>
            </div>
            <span style={{ fontSize: 12, color: "#6f6f6f" }}>
              {archivedSectionOpen ? "Hide" : "Show"}
            </span>
          </button>
          {archivedSectionOpen && (
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {archivedMembers.map((m) => (
                <ArchivedMemberRow
                  key={m.id}
                  member={m}
                  isAdmin={isAdmin}
                  pending={pendingArchive === m.id}
                  onReactivate={() => handleReactivate(m)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {inviteOpen && (
        <InviteModal
          onCancel={() => setInviteOpen(false)}
          onSubmit={handleInvite}
        />
      )}

      {/* PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04) */}
      {archivingMember && (
        <ArchiveModal
          member={archivingMember}
          onCancel={() => setArchivingMember(null)}
          onSubmit={handleArchiveSubmit}
        />
      )}

      {toastMsg && <div style={toastStyle}>{toastMsg}</div>}
    </div>
  );
}

// ---- Header (tab nav) ------------------------------------------------------

function Header({
  backHref, profileHref, vendorsHref, active,
}: {
  backHref: string;
  profileHref: string;
  vendorsHref: string;
  active: "profile" | "team" | "vendors";
}) {
  return (
    <>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <h1 style={titleStyle}>Settings</h1>
        <Link href={backHref} style={secondaryBtnStyle}>
          ← Back to Jobs
        </Link>
      </div>
      <nav style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <Link href={active === "profile" ? "#" : profileHref} style={tabStyle(active === "profile")}>
          Profile
        </Link>
        <Link
          href={active === "team" ? "#" : "/settings/team"}
          style={tabStyle(active === "team")}
          aria-current={active === "team" ? "page" : undefined}
        >
          Team
        </Link>
        <Link href={active === "vendors" ? "#" : vendorsHref} style={tabStyle(active === "vendors")}>
          Vendors
        </Link>
      </nav>
    </>
  );
}

// ---- Member row ------------------------------------------------------------

function MemberRow({
  member, isAdmin, isSelf, editable, pending,
  archivable, archiveBlockedReason, archiving,
  onRoleChange, onArchive,
}: {
  member: OrgMember;
  isAdmin: boolean;
  isSelf: boolean;
  editable: boolean;
  pending: boolean;
  archivable: boolean;
  archiveBlockedReason: string | null;
  archiving: boolean;
  onRoleChange: (role: OrgRole) => void;
  onArchive: () => void;
}) {
  const isInvited = member.status === "invited";
  const name = member.displayName || (isInvited ? "(invited)" : member.email || "(no name)");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 12px",
      border: "1px solid #1c1c1c", borderRadius: 6,
      background: "#0b0b0b",
    }}>
      <div style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: "#f5f5f5", fontWeight: 500,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span>{name}</span>
          {isSelf && <span style={selfTagStyle}>You</span>}
          {isInvited && <span style={invitedTagStyle}>Invited</span>}
        </div>
        <div style={{
          fontSize: 11, color: "#6f6f6f",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {member.email || "—"}
        </div>
      </div>

      <RoleBadge role={member.role} />

      {isAdmin && (
        <select
          value={member.role}
          disabled={!editable || pending || archiving}
          onChange={(e) => {
            const v = e.target.value;
            if (isOrgRole(v)) onRoleChange(v);
          }}
          style={{
            padding: "6px 8px",
            fontSize: 12,
            background: "#050505",
            color: editable ? "#f5f5f5" : "#6f6f6f",
            border: "1px solid #1c1c1c",
            borderRadius: 6,
            cursor: editable ? "pointer" : "not-allowed",
            minWidth: 110,
          }}
          title={isSelf ? "You can't change your own role." : undefined}
        >
          {ORG_ROLES.map((r) => (
            <option key={r} value={r}>{prettyRoleLabel(r)}</option>
          ))}
        </select>
      )}

      {/* PEAKOPS_TEAM_ARCHIVE_V1.1 (2026-05-04)
          Archive button: admin-only, hidden for self and already-
          archived rows. For last-admin rows the button RENDERS but is
          disabled with an explanatory tooltip — the prior turn hid it
          entirely, which made the constraint invisible to the admin.
          archiveBlockedReason carries the tooltip text from the
          parent (only set for last-admin today; future blocks can
          add their own messages). */}
      {isAdmin && !isSelf && member.status !== "archived" && (
        <button
          type="button"
          onClick={onArchive}
          disabled={!archivable || archiving || pending}
          style={dangerBtnStyle(archivable && !archiving && !pending)}
          title={
            archiveBlockedReason
              || (archiving ? "Archiving…" : "Remove from active roster")
          }
        >
          {archiving ? "Archiving…" : "Archive"}
        </button>
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: OrgRole }) {
  const palette = ROLE_PALETTE[role];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
      textTransform: "uppercase",
      padding: "3px 8px", borderRadius: 999,
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
    }}>
      {prettyRoleLabel(role)}
    </span>
  );
}

// PEAKOPS_TEAM_OWNER_ROLE_V1 (2026-05-07)
// Owner is given the same gold accent as admin (it IS the highest
// privilege) but a slightly stronger border so the chip reads
// "owner > admin" at a glance. Viewer is dimmer than field — it's
// the read-only role.
const ROLE_PALETTE: Record<OrgRole, { bg: string; fg: string; border: string }> = {
  owner:      { bg: "rgba(200,168,78,0.14)",  fg: "#C8A84E", border: "rgba(200,168,78,0.55)" },
  admin:      { bg: "rgba(200,168,78,0.10)",  fg: "#C8A84E", border: "rgba(200,168,78,0.35)" },
  supervisor: { bg: "rgba(126,182,255,0.10)", fg: "#7eb6ff", border: "rgba(126,182,255,0.30)" },
  field:      { bg: "rgba(180,180,180,0.06)", fg: "#b3b3b3", border: "#1c1c1c" },
  viewer:     { bg: "rgba(140,140,140,0.06)", fg: "#9a9a9a", border: "#1c1c1c" },
};

// ---- Invite modal ----------------------------------------------------------

function InviteModal({
  onCancel, onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: InvitePayload) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("field");
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);
  const canSubmit = !busy && trimmedName.length > 0 && emailLooksValid;

  async function handle() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit({ displayName: trimmedName, email: trimmedEmail, role });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div style={{
        background: "#050505",
        border: "1px solid #1c1c1c",
        borderRadius: 8,
        padding: 20,
        width: "100%", maxWidth: 420,
      }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
          Invite a team member
        </h3>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "#6f6f6f" }}>
          They'll appear in the team list as Invited until they sign up.
          Email isn't sent yet — share the sign-in link with them directly.
        </p>

        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              maxLength={64}
              style={inputStyle}
              autoFocus
            />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              style={inputStyle}
            />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabelStyle}>Role</span>
            <select
              value={role}
              onChange={(e) => { if (isOrgRole(e.target.value)) setRole(e.target.value); }}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>{prettyRoleLabel(r)}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtnStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handle}
            disabled={!canSubmit}
            style={primaryBtnStyle(canSubmit)}
          >
            {busy ? "Inviting…" : "Send invite"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Archived row ----------------------------------------------------------

// PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
// Renders archived members under the collapsible "Archived members"
// section. Subdued styling (lower opacity, no role dropdown). Shows
// archive metadata when available. Reactivate button is admin-only.
function ArchivedMemberRow({
  member, isAdmin, pending, onReactivate,
}: {
  member: OrgMember;
  isAdmin: boolean;
  pending: boolean;
  onReactivate: () => void;
}) {
  const name = member.displayName || member.email || "(no name)";
  const archivedAtIso = (() => {
    const v: any = member.archivedAt;
    try {
      const iso = v?.toDate?.().toISOString?.() || (typeof v === "string" ? v : null);
      if (!iso) return "";
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return "";
      return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    } catch { return ""; }
  })();
  const reason = String(member.archiveReason || "").trim();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 12px",
      border: "1px solid #1c1c1c", borderRadius: 6,
      background: "#0b0b0b",
      opacity: 0.7,
    }}>
      <div style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: "#f5f5f5", fontWeight: 500,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {name}
        </div>
        <div style={{
          fontSize: 11, color: "#6f6f6f",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {member.email || "—"}
        </div>
        {(archivedAtIso || reason) && (
          <div style={archiveMetaStyle}>
            Archived{archivedAtIso ? ` ${archivedAtIso}` : ""}{reason ? ` — ${reason}` : ""}
          </div>
        )}
      </div>

      <RoleBadge role={member.role} />

      {isAdmin && (
        <button
          type="button"
          onClick={onReactivate}
          disabled={pending}
          style={secondaryBtnStyle}
        >
          {pending ? "Reactivating…" : "Reactivate"}
        </button>
      )}
    </div>
  );
}

// ---- Archive modal --------------------------------------------------------

// PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
// Confirm modal with optional reason input. Body copy explains that
// archive is non-destructive — historical activity stays linked.
function ArchiveModal({
  member, onCancel, onSubmit,
}: {
  member: OrgMember;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function handle() {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(reason.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div style={{
        background: "#050505",
        border: "1px solid #1c1c1c",
        borderRadius: 8,
        padding: 20,
        width: "100%", maxWidth: 420,
      }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f5f5f5" }}>
          Archive this team member?
        </h3>
        <p style={{ margin: "0 0 4px", fontSize: 13, color: "#b3b3b3" }}>
          {member.displayName || member.email || "This member"} will lose access to this organization,
          but their historical activity will remain on past records.
        </p>

        <div style={{ display: "grid", gap: 6, marginTop: 14 }}>
          <span style={fieldLabelStyle}>Reason (optional)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Left the company"
            maxLength={120}
            style={inputStyle}
            autoFocus
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtnStyle}>
            Cancel
          </button>
          <button type="button" onClick={handle} disabled={busy} style={primaryBtnStyle(!busy)}>
            {busy ? "Archiving…" : "Archive member"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Styles ----------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#000",
  color: "#f5f5f5",
  padding: "24px 20px 64px",
  maxWidth: 720,
  margin: "0 auto",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const titleStyle: React.CSSProperties = {
  margin: 0, fontSize: 22, fontWeight: 700, color: "#f5f5f5",
};

const cardStyle: React.CSSProperties = {
  background: "#050505",
  border: "1px solid #1c1c1c",
  borderRadius: 8,
  padding: "16px 18px",
  marginBottom: 12,
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 4px", fontSize: 11, fontWeight: 700,
  letterSpacing: "0.10em", textTransform: "uppercase",
  color: "#6f6f6f",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11, color: "#6f6f6f", letterSpacing: "0.04em",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #1c1c1c",
  borderRadius: 6,
  background: "#0b0b0b",
  color: "#f5f5f5",
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 11, fontWeight: 600,
  background: "transparent",
  color: "#b3b3b3",
  border: "1px solid #1c1c1c",
  borderRadius: 6,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: 12, fontWeight: 600,
    background: active ? "#0b0b0b" : "transparent",
    color: active ? "#f5f5f5" : "#b3b3b3",
    border: "1px solid #1c1c1c",
    borderBottomColor: active ? "#C8A84E" : "#1c1c1c",
    borderRadius: 6,
    cursor: "pointer",
    textDecoration: "none",
  };
}

function primaryBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: 12, fontWeight: 700,
    border: 0,
    borderRadius: 6,
    cursor: enabled ? "pointer" : "not-allowed",
    color: enabled ? "#050505" : "#6f6f6f",
    background: enabled
      ? "linear-gradient(180deg, #C8A84E 0%, #A7862E 100%)"
      : "#1c1c1c",
    boxShadow: enabled
      ? "0 2px 12px rgba(200,168,78,0.20), inset 0 1px 0 rgba(255,255,255,0.08)"
      : "none",
    textDecoration: "none",
    display: "inline-block",
  };
}

const selfTagStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: "0.06em",
  textTransform: "uppercase",
  padding: "1px 6px", borderRadius: 4,
  background: "#1c1c1c", color: "#f5f5f5",
};

const invitedTagStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: "0.06em",
  textTransform: "uppercase",
  padding: "1px 6px", borderRadius: 4,
  background: "rgba(126,182,255,0.10)", color: "#7eb6ff",
  border: "1px solid rgba(126,182,255,0.20)",
};

// PEAKOPS_TEAM_ARCHIVE_V1 (2026-05-04)
function dangerBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 11, fontWeight: 600,
    background: "transparent",
    color: enabled ? "#e08383" : "#6f6f6f",
    border: `1px solid ${enabled ? "rgba(224,131,131,0.35)" : "#1c1c1c"}`,
    borderRadius: 6,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}

const archiveMetaStyle: React.CSSProperties = {
  fontSize: 10, color: "#6f6f6f",
  fontStyle: "italic",
};

const toastStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0b0b0b",
  color: "#f5f5f5",
  border: "1px solid #1c1c1c",
  borderRadius: 6,
  padding: "10px 14px",
  fontSize: 12,
  zIndex: 50,
};
