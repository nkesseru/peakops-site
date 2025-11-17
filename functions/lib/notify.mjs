/**
 * notify.mjs — Unified notifier for Slack, SendGrid, Outlook
 */
import fetch from 'node-fetch';

const SLACK_URL   = process.env.SLACK_WEBHOOK_URL || '';
const SG_KEY      = process.env.SENDGRID_API_KEY  || '';
const SG_FROM     = process.env.EMAIL_FROM        || '';
const SG_TO       = process.env.EMAIL_TO          || '';
const OUTLOOK_SMTP = process.env.OUTLOOK_SMTP     || '';
const OUTLOOK_USER = process.env.OUTLOOK_USER     || '';
const OUTLOOK_PASS = process.env.OUTLOOK_PASS     || '';

export async function sendSlack(text) {
  if (!SLACK_URL) return { ok:false, reason:'slack_missing' };
  try {
    const r = await fetch(SLACK_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text})
    });
    return { ok:r.ok, status:r.status };
  } catch (e) { return { ok:false, error:String(e) }; }
}

export async function sendEmail({ subject, text, attachmentBase64=null, filename='digest.pdf' }) {
  if (!SG_KEY || !SG_FROM || !SG_TO) return { ok:false, reason:'sendgrid_env_missing' };
  const payload = {
    personalizations: [{ to: SG_TO.split(',').map(e=>({email:e.trim()})) }],
    from: { email: SG_FROM },
    subject,
    content: [{ type:'text/plain', value: text }]
  };
  if (attachmentBase64)
    payload.attachments = [{ content: attachmentBase64, filename, type:'application/pdf', disposition:'attachment' }];
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:'POST',
      headers: {
        'Authorization': `Bearer ${SG_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    return { ok:r.ok, status:r.status };
  } catch (e) { return { ok:false, error:String(e) }; }
}

/**
 * Channel-agnostic notify()
 */
export async function notify({ subject, text, attachmentBase64=null, filename='digest.pdf' }) {
  // Slack first
  if (SLACK_URL) {
    const s = await sendSlack(`${subject}\n${text}`);
    if (s.ok) return { channel:'slack', ...s };
  }
  // SendGrid fallback
  if (SG_KEY && SG_FROM && SG_TO) {
    const e = await sendEmail({ subject, text, attachmentBase64, filename });
    if (e.ok) return { channel:'email', ...e };
  }
  // Outlook SMTP stub (optional future)
  return { ok:false, reason:'no_channel_configured' };
}
