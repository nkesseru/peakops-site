# Email 02 — Day-7 Check-In

Sent on Day 7 of the pilot. **Two variants** depending on whether the customer has captured records. Pick the right one before sending.

**Placeholders to replace:**
- `{{customerFirstName}}` — admin's first name
- `{{customerOrgName}}` — customer's organization name
- `{{recordCount}}` — current count of captured records (any status)
- `{{acceptedCount}}` — number of records that have reached `customer_accepted` (Variant A only; can be 0)
- `{{exampleRecordTitle}}` — title of one of their better-looking records (Variant A only)
- `{{csName}}` — your name
- `{{csEmail}}` — your reply-to

---

## How to count records

Quick CLI count via Firebase Console:
1. Navigate to `https://console.firebase.google.com/project/peakops-pilot/firestore/data/~2Forgs~2F{{orgId}}~2Fincidents`
2. The collection count is shown at the top.

Or via the live dashboard:
```
https://app.peakops.app/dashboard?orgId={{orgId}}
```
Total Records in the KPI strip = `{{recordCount}}`.

---

## VARIANT A — Customer has captured records ({{recordCount}} ≥ 1)

### Subject

```
PeakOps Day-7 check-in — {{recordCount}} records and counting
```

### Body

```
Hi {{customerFirstName}},

Quick check-in at the one-week mark.

What I see in your {{customerOrgName}} workspace:

  • {{recordCount}} records captured so far
  • {{acceptedCount}} accepted by your customer-side reviewer
  • "{{exampleRecordTitle}}" looks like a clean end-to-end example

A few things worth noting at this point:

  1. If anything in the proof checklist isn't matching how your
     crews actually work, we can tune the starter template
     (Required Proof / Optional Proof / Acceptance Criteria) to
     fit your workflow. Just reply with what you'd change.

  2. If your customer-side reviewers are rejecting or asking for
     clarification, the rejection routes into a Recovery case at
     /recovery — let me know if anyone's having trouble finding it.

  3. Day-30 decision call: I'll send a calendar invite next week.
     We'll decide together whether to extend, expand to a second
     workflow, or convert.

Anything blocking you? Reply directly to this email; I respond
same-day.

— {{csName}}
{{csEmail}}
```

---

## VARIANT B — Customer has captured zero records ({{recordCount}} = 0)

### Subject

```
PeakOps — quick check on your first record
```

### Body

```
Hi {{customerFirstName}},

I noticed your {{customerOrgName}} workspace doesn't have any
records yet. That's not unusual at Day 7 — sometimes the first
record is the hardest one to start.

A few common things that block the first capture:

  • Field crew hasn't signed in yet (their magic link expired
    and they're not sure how to ask for a new one) — let me
    know and I'll re-mint.

  • The proof checklist doesn't match your actual workflow and
    crews aren't sure what to upload — we can edit the template
    together on a quick call.

  • Field crew isn't sure whether the system is for them or just
    for supervisors — happy to clarify on a call.

  • They tried and hit something confusing — please send a
    screenshot, even a phone photo of the screen is fine.

Want to schedule a 15-minute call this week to debug? Reply with a
couple of times that work and I'll send an invite.

— {{csName}}
{{csEmail}}
```

---

## Notes for the CS person

- **Variant A is the happy path. Use it for any customer with ≥ 1 record.** Don't overthink which version they "deserve."
- **If `{{acceptedCount}}` is 0 but `{{recordCount}}` ≥ 1**, you can still send Variant A — leave the accepted line in (zero is informative). If the customer has zero records AND zero engagement, switch to Variant B.
- **The `{{exampleRecordTitle}}` line in Variant A is optional polish.** If none of their records have meaningful titles yet (still "Untitled" or similar), drop the line. Don't fabricate.
- **Do not include Day-30 expectations as a hard commitment.** "We'll decide together" is the right framing.
- **Day-14 follow-up is silent** unless the customer is at zero records or you spotted something concerning. The Day-7 + Day-30 emails are the only scheduled customer touches in the playbook.
