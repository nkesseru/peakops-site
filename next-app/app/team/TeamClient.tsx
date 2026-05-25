"use client";

// PEAKOPS_RAPID_ACCESS_RECOVERY_V1 (PR 49)
//
// Rapid Access Recovery — a field-ops first-responder panel, not a
// generic SaaS account-management page. A supervisor at a job site
// can re-issue access to a teammate whose login has slipped without
// ever seeing or storing the teammate's password.
//
// Access gate (client side, defense-in-depth — the server function
// also enforces this):
//   - Must be signed in (useAuth + RequireAuth).
//   - Custom-claim role must be in {owner, admin, supervisor}. Anything
//     else gets a clear "you don't have access" panel instead of the
//     recovery tools.
//
// Two recovery actions per teammate:
//   - "Send recovery email"  → backend calls Identity Toolkit, the
//     teammate receives the standard Firebase reset email branded by
//     our project, lands on /auth/action (PR 49 Phase B) to set a
//     new password.
//   - "Copy reset link"      → backend returns a single-use URL the
//     supervisor can paste into Slack / SMS / radio. Single-use,
//     ~1-hour expiry.
//
// Both actions are written to orgs/{orgId}/admin_audit before returning.

import { useEffect, useMemo, useState } from "react";
import RequireAuth from "@/components/RequireAuth";
import AppTopBar from "@/components/AppTopBar";
import { useAuth } from "@/hooks/useAuth";
import { authedFetch } from "@/lib/apiClient";

const PRIVILEGED_ROLES = new Set(["owner", "admin", "supervisor"]);

type OrgMember = {
  uid: string;
  displayName: string | null;
  email: string | null;
  role: string | null;
};

type RecoveryResponseOk = {
  ok: true;
  action: "password_reset_email_sent" | "password_reset_link_generated";
  link?: string;
  message: string;
};

type RecoveryResponseFail = {
  ok: false;
  error: string;
  message?: string;
};

type RecoveryResponse = RecoveryResponseOk | RecoveryResponseFail;

type PanelStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; message: string; link?: string }
  | { kind: "error"; message: string };

const colors = {
  background: "#000",
  card: "rgba(255,255,255,0.03)",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.14)",
  fg: "#fff",
  fgMuted: "rgba(255,255,255,0.62)",
  fgSubtle: "rgba(255,255,255,0.42)",
  accent: "#C8A84E",
  ok: "#86efac",
  okBg: "rgba(34,197,94,0.10)",
  okBorder: "rgba(34,197,94,0.30)",
  err: "#fca5a5",
  errBg: "rgba(220,60,60,0.10)",
  errBorder: "rgba(220,60,60,0.30)",
};

export default function TeamClient({ orgId }: { orgId: string }) {
  return (
    <RequireAuth>
      <TeamPanel orgId={orgId} />
    </RequireAuth>
  );
}

function TeamPanel({ orgId }: { orgId: string }) {
  const { claims } = useAuth();
  const callerRole = String(claims?.role || "").toLowerCase();
  const isPrivileged = PRIVILEGED_ROLES.has(callerRole);

  if (!orgId) {
    return (
      <Shell>
        <PanelTitle eyebrow="Rapid Access Recovery" title="Select an organization" />
        <p style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 1.55 }}>
          Open this page from a workspace link: <code>/team?orgId=...</code>
        </p>
      </Shell>
    );
  }

  if (!isPrivileged) {
    return (
      <Shell>
        <PanelTitle eyebrow="Rapid Access Recovery" title="You don't have access" />
        <p style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 1.55 }}>
          Access recovery is restricted to <strong>owner</strong>,{" "}
          <strong>admin</strong>, and <strong>supervisor</strong> roles for this
          organization. Ask one of them to handle the recovery, or contact your
          PeakOps administrator.
        </p>
      </Shell>
    );
  }

  return <Roster orgId={orgId} />;
}

function Roster({ orgId }: { orgId: string }) {
  const { user } = useAuth();
  const callerUid = user?.uid || "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [members, setMembers] = useState<OrgMember[]>([]);
  // Which member's recovery panel is open. Only one open at a time so
  // the supervisor can't accidentally fan out actions across the
  // roster.
  const [openUid, setOpenUid] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await authedFetch(
          `/api/fn/listOrgMembersV1?orgId=${encodeURIComponent(orgId)}`,
          { redirectOnUnauth: true },
        );
        if (!res.ok) {
          if (!cancelled) {
            setError(
              "We couldn't load the roster. Refresh the page or contact your PeakOps administrator.",
            );
            setMembers([]);
          }
          return;
        }
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const list = Array.isArray(data?.docs) ? (data.docs as OrgMember[]) : [];
        list.sort((a, b) => {
          // Privileged roles first, then alpha by displayName/email
          const ar = a.role || "";
          const br = b.role || "";
          const ap = PRIVILEGED_ROLES.has(ar) ? 0 : 1;
          const bp = PRIVILEGED_ROLES.has(br) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          const an = (a.displayName || a.email || a.uid).toLowerCase();
          const bn = (b.displayName || b.email || b.uid).toLowerCase();
          return an < bn ? -1 : an > bn ? 1 : 0;
        });
        setMembers(list);
      } catch {
        if (!cancelled) {
          setError(
            "We couldn't load the roster. Refresh the page or contact your PeakOps administrator.",
          );
          setMembers([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <Shell wide>
      <PanelTitle
        eyebrow="Rapid Access Recovery"
        title="Get a teammate back in the field"
        subhead={
          <>
            Re-issue access for a member of this organization. You never see
            their password — the system either emails them a recovery link or
            hands you a single-use URL you can read back over radio or SMS.
          </>
        }
      />

      {loading ? (
        <Status text="Loading roster…" />
      ) : error ? (
        <Status tone="error" text={error} />
      ) : members.length === 0 ? (
        <Status text="No active members found for this organization." />
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {members.map((m) => (
            <li key={m.uid}>
              <MemberRow
                member={m}
                orgId={orgId}
                isSelf={m.uid === callerUid}
                open={openUid === m.uid}
                onToggle={() => setOpenUid(openUid === m.uid ? "" : m.uid)}
              />
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function MemberRow({
  member,
  orgId,
  isSelf,
  open,
  onToggle,
}: {
  member: OrgMember;
  orgId: string;
  isSelf: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const displayName = member.displayName || member.email || member.uid;
  const role = (member.role || "member").toLowerCase();
  return (
    <div
      style={{
        border: `1px solid ${open ? colors.borderStrong : colors.border}`,
        background: colors.card,
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: colors.fg,
              fontSize: 14,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayName}
            {isSelf ? (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: colors.fgSubtle,
                }}
              >
                you
              </span>
            ) : null}
          </div>
          <div
            style={{
              color: colors.fgMuted,
              fontSize: 12,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {member.email || "—"}
            <span style={{ margin: "0 8px", color: colors.fgSubtle }}>·</span>
            <span style={{ textTransform: "capitalize" }}>{role}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={isSelf || !member.email}
          title={
            isSelf
              ? "Use Forgot password on the sign-in screen to reset your own access."
              : !member.email
              ? "This member has no email on file."
              : ""
          }
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: `1px solid ${colors.borderStrong}`,
            background: isSelf || !member.email ? "transparent" : colors.fg,
            color: isSelf || !member.email ? colors.fgSubtle : "#000",
            fontSize: 12,
            fontWeight: 600,
            cursor: isSelf || !member.email ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {open ? "Close" : "Reset their access"}
        </button>
      </div>

      {open && member.email ? (
        <RecoveryPanel orgId={orgId} member={member} />
      ) : null}
    </div>
  );
}

function RecoveryPanel({
  orgId,
  member,
}: {
  orgId: string;
  member: OrgMember;
}) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<PanelStatus>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const email = useMemo(() => String(member.email || "").trim(), [member.email]);
  const sending = status.kind === "sending";

  async function runRecovery(mode: "email" | "link") {
    if (!email) return;
    setStatus({ kind: "sending" });
    setCopied(false);
    try {
      const res = await authedFetch(`/api/team/recovery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          targetEmail: email,
          mode,
          reason: reason.trim() || undefined,
        }),
        redirectOnUnauth: true,
      });
      const data = (await res.json().catch(() => null)) as RecoveryResponse | null;
      if (!res.ok || !data || !data.ok) {
        const msg = friendlyError(data, res.status);
        setStatus({ kind: "error", message: msg });
        return;
      }
      setStatus({
        kind: "ok",
        message: data.message || "Recovery action completed.",
        link: data.link,
      });
    } catch {
      setStatus({
        kind: "error",
        message:
          "We couldn't reach the recovery service. Check your connection and try again.",
      });
    }
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback: prompt the user; they can copy manually.
      window.prompt("Copy this reset link", link);
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: `1px solid ${colors.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <label
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: colors.fgSubtle,
        }}
      >
        Reason (logged for audit)
      </label>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 200))}
        placeholder="e.g. forgot password on site, locked out before shift"
        disabled={sending}
        style={{
          padding: "9px 11px",
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
          background: "rgba(255,255,255,0.04)",
          color: colors.fg,
          fontSize: 13,
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => runRecovery("email")}
          disabled={sending}
          style={{
            padding: "9px 14px",
            borderRadius: 8,
            border: `1px solid ${colors.borderStrong}`,
            background: sending ? "rgba(255,255,255,0.04)" : colors.fg,
            color: sending ? colors.fgSubtle : "#000",
            fontSize: 13,
            fontWeight: 600,
            cursor: sending ? "not-allowed" : "pointer",
          }}
        >
          {status.kind === "sending"
            ? "Working…"
            : `Send recovery email to ${email}`}
        </button>
        <button
          type="button"
          onClick={() => runRecovery("link")}
          disabled={sending}
          style={{
            padding: "9px 14px",
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            background: "transparent",
            color: sending ? colors.fgSubtle : colors.fg,
            fontSize: 13,
            fontWeight: 500,
            cursor: sending ? "not-allowed" : "pointer",
          }}
        >
          Copy reset link
        </button>
      </div>

      {status.kind === "ok" ? (
        <div
          role="status"
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${colors.okBorder}`,
            background: colors.okBg,
            color: colors.ok,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: "#fff", fontWeight: 600, marginBottom: 4 }}>
            {status.message}
          </div>
          {status.link ? (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                  color: "#fff",
                  background: "rgba(0,0,0,0.35)",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  wordBreak: "break-all",
                }}
              >
                {status.link}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => copyLink(status.link!)}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 8,
                    border: `1px solid ${colors.borderStrong}`,
                    background: colors.fg,
                    color: "#000",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
                <span
                  style={{
                    fontSize: 11,
                    color: colors.fgSubtle,
                    lineHeight: 1.4,
                  }}
                >
                  Single-use · expires in about an hour.
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {status.kind === "error" ? (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${colors.errBorder}`,
            background: colors.errBg,
            color: colors.err,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {status.message}
        </div>
      ) : null}
    </div>
  );
}

function friendlyError(
  data: RecoveryResponse | null,
  status: number,
): string {
  const error = String((data as RecoveryResponseFail | null)?.error || "");
  const message = String((data as RecoveryResponseFail | null)?.message || "");
  if (error === "no_active_account_in_org") {
    return "No active account found for this organization.";
  }
  if (error === "rate_limited" || status === 429) {
    return (
      message ||
      "Too many recovery emails in a short window. Wait a minute and try again."
    );
  }
  if (error === "forbidden_role" || error === "forbidden") {
    return "Your role doesn't allow recovery actions for this organization.";
  }
  if (error === "auth_required" || status === 401) {
    return "Sign in again to continue.";
  }
  if (error === "send_failed" || error === "link_generation_failed") {
    return (
      message ||
      "We couldn't reach the recovery service. Try again in a moment."
    );
  }
  return message || "Recovery didn't complete. Try again, or use the other action below.";
}

function Shell({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: colors.background,
        color: colors.fg,
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <AppTopBar />
      <div
        style={{
          width: "100%",
          maxWidth: wide ? 720 : 460,
          margin: "0 auto",
          padding: "32px 24px",
        }}
      >
        {children}
      </div>
    </main>
  );
}

function PanelTitle({
  eyebrow,
  title,
  subhead,
}: {
  eyebrow: string;
  title: string;
  subhead?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.18em",
          color: colors.accent,
          textTransform: "uppercase",
        }}
      >
        {eyebrow}
      </div>
      <h1
        style={{
          fontSize: 22,
          fontWeight: 600,
          margin: "8px 0 0 0",
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </h1>
      {subhead ? (
        <p
          style={{
            fontSize: 13,
            color: colors.fgMuted,
            lineHeight: 1.55,
            marginTop: 8,
          }}
        >
          {subhead}
        </p>
      ) : null}
    </div>
  );
}

function Status({
  text,
  tone,
}: {
  text: string;
  tone?: "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        padding: "12px 14px",
        borderRadius: 8,
        border:
          tone === "error"
            ? `1px solid ${colors.errBorder}`
            : `1px solid ${colors.border}`,
        background: tone === "error" ? colors.errBg : "rgba(255,255,255,0.02)",
        color: tone === "error" ? colors.err : colors.fgMuted,
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      {text}
    </div>
  );
}
