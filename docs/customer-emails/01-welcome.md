# Email 01 — Welcome (Day 1)

Sent by the Customer Success person immediately after running `activateCustomerOrg.cjs --apply`.

**Placeholders to replace:**
- `{{customerFirstName}}` — admin's first name
- `{{customerOrgName}}` — the customer's organization name (e.g. "Butler America Telecom")
- `{{firstLoginUrl}}` — magic link from the activate-script output for this admin's email
- `{{orgId}}` — the slugified org ID (for the customer's reference; rarely needed but helpful for support)
- `{{csName}}` — your name
- `{{csEmail}}` — your reply-to email
- `{{customerSuccessTimezone}}` — your working timezone (so they know when to expect responses)

---

## Subject

```
Welcome to PeakOps — your {{customerOrgName}} workspace is ready
```

## Body

```
Hi {{customerFirstName}},

Your PeakOps workspace is provisioned and ready to use. I'll walk
you through the first record on our Day-3 call (calendar invite
coming separately), but you can sign in any time before then.

→ First-login link (single-use, expires in 1 hour):
{{firstLoginUrl}}

That link signs you in and prompts you to set a password. After
that, sign in normally at https://app.peakops.app.

A few practical notes:

  • Your workspace is set up for a fiber-splice-verification
    workflow with a starter proof checklist (arrival photo, before/
    after, equipment label, GPS confirmation). If your actual work
    needs different proof requirements, we'll customize together on
    the Day-3 call.

  • Your teammates received separate welcome emails with their own
    first-login links. They can sign in whenever they're ready —
    you don't have to wait for them.

  • The customer review flow is token-only — when you send a record
    out for customer signoff, the recipient gets a link that opens
    in any browser, no login required. We'll cover this on Day 3.

  • Lost a link? Tell me and I'll mint you a new one. Don't try to
    pass links around — each one is single-use.

Org ID (you won't usually need this; it's for support reference):
{{orgId}}

I'll check in on Day 7 to see how the first few records are going.
If anything's confusing before then, just reply to this email —
I'm in {{customerSuccessTimezone}} and respond same-day.

Welcome aboard,
{{csName}}
{{csEmail}}
```

---

## Variant for teammates (not the admin)

Same template; lead paragraph changes to:

```
Hi {{teammateFirstName}},

Your administrator at {{customerOrgName}} has invited you to the
PeakOps workspace. Click below to sign in for the first time
(single-use, expires in 1 hour):

{{magicLink}}

After signing in, you'll be set up with the {{role}} role and can
start capturing records right away.

If you weren't expecting this invitation, please reply to this
email — we'll deactivate the invite.

Welcome,
{{csName}}
{{csEmail}}
```

`{{role}}` is one of: `admin`, `supervisor`, `field`, `viewer`. The activate script prints the role next to each teammate's magic link.

---

## Notes for the CS person

- **Send all teammate emails the same day as the admin email.** Don't drip-feed.
- **Don't paste the magic link into Slack / Teams / Discord.** It's single-use and end-to-end on the recipient's email; pasting it elsewhere widens the attack surface.
- **If the customer admin replies "I haven't received the email,"** check the email's spam folder first (Firebase action emails often land there). If still missing, re-run the activate script for just that admin (it's idempotent — won't double-provision).
- **Time-zone hint:** the script's emitted welcome template uses generic copy; this Markdown file is the longer, friendlier version. Use this one for actual customer-facing sends; use the script-emitted one only as a sanity check that the link was generated.
