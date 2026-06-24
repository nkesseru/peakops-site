// PR 134B — Minimal transactional email helper for activation magic
// links. Direct fetch to Resend's REST API; no SDK dependency.
//
// Graceful degradation: when RESEND_API_KEY is not configured (local
// dev, CI, demo orgs where real email is undesirable), sendEmail
// returns { ok: false, skipped: true, reason } without throwing. The
// caller (createOrgV1 / inviteOrgMemberV1) records this status in
// the response so the CS person can fall back to the manual
// copy-paste flow without losing visibility.
//
// Required env vars (set via functions_clean/.env.peakops-pilot):
//   RESEND_API_KEY     — Resend API key (https://resend.com)
//   EMAIL_FROM         — "Display Name <address@verified-domain>"
//   EMAIL_REPLY_TO     — optional reply-to address (default = EMAIL_FROM)
//
// Failure is ALWAYS recorded — never thrown. The caller's primary
// outcome (org creation, invite acceptance) must never depend on
// email-delivery success.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function _configured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/**
 * Send a transactional email via Resend.
 *
 * @param {object} args
 * @param {string} args.to                — recipient email
 * @param {string} args.subject
 * @param {string} args.html              — HTML body
 * @param {string} args.text              — plain-text fallback body
 * @param {string} args.tag               — short tag for Resend dashboard / logs
 * @param {object=} args.headers          — optional extra headers
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   deliveryId?: string,
 *   reason?: string,
 *   status?: number,
 * }>}
 */
async function sendEmail({ to, subject, html, text, tag, headers }) {
  if (!_configured()) {
    return {
      ok: false,
      skipped: true,
      reason: "email_not_configured",
    };
  }
  if (!to || !subject || !(html || text)) {
    return { ok: false, skipped: false, reason: "missing_required_fields" };
  }
  const from = String(process.env.EMAIL_FROM || "").trim();
  const replyTo = String(process.env.EMAIL_REPLY_TO || from).trim();

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        ...(headers || {}),
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text,
        reply_to: replyTo,
        tags: tag ? [{ name: "peakops_tag", value: String(tag).slice(0, 64) }] : undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        skipped: false,
        status: res.status,
        reason: String(json?.message || `resend_${res.status}`).slice(0, 200),
      };
    }
    return {
      ok: true,
      deliveryId: String(json?.id || "").slice(0, 64) || undefined,
      status: res.status,
    };
  } catch (e) {
    return {
      ok: false,
      skipped: false,
      reason: String((e && e.message) || e).slice(0, 200),
    };
  }
}

module.exports = { sendEmail, _configured };
