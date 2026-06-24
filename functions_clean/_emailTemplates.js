// PR 134B — Inline email templates for activation flows.
//
// Mirrors the human-facing copy in docs/customer-emails/01-welcome.md
// (Chunk 3B-2) for the machine-sent path. We intentionally do NOT
// load the .md file at runtime — Cloud Functions cold-start cost +
// keeping the templates flat makes them easier to audit. The drift
// guard at scripts/dev/test_pr134b_email.mjs verifies the placeholder
// shape matches the documented contract.

function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Welcome / first-login email for the org owner created by createOrgV1.
 * Sent on activation (CS-pipeline path).
 */
function welcomeOwnerEmail({ ownerName, orgName, firstLoginUrl, orgId, csName, csEmail }) {
  const subject = `Welcome to PeakOps — your ${orgName} workspace is ready`;
  const greet = ownerName ? `Hi ${_esc(ownerName)},` : `Hi,`;
  const text = [
    greet,
    "",
    `Your PeakOps workspace for ${orgName} is set up and waiting for you.`,
    "",
    "Click the link below to choose a password and sign in:",
    firstLoginUrl,
    "",
    "Once you're in, you'll land on the dashboard with a setup-status card showing the starter template that's ready for your first field record, plus any teammates we've already invited on your behalf.",
    "",
    orgId ? `Org ID (for support reference): ${orgId}` : "",
    "",
    csName ? `If you have any questions, just reply to this email.\n\n— ${csName}${csEmail ? `\n  ${csEmail}` : ""}` : "If you have any questions, just reply to this email.",
  ].filter(Boolean).join("\n");

  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
  <p>${greet}</p>
  <p>Your PeakOps workspace for <strong>${_esc(orgName)}</strong> is set up and waiting for you.</p>
  <p style="margin:24px 0;">
    <a href="${_esc(firstLoginUrl)}" style="background:#000;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:600;display:inline-block;">
      Choose your password &amp; sign in
    </a>
  </p>
  <p style="font-size:13px;color:#444;">Once you're in, you'll land on the dashboard with a setup-status card showing the starter template that's ready for your first field record, plus any teammates we've already invited on your behalf.</p>
  ${orgId ? `<p style="font-size:12px;color:#888;">Org ID (for support reference): <code>${_esc(orgId)}</code></p>` : ""}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:13px;color:#444;">If you have any questions, just reply to this email.</p>
  ${csName ? `<p style="font-size:13px;color:#444;">— ${_esc(csName)}${csEmail ? `<br><a href="mailto:${_esc(csEmail)}" style="color:#444;">${_esc(csEmail)}</a>` : ""}</p>` : ""}
</body></html>`;

  return { subject, text, html };
}

/**
 * Teammate invite email sent by inviteOrgMemberV1.
 */
function inviteTeammateEmail({ teammateName, orgName, role, magicLink, inviterName }) {
  const subject = `${inviterName ? `${inviterName} ` : ""}invited you to ${orgName} on PeakOps`;
  const greet = teammateName ? `Hi ${_esc(teammateName)},` : `Hi,`;
  const roleLine = role ? `You've been added as a ${role}.` : "";
  const text = [
    greet,
    "",
    `${inviterName || "Your team admin"} added you to ${orgName} on PeakOps. ${roleLine}`,
    "",
    "Click the link below to choose a password and sign in:",
    magicLink,
    "",
    "Once you're in you'll land on the dashboard for your team's field records.",
    "",
    "If you weren't expecting this email, you can safely ignore it — no account is created until you click the link.",
  ].filter(Boolean).join("\n");

  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
  <p>${greet}</p>
  <p>${_esc(inviterName || "Your team admin")} added you to <strong>${_esc(orgName)}</strong> on PeakOps. ${_esc(roleLine)}</p>
  <p style="margin:24px 0;">
    <a href="${_esc(magicLink)}" style="background:#000;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:600;display:inline-block;">
      Choose your password &amp; sign in
    </a>
  </p>
  <p style="font-size:13px;color:#444;">Once you're in you'll land on the dashboard for your team's field records.</p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:12px;color:#888;">If you weren't expecting this email, you can safely ignore it — no account is created until you click the link.</p>
</body></html>`;

  return { subject, text, html };
}

module.exports = { welcomeOwnerEmail, inviteTeammateEmail };
