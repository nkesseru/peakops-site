// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Shared in-app notification fan-out used by exportIncidentPacketV1
// (report_ready) and submitFieldSessionV1 (awaiting_review).
//
// Recipient resolution:
//   - Read orgs/{orgId}/members; pick docs whose role matches
//     `recipientRoles` and whose status is "active" (or absent /
//     legacy — defaults to active).
//   - Member doc id is the user's Firebase Auth uid (real users)
//     or "pending_<...>" (invited placeholders). Pending members
//     can't sign in yet, so they're skipped.
//   - For each real recipient, optionally honor a per-user setting
//     toggle stored at users/{uid}/settings/profile.<settingKey>.
//     Treat missing/undefined as opt-IN; only an explicit `false`
//     suppresses delivery. Matches the team-archive / vendor
//     archive coercion pattern used elsewhere.
//
// Failure mode: a single recipient failure is logged but doesn't
// fail the whole fan-out — one user's misconfigured settings doc
// shouldn't block notifications to everyone else.

const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

function db() { return getFirestore(); }

// Resolve which uids to notify for an org based on member roles.
// Returns an array of uid strings — pending placeholders are
// excluded (they have no settings doc and can't see notifications
// until they sign up anyway).
async function resolveRecipientUids(orgId, recipientRoles) {
  const oid = String(orgId || "").trim();
  if (!oid) return [];
  const rolesAllowed = new Set(
    (Array.isArray(recipientRoles) ? recipientRoles : [])
      .map((r) => String(r || "").toLowerCase())
      .filter(Boolean),
  );
  if (rolesAllowed.size === 0) return [];

  const snap = await db().collection("orgs").doc(oid).collection("members").get();
  const out = [];
  snap.forEach((d) => {
    const id = String(d.id || "").trim();
    if (!id || id.startsWith("pending_")) return;
    const data = d.data() || {};
    const status = String(data.status || "").trim().toLowerCase();
    if (status === "archived") return;
    const role = String(data.role || "").trim().toLowerCase();
    if (!rolesAllowed.has(role)) return;
    out.push(id);
  });
  return out;
}

// Read the user's setting toggle. Missing doc / missing field /
// non-boolean → defaults to true (opt-IN). Only an explicit `false`
// suppresses.
async function userOptedIn(uid, settingKey) {
  if (!uid || !settingKey) return true;
  try {
    const snap = await db().doc(`users/${uid}/settings/profile`).get();
    if (!snap.exists) return true;
    const data = snap.data() || {};
    const v = data[settingKey];
    if (v === false) return false;
    return true;
  } catch {
    // Read failure: don't strand the notification — assume opt-in.
    return true;
  }
}

// PEAKOPS_NOTIFICATIONS_V1_1 (2026-05-05)
// Fan out a single notification payload to:
//   - Org members whose role is in recipientRoles, AND
//   - Any explicit additionalUids (e.g. the incident creator,
//     who may be a `field` user excluded from the role list).
// Deduped automatically — a creator who is also an admin gets
// exactly one notification.
//
// payload: { type, title, message, incidentId, orgId, targetUrl }
// settingKey (optional): when set, each recipient's
//   users/{uid}/settings/profile.<settingKey> must be !== false
//   for the notification to land. additionalUids are subject to
//   the same setting gate — a creator who turned alerts off
//   doesn't receive their own report-ready notification.
//
// PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
// Returns `{ recipients, wrote }` — recipients = unique uids
// resolved (post-dedup, post-pending-skip), wrote = how many
// actually got a doc (post-setting-gate, post-error-skip). Lets
// the caller log both counts for diagnostics. Backward compat:
// callers that previously treated the return as a number can
// keep doing so by reading `.wrote` or by treating the whole
// object as truthy.
async function fanOutOrgNotification({
  orgId,
  recipientRoles,
  payload,
  settingKey,
  additionalUids,
}) {
  if (!orgId || !payload || !payload.type) return { recipients: 0, wrote: 0 };
  const roleUids = await resolveRecipientUids(orgId, recipientRoles);
  const extras = (Array.isArray(additionalUids) ? additionalUids : [])
    .map((u) => String(u || "").trim())
    .filter((u) => !!u && !u.startsWith("pending_"));
  const uniq = Array.from(new Set([...roleUids, ...extras]));
  if (uniq.length === 0) return { recipients: 0, wrote: 0 };

  let written = 0;
  await Promise.all(
    uniq.map(async (uid) => {
      try {
        if (settingKey) {
          const ok = await userOptedIn(uid, settingKey);
          if (!ok) return;
        }
        const ref = db().collection("users").doc(uid).collection("notifications").doc();
        await ref.set({
          type: String(payload.type),
          title: String(payload.title || ""),
          message: String(payload.message || ""),
          incidentId: String(payload.incidentId || "") || null,
          orgId: String(payload.orgId || orgId || "") || null,
          // PEAKOPS_NOTIFICATIONS_V1_1 (2026-05-05)
          // Persist the click-through URL on the doc so the bell
          // doesn't have to recompute routing per type. Older docs
          // without this field still resolve via notificationHref's
          // type-based fallback.
          targetUrl: String(payload.targetUrl || "") || null,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        written += 1;
      } catch (e) {
        // Single recipient failure — log + continue. Surface in
        // dev so a misconfigured rule or settings doc is visible.
        // eslint-disable-next-line no-console
        console.warn("[fanOutOrgNotification] recipient write failed", {
          uid,
          orgId,
          type: payload.type,
          message: (e && e.message) ? e.message : String(e),
        });
      }
    }),
  );
  return { recipients: uniq.length, wrote: written };
}

module.exports = {
  fanOutOrgNotification,
};
