// PEAKOPS_RAPID_ACCESS_RECOVERY_V1 (PR 49)
//
// Field-ops first-responder: lets an org's owner / admin / supervisor
// help a teammate regain access without seeing their password.
//
// Two modes:
//   mode = "email"  → triggers Firebase to deliver its standard password
//                     reset email to the target. We call the Identity
//                     Toolkit REST endpoint (`accounts:sendOobCode`) — the
//                     same path the client SDK's sendPasswordResetEmail
//                     uses — so no SMTP provider is required.
//   mode = "link"   → returns a single-use password reset URL the caller
//                     can paste into Slack / SMS / a radio call-in. The
//                     link expires per Firebase defaults (~1 hour). The
//                     caller's possession of this link is logged.
//
// Authorization model (mirrors the rest of the app):
//   - Bearer ID token required (no body-actor fallback in production).
//   - Verified caller must be a member of the requested org with role
//     in {owner, admin, supervisor}.
//   - Target user must be an *active* member of the same org (status
//     != "archived"). Cross-org snooping is rejected before any
//     Identity Toolkit call is made.
//
// Audit:
//   Every attempt — success, not-found, send-failed — writes one doc
//   to orgs/{orgId}/admin_audit. The doc is the only durable record
//   of the action; we deliberately do not echo it back to the caller
//   beyond the strictly-necessary response.
//
// Customer-safe failure surface (no email-enumeration leak to outside
// callers):
//   The caller is already a privileged org actor — they have a
//   legitimate need to know whether a given email exists in their
//   roster (otherwise they can't help that person). So the
//   target-not-found response is explicit: "No active account found
//   for this organization." This is intentionally a different posture
//   from the public /login forgot-password flow, where any enumeration
//   leak would be unsafe.

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { resolveActor, requireOrgMember } = require("./jobAuthz");

try {
  if (!admin.apps.length) admin.initializeApp();
} catch (_) {}

const PRIVILEGED_ROLES = ["owner", "admin", "supervisor"];

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function toStr(v) {
  return String(v || "").trim();
}

function isEmailShape(v) {
  const s = toStr(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function buildActionCodeSettings(req) {
  // Customer app origin — derived from the incoming request so dev
  // (localhost) and prod (app.peakops.app) both land on their own
  // /auth/action handler. Falls back to a hard-coded prod origin if
  // the header is missing (e.g. when triggered via direct function
  // invocation), so the email link is never relative.
  const xfp = toStr(req.headers["x-forwarded-proto"]) || "https";
  const xfh = toStr(req.headers["x-forwarded-host"]) || toStr(req.headers.host);
  let origin = "";
  if (xfh) {
    origin = `${xfp}://${xfh}`;
  } else {
    origin =
      toStr(process.env.PEAKOPS_APP_ORIGIN) ||
      "https://app.peakops.app";
  }
  // Strip any trailing slash for a stable continueUrl shape.
  origin = origin.replace(/\/+$/, "");
  return {
    url: `${origin}/auth/action`,
    handleCodeInApp: true,
  };
}

async function writeAuditEntry(db, entry) {
  // Best-effort — never fail the parent operation because the audit
  // write hit a transient Firestore error. We log + swallow, so the
  // caller still gets the action result; in practice this collection
  // is created on first write and routes through the standard admin
  // SDK so it succeeds.
  try {
    await db
      .collection("orgs")
      .doc(toStr(entry.orgId))
      .collection("admin_audit")
      .add({
        ...entry,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error("[teamRecoveryV1] audit write failed", e && e.message);
  }
}

async function sendResetEmailViaIdentityToolkit(targetEmail, actionCodeSettings) {
  const apiKey =
    toStr(process.env.NEXT_PUBLIC_FIREBASE_API_KEY) ||
    toStr(process.env.FIREBASE_WEB_API_KEY) ||
    toStr(process.env.IDENTITY_TOOLKIT_API_KEY);
  if (!apiKey) {
    throw new Error("missing_api_key");
  }
  // Identity Toolkit: same endpoint the client SDK uses under the
  // hood for sendPasswordResetEmail. Setting canHandleCodeInApp +
  // continueUrl makes Firebase wrap the oobCode into a continueUrl
  // that lands on our /auth/action handler instead of the default
  // *.firebaseapp.com hosted page.
  const url =
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requestType: "PASSWORD_RESET",
    email: targetEmail,
    continueUrl: actionCodeSettings.url,
    canHandleCodeInApp: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`identity_toolkit_${res.status}`);
    err.detail = text.slice(0, 400);
    err.status = res.status;
    throw err;
  }
}

exports.teamRecoveryV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return j(res, 405, { ok: false, error: "POST required" });
    }

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = toStr(body.orgId);
    const targetEmail = toStr(body.targetEmail).toLowerCase();
    const mode = toStr(body.mode).toLowerCase();
    const reason = toStr(body.reason).slice(0, 500);

    if (!orgId) return j(res, 400, { ok: false, error: "orgId required" });
    if (!targetEmail) return j(res, 400, { ok: false, error: "targetEmail required" });
    if (!isEmailShape(targetEmail)) {
      return j(res, 400, { ok: false, error: "targetEmail invalid" });
    }
    if (mode !== "email" && mode !== "link") {
      return j(res, 400, { ok: false, error: "mode must be 'email' or 'link'" });
    }

    const db = getFirestore();

    // Auth: caller must be a privileged member of the requested org.
    const actor = await resolveActor(req, body, req.query || {});
    await requireOrgMember(db, orgId, actor, { requiredRoles: PRIVILEGED_ROLES });

    const actorCtx = {
      actorUid: toStr(actor && actor.uid) || null,
      actorEmail: toStr(actor && actor.email) || null,
      actorRole: toStr(actor && actor.role).toLowerCase() || null,
      orgId,
      targetEmail,
      mode,
      reason: reason || null,
      ip:
        toStr(req.headers["x-forwarded-for"]).split(",")[0].trim() ||
        toStr(req.ip) ||
        null,
      userAgent: toStr(req.headers["user-agent"]) || null,
    };

    // Org-scoped target lookup. The caller is privileged inside this
    // org, so a not-found result is safe to surface — see header.
    let targetUid = null;
    try {
      const userRecord = await admin.auth().getUserByEmail(targetEmail);
      targetUid = toStr(userRecord && userRecord.uid) || null;
    } catch (e) {
      const code = String((e && e.code) || "").toLowerCase();
      if (code.includes("user-not-found")) {
        await writeAuditEntry(db, {
          action:
            mode === "email"
              ? "password_reset_email_sent"
              : "password_reset_link_generated",
          targetUid: null,
          result: "no_active_account_in_org",
          ...actorCtx,
        });
        return j(res, 404, {
          ok: false,
          error: "no_active_account_in_org",
          message: "No active account found for this organization.",
        });
      }
      throw e;
    }

    // Org membership check. Caller and target must share the org.
    const memberSnap = await db
      .collection("orgs")
      .doc(orgId)
      .collection("members")
      .doc(targetUid)
      .get();
    const memberData = memberSnap.exists ? memberSnap.data() || {} : null;
    const memberStatus = toStr(memberData && memberData.status).toLowerCase();
    // Mirrors listOrgMembersV1: treat missing status as active.
    const isActiveMember =
      !!memberData && (memberStatus === "" || memberStatus === "active");
    if (!isActiveMember) {
      await writeAuditEntry(db, {
        action:
          mode === "email"
            ? "password_reset_email_sent"
            : "password_reset_link_generated",
        targetUid,
        result: "no_active_account_in_org",
        ...actorCtx,
      });
      return j(res, 404, {
        ok: false,
        error: "no_active_account_in_org",
        message: "No active account found for this organization.",
      });
    }

    const actionCodeSettings = buildActionCodeSettings(req);

    if (mode === "email") {
      try {
        await sendResetEmailViaIdentityToolkit(targetEmail, actionCodeSettings);
      } catch (e) {
        const detail = String((e && e.message) || e);
        await writeAuditEntry(db, {
          action: "password_reset_email_sent",
          targetUid,
          result: "send_failed",
          errorCode: detail.slice(0, 120),
          ...actorCtx,
        });
        // Rate-limit / quota — return a clean message.
        if (/too-many|quota|429/i.test(detail)) {
          return j(res, 429, {
            ok: false,
            error: "rate_limited",
            message:
              "Too many recovery emails in a short window. Wait a minute and try again.",
          });
        }
        return j(res, 502, {
          ok: false,
          error: "send_failed",
          message:
            "We couldn't send the recovery email right now. Try again, or use 'Copy reset link' instead.",
        });
      }
      await writeAuditEntry(db, {
        action: "password_reset_email_sent",
        targetUid,
        result: "ok",
        ...actorCtx,
      });
      return j(res, 200, {
        ok: true,
        action: "password_reset_email_sent",
        message: `Recovery email sent to ${targetEmail}.`,
      });
    }

    // mode === "link" — generate a copyable single-use URL.
    let link = "";
    try {
      link = await admin
        .auth()
        .generatePasswordResetLink(targetEmail, actionCodeSettings);
    } catch (e) {
      const detail = String((e && e.message) || e);
      await writeAuditEntry(db, {
        action: "password_reset_link_generated",
        targetUid,
        result: "send_failed",
        errorCode: detail.slice(0, 120),
        ...actorCtx,
      });
      return j(res, 502, {
        ok: false,
        error: "link_generation_failed",
        message:
          "We couldn't generate a reset link right now. Try again, or use 'Send recovery email' instead.",
      });
    }
    await writeAuditEntry(db, {
      action: "password_reset_link_generated",
      targetUid,
      result: "ok",
      ...actorCtx,
    });
    res.setHeader("cache-control", "no-store");
    return j(res, 200, {
      ok: true,
      action: "password_reset_link_generated",
      link,
      message:
        "Reset link generated. It is single-use and expires in about an hour.",
    });
  } catch (e) {
    const status = Number(e && e.statusCode) || 400;
    const code = String((e && e.message) || e);
    // requireOrgMember / resolveActor throw with statusCode + a short
    // tag like "forbidden_role" / "auth_required" / "org_mismatch" /
    // "not_org_member" — pass those through unchanged so the UI can
    // distinguish auth failures from anything else.
    return j(res, status, { ok: false, error: code });
  }
});
