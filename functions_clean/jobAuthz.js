const admin = require("firebase-admin");

function toStr(v) {
  return String(v || "").trim();
}

function roleOf(v) {
  return toStr(v).toLowerCase();
}

function isPrivileged(role) {
  const r = roleOf(role);
  return r === "owner" || r === "admin";
}

function isEmulatorLike() {
  const emu = toStr(process.env.FUNCTIONS_EMULATOR).toLowerCase() === "true";
  const nodeEnv = toStr(process.env.NODE_ENV).toLowerCase();
  return emu || nodeEnv !== "production";
}

async function resolveActor(req, body = {}, query = {}) {
  const authz = toStr(req?.headers?.authorization);
  const roleHeader = roleOf(req?.headers?.["x-peakops-role"]);
  const uidHeader = toStr(req?.headers?.["x-peakops-uid"]);

  const roleBody = roleOf(body.actorRole || body.role || query.actorRole || query.role);
  const uidBody = toStr(body.actorUid || body.uid || query.actorUid || query.uid);
  const emailBody = toStr(body.actorEmail || body.email || query.actorEmail || query.email);

  let uid = uidHeader || uidBody;
  let role = roleHeader || roleBody;
  let email = emailBody;
  let claimsOrgId = "";
  let verified = false;

  if (authz.toLowerCase().startsWith("bearer ")) {
    const token = authz.slice(7).trim();
    if (token) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        verified = true;
        uid = toStr(decoded?.uid) || uid;
        role = roleOf(decoded?.role || decoded?.app_role) || role;
        email = toStr(decoded?.email) || email;
        claimsOrgId = toStr(decoded?.orgId || decoded?.org_id);
      } catch {}
    }
  }

  return { uid, role, email, claimsOrgId, verified };
}

async function requireOrgMember(db, orgId, actor, opts = {}) {
  const requiredRoles = Array.isArray(opts.requiredRoles) ? opts.requiredRoles.map(roleOf) : [];
  const org = toStr(orgId);
  if (!org) {
    const err = new Error("org_required");
    err.statusCode = 400;
    throw err;
  }
  if (!isEmulatorLike() && !actor?.verified) {
    const err = new Error("auth_required");
    err.statusCode = 403;
    throw err;
  }
  if (!toStr(actor?.uid)) {
    if (!isEmulatorLike()) {
      const err = new Error("auth_required");
      err.statusCode = 403;
      throw err;
    }
    if (!roleOf(actor?.role)) {
      const err = new Error("auth_required");
      err.statusCode = 403;
      throw err;
    }
    if (requiredRoles.length && !requiredRoles.includes(roleOf(actor?.role))) {
      const err = new Error("forbidden_role");
      err.statusCode = 403;
      throw err;
    }
    return { role: roleOf(actor?.role), via: "emulator_fallback" };
  }

  if (toStr(actor?.claimsOrgId) && toStr(actor.claimsOrgId) !== org) {
    const err = new Error("org_mismatch");
    err.statusCode = 409;
    throw err;
  }

  const mRef = db.collection("orgs").doc(org).collection("members").doc(toStr(actor.uid));
  const mSnap = await mRef.get();
  if (!mSnap.exists) {
    if (!isEmulatorLike()) {
      const err = new Error("not_org_member");
      err.statusCode = 403;
      throw err;
    }
    const fallbackRole = roleOf(actor?.role);
    if (!fallbackRole) {
      const err = new Error("not_org_member");
      err.statusCode = 403;
      throw err;
    }
    if (requiredRoles.length && !requiredRoles.includes(fallbackRole)) {
      const err = new Error("forbidden_role");
      err.statusCode = 403;
      throw err;
    }
    return { role: fallbackRole, via: "emulator_fallback" };
  }

  const role = roleOf((mSnap.data() || {}).role);
  if (requiredRoles.length && !requiredRoles.includes(role)) {
    const err = new Error("forbidden_role");
    err.statusCode = 403;
    throw err;
  }
  return { role, via: "membership" };
}

module.exports = {
  resolveActor,
  requireOrgMember,
  isPrivileged,
};
