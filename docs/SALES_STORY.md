# PeakOps — Sales Story & Demo Deck 1.0

**Core positioning:**
> **PeakOps turns field work into audit-ready operational records in real time.**

Operational vocabulary. No AI claims. No generic SaaS language. The product is already in production; this doc captures the words and structure to sell what's actually there.

Companion to `DEMO_WALKTHROUGH.md` (live demo playbook). This doc is for the **narrative around** the demo — slides, talk tracks, objection handling, positioning.

---

## 1. The 10-slide deck

Each slide carries **one idea**. Title says it. Body confirms it. Visual is the proof.

| # | Slide title | Body (one line) | Visual |
|---|---|---|---|
| 1 | **Field work, audit-ready.** | *"PeakOps turns field activity into structured operational records, in real time."* | Hero shot: closed Summary page for the buyer's industry. |
| 2 | **The records most field teams don't have.** | *"Photos in someone's phone. Notes in a notebook. Six months later, no one can answer 'what happened that day.'"* | Photo of a cluttered crew truck dashboard / notebook stack / phone gallery. |
| 3 | **What PeakOps is.** | *"A field-to-record system. Capture in the field. Approve in the office. Produce a signed report at close."* | The four-step diagram — Field capture → Supervisor approval → Audit trail → Signed packet. |
| 4 | **A complete record, every time.** | *"Industry-aware header. Real evidence. Field notes in their own language. Per-task proof of work. Full audit trail."* | Walk-through of one Summary's section structure (annotated). |
| 5 | **One platform. Four industries. Live today.** | *"Telecom · Public Works · Utility Operations · Infrastructure Contractor. Each with its own vocabulary, workflows, and report eyebrow."* | Four-up screenshot grid: each industry's Summary header side-by-side. |
| 6 | **The audit trail.** | *"Every event timestamped. Every actor recorded. Chronological. Immutable. The chain of custody from arrival to close."* | Zoomed Audit Trail section (utility — where the 06:42 → 09:18 sequence matches the field notes). |
| 7 | **Three artifact forms. One source of truth.** | *"In-app record. Downloadable signed ZIP. Browser-printed PDF. Same data, three shapes, however the next reader wants it."* | Side-by-side: in-app screenshot, ZIP file icon with sha256, print-preview screenshot. |
| 8 | **What it isn't.** | *"Not a CRM that grew a field bolt-on. Not a checklist app. Not a document graveyard. It's the operational record system built for the moment the work happens."* | (No visual — let the contrast speak.) |
| 9 | **Production. Now.** | *"Running today at app.peakops.app. Four industry modes. Real lifecycles. Real reports. Ready for pilot."* | Bare URL + a small "production" status indicator. |
| 10 | **The pilot.** | *"30-day operational pilot. One incident type. One crew. One supervisor. We'll have you running closed-loop records in week one."* | Calendar / handshake / contract iconography. CTA + contact. |

**Slide 8 is the most important slide.** It defines the category by contrast. Without it the audience pattern-matches to "another workflow tool" and tunes out.

---

## 2. Founder-led demo talk track

### Short form (3 minutes)

> *"PeakOps is a field-to-record system. A field crew captures the work — photos, notes, location — as it happens. A supervisor reviews and approves. The system produces a signed, downloadable record at close."*
>
> *[Open the buyer's industry Summary]*
>
> *"This is what one of those records looks like. Industry-specific eyebrow at the top — your team's vocabulary. The lifecycle is right here — arrived on site at this time, captured these photos, completed the work, sent it to the supervisor for review, supervisor approved, then closed. Every event has a timestamp and an actor."*
>
> *[Click Download Report]*
>
> *"This is the signed ZIP. Photos, audit trail, notes, all packaged with a cryptographic hash so the next reader knows it hasn't been tampered with."*
>
> *[Click Print / Save PDF]*
>
> *"Same record, browser-printable PDF. Hand it to a client, an auditor, a board member. No login required."*
>
> *"That's the loop. Capture in the field. Approve in the office. Audit-ready record at close. We do that today for four industries — telecom, public works, utility operations, and infrastructure contractors. The vocabulary changes; the loop is the same."*

### Long form (10 minutes)

Add between the loop walkthrough and the close:

- **Industry swap** (Slide 5 / DEMO_WALKTHROUGH "swap industries" beat) — 60 seconds showing the same chrome flexing.
- **Audit Trail close-up on utility** — 60 seconds pointing at the 06:42 / 09:18 alignment between the Field Notes paragraph and the Audit Trail timestamps. *"If your operations center is asked to reconstruct a restoration timeline six months later, this is what 'reconstruct' looks like in PeakOps. Read the notes, look at the trail. Same story, no missing pieces."*
- **Onboarding Ready recap** — 30 seconds on `/onboarding?orgId=<industry>`. *"This is what your operator sees five minutes after they sign up. We reflect their plan back to them — their industry, their starter workflow, their first job. The vocabulary is already theirs."*
- **Settings → Organization branding** — 15 seconds. *"Your logo. Your color. Your name on every record."*

---

## 3. Investor narrative

Frame: **infrastructure has an operational-memory problem, and the people who feel it most aren't engineers, they're the supervisors and the auditors.**

**Three beats, in order:**

1. **The problem is invisible until it's expensive.**
   *"Every utility, contractor, and municipality has the same hidden cost: when something happens in the field, the record of it lives in one person's head, one phone's gallery, one notebook. When an outage is reviewed, a project is audited, a contract is disputed — that record either exists or it doesn't. Right now, mostly, it doesn't."*

2. **Why now.**
   *"Field crews already carry smartphones. Supervisors already need audit trails for FERC, NORS/DIRS, FEMA, council, and client. The capture loop and the regulatory loop both exist. What hasn't existed is a single system that closes them. PeakOps closes them."*

3. **Why us.**
   *"We built this against four real industries from the start — telecom, utility, public works, contractor — not one and pivoted. Each industry has its own vocabulary, workflow templates, and report framing built in. The same product walks into a telco closet, a city DOT, a utility ops center, and a GC's project trailer, and reads as native in each one."*

**Investor traction signals to lead with:**

- Production live, four industry modes, real demos at `app.peakops.app` (not a slideware product).
- Closed end-to-end lifecycle: create → arrive → capture → approve → close → signed report → download → print.
- Operator-grade audit trail with cryptographic packet signing (sha256 + revision history per export).
- White-label-ready (org logo upload landed). Multi-tenant with strict org isolation (Firestore rules enforce membership + role on every read/write).

**What to avoid in investor pitch:** *"AI-powered," "transforms," "revolutionizes," "platform play," "OS for X."* PeakOps doesn't need those words. The operational record story is enough.

---

## 4. Pilot customer narrative

Frame: **30 days, one workflow, one crew, one supervisor.** Low risk to start, immediate compounding once it sticks.

### The pilot offer

> *"30-day operational pilot. Pick one workflow your team already runs — splice verification, catch basin inspection, outage response, project closeout. We'll have you capturing the first records in the field within a week. By the end of 30 days you'll have a stack of audit-ready records, a signed report packet for every one, and your supervisors will know in their hands whether the loop works for you."*

### What we set up (pilot week one)

1. Stand up the buyer's org on PeakOps (~1 hour with their admin).
2. Configure their industry mode + their one workflow template.
3. Brand it with their logo.
4. Onboard 1 field user + 1 supervisor.
5. Run one real workflow end-to-end with them.

### What success looks like (pilot day 30)

- 20+ closed records in their org.
- 100% of records have a signed ZIP available.
- Supervisor can pull any record by name in under 10 seconds.
- One auditor / client / board member has been handed a printed PDF from PeakOps.
- Decision point: extend to a second workflow, second crew, or pause.

### The pilot's emotional promise

> *"By day 30, you should never want to go back to text threads and Dropbox folders for this kind of work."*

---

## 5. Strongest screenshots / pages to capture

Priority order. Each shot earns its place by what it proves.

| # | Shot | What it proves |
|---|---|---|
| 1 | Telecom alpha Summary — closed, with real peakops logo + real photo + the full audit trail visible | "This is what one closed record looks like" — the single anchor shot |
| 2 | Print / PDF preview of the same Summary | "Shareable, no login required" — the most universally-understood artifact |
| 3 | Four-up Summary header montage (telecom · muni · utility · contractor) | "Not just one industry" — defends the category |
| 4 | Audit Trail close-up (utility) with the 06:42 / 09:18 narrative alignment visible | "Chain of custody that matches the field reality" |
| 5 | Mission Control (any industry) with the industry-aware subhead + filing hint + one Closed row | "Operational day-to-day surface" |
| 6 | Onboarding Ready recap card (any industry) | "Tailored to your team, not generic" — sells the onboarding moment |
| 7 | Settings → Organization branding card (alpha — logo on file) | White-label readiness, customer-trust framing |
| 8 | The signed ZIP — opened in Finder/Explorer showing REPORTS/, photos/, manifest.json, sha256 | "Forensically clean handoff" — the auditor / compliance shot |

For the website + deck, **shots 1, 2, and 3 carry most of the weight.** Everything else is supporting evidence.

---

## 6. Key "aha moments"

These are the specific seconds during the demo where buyer eyes change. Engineer the demo to hit at least three.

| Aha | Where it happens | Why it lands |
|---|---|---|
| **"That's our vocabulary, not yours."** | First time the eyebrow loads (`PUBLIC WORKS OPERATIONS RECORD`, etc.) | The buyer expected generic software; they got their own internal language reflected back. |
| **"The audit trail matches the notes."** | When you open utility's Field Notes ("outage at 06:42, restored at 09:18") next to the Audit Trail (timestamps 06:58 → 09:18) | Most field tools have data in one place and narrative in another. PeakOps has both, and they agree. |
| **"That's a real ZIP I can hand to my auditor."** | Click Download Report, open the file, scroll the audit HTML, point at the sha256 | Buyers have been handed marketing-grade exports before. This is operational-grade — the ZIP is signed and the contents are forensically clean. |
| **"You're not asking us to change how we work."** | When you walk the Onboarding Ready recap and the buyer sees their own workflow templates listed | The fear is "another system to learn." PeakOps's positioning is "the structure your team already wants — captured." |
| **"It's already running."** | Showing them the real production URL bar (`https://app.peakops.app/incidents/...`) and the real lifecycle timestamps | Buyers expect software demos to be staged. This one isn't — the demo orgs are running on the same production code path their pilot will use. |

If you only get one aha, make it the third one — **"a real ZIP I can hand to my auditor."** It re-anchors PeakOps from "another field tool" to "operational evidence system" in one beat.

---

## 7. Objection handling

| Objection | Tight answer |
|---|---|
| *"We already use [Procore / Fulcrum / FieldEdge / SOSi / etc.]"* | *"Those tools were built for a different problem — sales pipeline, CRM, dispatch, billing. PeakOps is the record layer that sits next to those tools. We've designed it to coexist, not compete. You can still run your dispatch system; we capture the operational record."* |
| *"We already use SharePoint / Drive / Dropbox for photos."* | *"And six months from now, can your supervisor find the inspection photos for catch basin CB-12 in under 10 seconds, with the audit trail of who took them and when? PeakOps is the answer when 'we have the photos somewhere' isn't good enough."* |
| *"AI / automation / machine learning?"* | *"We don't lead with AI. The product earns its trust by being deterministic — every event has a real timestamp, a real actor, a real cryptographic hash on the export. We'll add intelligent assists where they add operational value, not as a marketing layer."* |
| *"Will it work offline in the field?"* | *"The capture surface is browser-based today and works in the patchy-connection environments most field crews face. Offline-first capture is on the roadmap; if it's a pilot blocker for you, let's talk about timing."* |
| *"How long to roll out?"* | *"One week to first records. Thirty days to operational rhythm. Three months to feeling like 'how did we work before this?' — assuming you pick one workflow to start. We've engineered the onboarding to be that fast."* |
| *"What about [compliance regime: SOC 2 / HIPAA / FERPA / FERC]?"* | *"PeakOps is built on Google Cloud / Firebase infrastructure with strict org isolation in the rules layer. We're not yet certified on [regime] — if it's a hard requirement for your pilot, let's discuss timing or scoped paths to attestation."* |
| *"Pricing?"* | *"Per-org. We don't price by feature tier — every org gets the full operational surface from day one. Let's talk about your team size and workflow volume; we'll quote a 30-day pilot fee and a 12-month roll-on rate."* |
| *"Who else is using it?"* | If true: name pilots / customers. If pre-pilot: *"You'd be among the first operational pilots. We've built against four real industries from the start instead of optimizing for one, which means we'll have your industry's vocabulary ready on day one. The trade-off is you'd be helping us shape the early roadmap — we treat that as a feature, not a risk."* |

---

## 8. Positioning language

### Words and phrases to use

| Use | Why |
|---|---|
| operational record | Concrete, durable, audit-friendly |
| audit-ready | Aligns with regulatory framing operators already know |
| field-to-record | Captures the loop in one phrase |
| chain of custody | Borrowed from evidence vocabulary; operators trust it |
| signed report | "Signed" implies cryptographic + accountable |
| proof of work | The contractor / closeout framing |
| operational memory | The investor-grade framing |
| restoration / outage / closeout / handoff | Industry-native verbs |
| supervisor approval | The hierarchy operators recognize |
| pilot | Low-stakes commitment word |
| one workflow to start | Pilot scope reducer |
| in your team's own vocabulary | The customization promise |

### Words and phrases to avoid

| Avoid | Why |
|---|---|
| AI, ML, intelligent | Hype-laden; PeakOps doesn't need it; raises false expectations |
| transform / disrupt / revolutionize | SaaS-cringe; operators distrust this vocabulary |
| platform / OS | Investor-cringe; doesn't say what we do |
| seamless / frictionless / magical | Reads as marketing-only |
| unleash / empower / supercharge | Buzzword soup |
| workflow software | Concedes the category to competitors; we're a record system that has workflow |
| dashboard / single pane of glass | Doesn't describe PeakOps; we're not a viz tool |
| collaboration / engagement | Wrong frame; this isn't team-chat software |
| visibility / transparency | Vague; "audit trail" + "signed packet" is the specific version |

---

## 9. Website-level headline candidates

Ranked by precision + how much they earn in a single glance.

1. **Field work, audit-ready.** *(Tight. Operational. Suggests the loop without explaining it. Best for the hero block.)*
2. **The operational record system for field-first organizations.** *(Defines the category. Best for an investor / partner page.)*
3. **Capture the work. Sign the record. Hand it to whoever asks next.** *(Three-beat. Best for a follow-on sub-hero.)*
4. **Your field work, structured for the audit that comes after.** *(Honest about the motivation. Best for a customer-stories page.)*
5. **From the field, to the supervisor, to the signed record.** *(The lifecycle in one line. Best for a "how it works" page header.)*
6. **PeakOps. Where field work becomes operational evidence.** *(Tagline form. Best as a footer / business-card line.)*
7. **Built for telecom, public works, utility operations, and infrastructure contractors.** *(Industry anchor. Best as a sub-header under (1) or (2).)*

**Recommended primary: #1** on the hero. **#3** as the sub-line. **#7** as the audience anchor below.

---

## 10. CTA structure

Three audiences, three CTAs. Same end-state (real conversation), different on-ramps.

### Buyer CTA — "Start a pilot"

> **Start a 30-day operational pilot.**
> One workflow. One crew. One supervisor. We'll have you running closed-loop records within a week.
>
> [Book a 20-minute discovery call] [Download the pilot scope (PDF)]

What we want from the click: a calendar booking. What we promise: a 20-minute call, no deck — we'll walk the four demo orgs live and ask what their workflow looks like.

### Investor CTA — "See the system"

> **See PeakOps in production.**
> Four industries. Closed-loop lifecycles. Signed reports. No slideware.
>
> [Request access to the live demo] [Send us your fund's thesis]

What we want from the click: an email. What we promise: a 30-minute live walkthrough against the production URLs + a one-page traction summary.

### Partner CTA — "Talk integration / channel"

> **Build with PeakOps.**
> If you sell into telecom, utility, public works, or infrastructure contractors, talk to us about integration points and channel models.
>
> [Get in touch]

What we want: outreach from a related toolmaker / service org. What we promise: a real conversation about API surface and joint deals.

---

## How to use this doc

- Before a buyer demo: skim sections 2, 6, 7.
- Before an investor pitch: read sections 1, 3, 6, 7, 8.
- Before a website / marketing brief: anchor on sections 8, 9, 10.
- Before drafting a sales email: lift language from section 8.
- After any of the above: update this doc with what landed / what didn't.

This is a living artifact. The version with the most demo / pitch / call data captured wins.
