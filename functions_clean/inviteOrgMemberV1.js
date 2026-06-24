// PEAKOPS_INVITE_ORG_MEMBER_V1 (Chunk 3B-1, 2026-06-22)
//
// One-call teammate invitation. Replaces the per-teammate manual
// founder dance documented in docs/checkpoints/chunk1-trust-foundation.md
// (Chunk 3A audit):
//
//   Before (per-teammate manual sequence):
//     1. Create Firebase Auth user in Console
//     2. node setClaims.cjs <uid> <orgId> <role> --apply
//     3. Ad-hoc email the teammate their first-login URL
//
//   After (this callable):
//     POST /inviteOrgMemberV1 { orgId, email, role, displayName? }
//        → atomic: find-or-create Auth user, write/update member doc,
//                  merge claims (append orgId to orgIds, set role),
//                  audit row, return first-login magic link.
//
// Auth gate: caller must be an active owner or admin of the target
// org. Uses _authz.assertActorRole(orgId, callerUid, ROLES_ADMIN_ONLY).
// Internal admins (peakopsInternalAdmin claim) also accepted as a
// founder-runs-it path for early bootstrap.
//
// Idempotency: if a member doc for this email's uid already exists
// with the same role, return { already: true }. If the role differs,
// the call refuses with 409 "role_conflict" — the caller should use
// a dedicated role-update endpoint (future PR) rather than implicitly
// reassigning via invite.
//
// Multi-org behavior: when the invited user already belongs to other
// orgs, their orgIds claim is APPENDED with the new orgId (not
// replaced). The `role` and `orgId` (singular) claims are updated to
// reflect the new org for backward compatibility with code that hasn't
// migrated to the orgIds array shape; switching orgs in the org-
// switcher updates the active role contextually.
//
// What this does NOT do:
//   - It does NOT send an email automatically. The caller (operator
//     UI or CS activation script) is responsible for delivering the
//     returned magic link.
//   - It does NOT validate that the email belongs to a real human
//     (Firebase Auth allows arbitrary email addresses).
//   - It does NOT enforce a max-members limit (handled separately by
//     entitlement / billing config).

const { onRequest } = require("firebase-functions/v2/https");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  assertActorMember,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
// PR 134B — optional auto-email for invite magic links.
const { sendEmail } = require("./_emailer");
const { inviteTeammateEmail } = require("./_emailTemplates");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function isEmailShape(v) {
  const s = String(v == null ? "" : v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function emulatorMode() {
  return Boolean(
    String(process.env.FIRESTORE_EMULATOR_HOST || "").trim() ||
      String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim(),
  );
}

const VALID_ROLES = new Set(["owner", "admin", "supervisor", "field", "viewer"]);
const DEFAULT_PERMISSIONS_BY_ROLE = {
  owner:      { incidents: { create: true,  assign: true,  close: true  }, workflows: { edit: true  }, members: { invite: true,  manage: true  }, billing: { view: true,  manage: true  } },
  admin:      { incidents: { create: true,  assign: true,  close: true  }, workflows: { edit: true  }, members: { invite: true,  manage: true  }, billing: { view: true,  manage: false } },
  supervisor: { incidents: { create: false, assign: true,  close: true  }, workflows: { edit: false }, members: { invite: false, manage: false }, billing: { view: false, manage: false } },
  field:      { incidents: { create: false, assign: false, close: false }, workflows: { edit: false }, members: { invite: false, manage: false }, billing: { view: false, manage: false } },
  viewer:     { incidents: { create: false, assign: false, close: false }, workflows: { edit: false }, members: { invite: false, manage: false }, billing: { view: false, manage: false } },
};

function buildActionCodeSettings(req) {
  // PEAKOPS_PROD_ORIGIN_PRIORITY_V1 (Chunk 3B-1 follow-up, 2026-06-22)
  // See createOrgV1.js for the full rationale. Short version: prefer
  // PEAKOPS_APP_ORIGIN env var over request-derived headers so direct-
  // to-function-URL callers don't construct an action URL with the
  // Cloud Run hostname (which isn't allowlisted in Firebase Auth).
  const envOrigin = String(process.env.PEAKOPS_APP_ORIGIN || "").trim();
  if (envOrigin) {
    const cleaned = envOrigin.replace(/\/+$/, "");
    return { url: `${cleaned}/auth/action`, handleCodeInApp: true };
  }
  const xfp = String(req.headers["x-forwarded-proto"] || "https");
  const xfh = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  let origin = "";
  if (xfh) {
    origin = `${xfp}://${xfh}`;
  } else {
    origin = "https://app.peakops.app";
  }
  origin = origin.replace(/\/+$/, "");
  return {
    url: `${origin}/auth/action`,
    handleCodeInApp: true,
  };
}

async function findOrCreateAuthUser({ email, displayName }) {
  try {
    const u = await admin.auth().getUserByEmail(email);
    return { uid: u.uid, created: false };
  } catch (e) {
    const code = String((e && e.code) || "").toLowerCase();
    if (!code.includes("user-not-found")) {
      throw e;
    }
  }
  const created = await admin.auth().createUser({
    email,
    emailVerified: false,
    disabled: false,
    ...(displayName ? { displayName } : {}),
  });
  return { uid: created.uid, created: true };
}

// Merge orgId + role + orgIds onto existing claims, APPENDING orgId
// to orgIds when the user already belongs to other orgs.
async function mergeMemberClaims(uid, orgId, role) {
  let existing = {};
  try {
    const u = await admin.auth().getUser(uid);
    existing = u.customClaims || {};
  } catch (_e) { /* fresh user */ }

  // Append orgId to orgIds without duplicates. Preserve order of
  // existing orgs first.
  const priorIds = Array.isArray(existing.orgIds)
    ? existing.orgIds.map((v) => String(v || "").trim()).filter(Boolean)
    : (existing.orgId ? [String(existing.orgId)] : []);
  const orgIds = priorIds.includes(orgId) ? priorIds : [...priorIds, orgId];

  // For the singular `orgId` and `role` claims (backward-compat with
  // any non-array reader), point them at the newly-invited org. This
  // matches the behavior new users expect when they first sign in
  // ("I see the org I was just invited to"). Users already active in
  // another org can switch via the in-product org switcher; the
  // org-switcher resolves role per-org from the member doc, not from
  // the singular `role` claim.
  const next = {
    ...existing,
    orgId,
    role,
    orgIds,
  };
  await admin.auth().setCustomUserClaims(uid, next);
  return { before: existing, after: next };
}

exports.inviteOrgMemberV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return j(res, 405, { ok: false, error: "POST required" });
    }
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    // ── Input validation ──────────────────────────────────────────
    let orgId;
    let email;
    let role;
    try {
      orgId = mustStr(body.orgId, "orgId");
      email = mustStr(body.email, "email").toLowerCase();
      role = mustStr(body.role, "role").toLowerCase();
    } catch (e) {
      return j(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
    if (!isEmailShape(email)) {
      return j(res, 400, { ok: false, error: "invalid_email" });
    }
    if (!VALID_ROLES.has(role)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_role",
        detail: `role must be one of: ${Array.from(VALID_ROLES).join(", ")}`,
      });
    }
    // Disallow inviting a second "owner" — there's one owner per org
    // (the ownerUserId on the org doc).
    if (role === "owner") {
      return j(res, 400, {
        ok: false,
        error: "owner_role_not_invitable",
        detail: "owner role is set by createOrgV1; invite admin/supervisor/field/viewer instead",
      });
    }

    const displayName = String(body.displayName || "").trim();

    // ── Caller auth ───────────────────────────────────────────────
    let callerUid = "";
    let callerClaims = null;
    try {
      const out = await extractActorUid(req, body);
      callerUid = String(out.uid || "").trim();
      callerClaims = out.claims || null;
    } catch (e) {
      console.warn("[inviteOrgMemberV1] actor_extract_failed", { msg: String(e && e.message) });
    }
    if (!callerUid) {
      const e = new HttpsError("unauthenticated", "[inviteOrgMemberV1] caller uid required");
      return j(res, httpStatusFromAuthzError(e), { ok: false, error: "unauthenticated" });
    }

    const isEmu = emulatorMode();
    const isInternal = !!callerClaims && callerClaims.peakopsInternalAdmin === true;

    if (!isInternal && !isEmu) {
      // Production path: caller must be an active admin or owner
      // member of the target org.
      try {
        const gate = await assertActorMember(orgId, callerUid);
        const callerRole = String((gate.membership && gate.membership.role) || "").toLowerCase();
        if (!ROLES_ADMIN_ONLY.includes(callerRole)) {
          const e = new HttpsError(
            "permission-denied",
            `[inviteOrgMemberV1] role "${callerRole}" not in admin allow-list`,
          );
          return j(res, httpStatusFromAuthzError(e), { ok: false, error: "permission-denied" });
        }
      } catch (e) {
        return j(res, httpStatusFromAuthzError(e), {
          ok: false,
          error: "permission-denied",
          detail: String((e && e.message) || e),
        });
      }
    }

    console.log("[inviteOrgMemberV1] authz_ok", {
      fn: "inviteOrgMemberV1",
      orgId, email, role, callerUid,
      mode: isInternal ? "internal" : (isEmu ? "emulator" : "production"),
    });

    const db = getFirestore();
    const orgRef = db.doc(`orgs/${orgId}`);
    const orgSnap = await orgRef.get();
    if (!orgSnap.exists) {
      return j(res, 404, { ok: false, error: "org_not_found", orgId });
    }

    // ── Find-or-create Auth user ─────────────────────────────────
    let authResult;
    try {
      authResult = await findOrCreateAuthUser({ email, displayName });
    } catch (e) {
      console.error("[inviteOrgMemberV1] auth_user_failed", {
        orgId, email, msg: String(e && e.message || e),
      });
      return j(res, 502, {
        ok: false,
        error: "auth_user_provision_failed",
        detail: String((e && e.message) || e),
      });
    }
    const inviteeUid = authResult.uid;

    // ── Idempotency: existing member with same role ──────────────
    const memberRef = db.doc(`orgs/${orgId}/members/${inviteeUid}`);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists) {
      const md = memberSnap.data() || {};
      const existingRole = String(md.role || "").toLowerCase();
      const existingStatus = String(md.status || "active").toLowerCase();
      if (existingStatus === "active" && existingRole === role) {
        console.log("[inviteOrgMemberV1] already_member", {
          orgId, inviteeUid, role,
        });
        return j(res, 200, {
          ok: true,
          orgId,
          uid: inviteeUid,
          email,
          role,
          already: true,
          authUserCreated: authResult.created,
        });
      }
      if (existingStatus === "active" && existingRole !== role && existingRole !== "") {
        return j(res, 409, {
          ok: false,
          error: "role_conflict",
          detail: `existing member has role="${existingRole}"; refusing implicit role change to "${role}"`,
          orgId,
          uid: inviteeUid,
        });
      }
    }

    // ── Mint custom claims (append orgId to orgIds) ──────────────
    try {
      await mergeMemberClaims(inviteeUid, orgId, role);
    } catch (e) {
      console.error("[inviteOrgMemberV1] claims_failed", {
        orgId, inviteeUid, msg: String(e && e.message || e),
      });
      return j(res, 502, {
        ok: false,
        error: "claims_mint_failed",
        detail: String((e && e.message) || e),
        orgId,
        uid: inviteeUid,
      });
    }

    // ── Generate first-login magic link ──────────────────────────
    let magicLink = "";
    try {
      const acs = buildActionCodeSettings(req);
      magicLink = await admin
        .auth()
        .generatePasswordResetLink(email, acs);
    } catch (e) {
      console.warn("[inviteOrgMemberV1] magic_link_failed", {
        orgId, inviteeUid, msg: String(e && e.message || e),
      });
    }

    // ── Atomic member doc + audit ────────────────────────────────
    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    const auditId = `invite_${Date.now()}_${inviteeUid.slice(0, 8)}`;
    const auditRef = db.doc(`orgs/${orgId}/audit/${auditId}`);

    batch.set(memberRef, {
      uid: inviteeUid,
      orgId,
      role,
      status: "active",
      email,
      displayName: displayName || null,
      source: "invite-org-member-v1",
      invitedBy: callerUid,
      invitedAt: now,
      joinedAt: now,
      permissions: DEFAULT_PERMISSIONS_BY_ROLE[role] || DEFAULT_PERMISSIONS_BY_ROLE.viewer,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });

    batch.set(auditRef, {
      id: auditId,
      type: "MEMBER_INVITED",
      orgId,
      inviteeUid,
      email,
      role,
      displayName: displayName || null,
      callerUid,
      authUserCreated: authResult.created,
      mode: isInternal ? "internal" : (isEmu ? "emulator" : "production"),
      occurredAt: now,
    });

    await batch.commit();

    // PEAKOPS_AUTO_EMAIL_V1 (PR 134B, 2026-06-24) — optional invite
    // email. Opt-in via body.sendInviteEmail (default false to
    // preserve the manual copy-paste flow). Runs AFTER the atomic
    // batch commits so a delivery failure can never roll back the
    // invite. Status is recorded in the response + audit row.
    let inviteEmail = { attempted: false, ok: false };
    const sendInvite = body && body.sendInviteEmail === true;
    if (sendInvite && magicLink) {
      const orgName = String((orgSnap.data() || {}).name || orgId);
      const inviterName = body.inviterName ? String(body.inviterName).slice(0, 96) : "";
      const tpl = inviteTeammateEmail({
        teammateName: displayName || "",
        orgName,
        role,
        magicLink,
        inviterName,
      });
      const result = await sendEmail({
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        tag: "inviteOrgMemberV1:invite",
      });
      inviteEmail = { attempted: true, ...result };
      const auditEmailId = `invite_email_${Date.now()}_${inviteeUid.slice(0, 8)}`;
      try {
        await db.doc(`orgs/${orgId}/audit/${auditEmailId}`).set({
          id: auditEmailId,
          type: "invite_email_attempted",
          orgId,
          recipient: email,
          role,
          ok: !!result.ok,
          skipped: !!result.skipped,
          reason: result.reason || null,
          deliveryId: result.deliveryId || null,
          callerUid,
          occurredAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn("[inviteOrgMemberV1] invite_email_audit_failed", { msg: String(e && e.message) });
      }
      console.log("[inviteOrgMemberV1] invite_email", {
        orgId, recipient: email, role, ok: result.ok, skipped: result.skipped, reason: result.reason || null,
      });
    }

    return j(res, 200, {
      ok: true,
      orgId,
      uid: inviteeUid,
      email,
      role,
      displayName: displayName || null,
      authUserCreated: authResult.created,
      magicLink: magicLink || null,
      inviteEmail,
      invitedAt: new Date().toISOString(),
      already: false,
    });
  } catch (e) {
    console.error("[inviteOrgMemberV1] failed", { msg: String(e && e.message || e) });
    return j(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});
