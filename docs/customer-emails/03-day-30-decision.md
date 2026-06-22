# Email 03 — Day-30 Decision (calendar invite + agenda)

Sent ~3 days before the Day-30 decision call. This is NOT a "here's the outcome" email — it's the meeting invite that sets up the founder-led decision conversation.

**Placeholders to replace:**
- `{{customerFirstName}}` — admin's first name
- `{{customerOrgName}}` — customer's organization name
- `{{recordCount}}` — total records captured (any status)
- `{{acceptedCount}}` — `customer_accepted` records
- `{{recoveryCount}}` — open or recovered cases (sum)
- `{{founderName}}` — founder's name (they're on the call)
- `{{csName}}` — your name
- `{{meetingTime}}` — proposed meeting slot

---

## Subject

```
PeakOps pilot — 30-day decision call ({{meetingTime}})
```

## Body

```
Hi {{customerFirstName}},

It's been about 30 days since {{customerOrgName}} stood up your
PeakOps workspace. Time to talk about what's next.

I'm setting up a 60-minute call with you and {{founderName}}
(PeakOps founder). Calendar invite coming separately. The goal of
this call is to make a clear decision together: extend the pilot,
expand it, convert to paid, or pause.

Here's what your workspace currently shows:

  • {{recordCount}} total records captured
  • {{acceptedCount}} accepted by your customer-side reviewers
  • {{recoveryCount}} recovery cases (rejections we tracked
    through to resolution)

I'll bring a more detailed breakdown to the call. Before the call,
I'd ask you to think through three things:

  1. Did this pilot prove out what you wanted to prove out?
     (Refer back to the success criteria we agreed on at Day 0.)

  2. Where did it break or confuse your team? What would you
     change about the workflow, the proof checklist, the customer
     review flow, or anything else?

  3. If we were to extend this pilot, would it stay the same scope
     (one workflow, one crew) or expand?

We'll decide together. No prep document required from you —
showing up with these questions in your head is enough.

Calendar invite for {{meetingTime}} arriving shortly. Reply if that
time doesn't work and I'll find a better slot.

— {{csName}}
```

---

## Founder's portion of the call (not in the email — internal-only)

The founder runs the actual decision conversation. The CS person attends, takes notes, and updates the customer-pilot-log afterward.

Founder's agenda template:

```
1. Greeting + thank-you (2 min)
2. CS recaps quantitative data (5 min)
3. Customer reflects on the three questions in the email (15 min)
4. Founder asks the hard questions (15 min):
   - "What would you tell another contractor about us?"
   - "What stopped you from using us for [adjacent workflow]?"
   - "What's the price point at which this becomes obviously
      worth it for you?"
5. Decision discussion (15 min):
   - Extend pilot: another 30 days, same scope, free
   - Expand pilot: add second workflow / more teammates, still free
   - Convert: paid contract; founder owns the commercial terms
   - Pause: clear handshake on what would bring them back
6. Capture next checkpoint + actions (8 min)
```

---

## Notes for the CS person

- **Send this email 2-3 days before the proposed call**, not the day-of. Customers need a beat to mentally prepare.
- **Send the calendar invite as a separate event**, not embedded in the email. Calendars sync; long emails get buried.
- **Don't pre-suggest an outcome.** "Let's discuss extending" already biases the conversation. The four options should sound equally available.
- **If the customer has zero or near-zero records (`{{recordCount}}` < 3)**, the Day-30 call usually becomes a pause-or-troubleshoot conversation. Flag this to the founder before the call so they're ready for that framing.
- **After the call**, update the customer-pilot-log with the outcome, next checkpoint date, and one-sentence summary of why.
