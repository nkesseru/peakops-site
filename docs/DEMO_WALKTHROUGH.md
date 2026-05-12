# PeakOps Demo Walkthrough — Live Production Playbook

**Audience:** Operator running a buyer / investor / pilot demo against `https://app.peakops.app`.
**Companion to:** `DEMO_CHECKLIST.md` (local-emulator demo setup). This doc is for the *live production* walkthrough.

Last verified: 2026-05-12, deploy `dpl_m6r923hg9` and successors.

---

## Pre-demo (60 seconds)

1. Sign in as `nicholaskesseru@gmail.com` on `https://app.peakops.app`.
2. Hard-refresh (`Cmd-Shift-R`) on the Jobs page — picks up any new claim / branding state.
3. Confirm all four canonical Summary URLs return HTTP 200:

   ```
   /incidents/inc_20260508_121451_acnew0/summary?orgId=peakops-internal-alpha
   /incidents/inc_20260511_205431_773c1b/summary?orgId=peakops-internal-muni
   /incidents/inc_20260511_205446_c6bf95/summary?orgId=peakops-internal-utility
   /incidents/inc_20260512_144713_340a05/summary?orgId=peakops-internal-contractor
   ```

4. Know the buyer's industry. Lead with their industry; the other three are supporting "and we flex to your adjacencies" beats.

---

## The opening line (10 seconds)

> "PeakOps turns field work into audit-ready records. One field person captures photos and notes, supervisor approves, the system produces a signed downloadable report. Let me show you what that looks like for your industry."

Then jump straight to the buyer's industry Summary URL.

---

## The story arc (5–10 minutes)

1. **Mission Control** (Jobs index) for the buyer's industry — show the industry-specific subhead + filing hint + Closed-state row.
2. **Click the closed incident** → Summary loads.
3. **Walk top-to-bottom** through the Summary header → Audit Trail → Field Evidence → Field Notes → Tasks. ~60 seconds.
4. **Click `Download Report`** → real signed ZIP downloads. Show the cryptographic hash.
5. **Click `Print / Save PDF`** → browser print preview. "Same source of truth, three artifact forms — in-app, ZIP, PDF."
6. **Swap industries** to show the same chrome flexing across telecom / muni / utility / contractor.
7. **Close with:** *"Four industries, one operational system. Your workflow templates, your audit trails, your branded reports — already running, in production, today."*

---

## Per-industry talking points

### Telecom — Fiber splice verification

- **URL:** `https://app.peakops.app/incidents/inc_20260508_121451_acnew0/summary?orgId=peakops-internal-alpha`
- **Buyer profile match:** telco operators, ISPs, OSP / fiber contractors.
- **Lead with:** *"TELECOM FIELD RECORD"* eyebrow + NORS/DIRS-style intro.
- **Visual story:** real photo, real 5-hour lifecycle, real peakops logo in the header.
- **Talking point:** *"If your team already documents OTDR sweeps and splice verifications, this is what those records look like in PeakOps — and how they leave your team's hands."*
- **Audit trail beat:** ~5 hours from arrival to close, with the supervisor approving in the evening. Reads as real shift-to-shift work.

### Municipality / Public Works — Stormwater inspection

- **URL:** `https://app.peakops.app/incidents/inc_20260511_205431_773c1b/summary?orgId=peakops-internal-muni`
- **Buyer profile:** city public works, county DOT, signal / stormwater agencies, contractor-oversight teams.
- **Lead with:** *"PUBLIC WORKS OPERATIONS RECORD"* eyebrow + "structured for public records, contractor oversight, and audit-ready documentation."
- **Visual story:** PW monogram in the header. Routine-inspection narrative — sediment %, vactor recommendation, pedestrian-safety cones.
- **Talking point:** *"Routine catch-basin inspections, signal repairs, road damage — every one closes audit-ready, on the area route schedule, ready for a public records request."*
- **Audit trail beat:** morning route, supervisor reviewed end-of-day in batch. ~4h18m total.

### Utility Operations — Outage response

- **URL:** `https://app.peakops.app/incidents/inc_20260511_205446_c6bf95/summary?orgId=peakops-internal-utility`
- **Buyer profile:** investor-owned utilities, co-ops, ops centers, vegetation / safety teams.
- **Lead with:** *"UTILITY OPERATIONS RECORD"* eyebrow + "structured for infrastructure tracking, operational review, and restoration documentation."
- **Visual story:** UO monogram. Outage-restoration narrative — SCADA confirmation, lockout/tagout, conductor replacement, AMI ping recovery.
- **Headline detail:** the Audit Trail timestamps align with the Field Notes narrative — 06:42 outage reported, 09:18 restored. **Open the notes paragraph and the Audit Trail side-by-side.** Buyers notice this immediately.
- **Talking point:** *"Every restoration tells the same story — time of outage, response, cause, restoration. PeakOps documents that automatically, in the operator's own vocabulary."*

### Infrastructure Contractor — Job closeout verification

- **URL:** `https://app.peakops.app/incidents/inc_20260512_144713_340a05/summary?orgId=peakops-internal-contractor`
- **Buyer profile:** infrastructure contractors, GCs, multi-customer field crews.
- **Lead with:** *"CONTRACTOR FIELD RECORD"* eyebrow + "structured for proof of work, client review, and project closeout documentation."
- **Visual story:** IC monogram. Closeout walkthrough narrative — punch list cleared, change order #3 verified, safety walkaround signed, client handoff packet packaged.
- **Talking point:** *"Your project closeouts become client-ready handoff packets in one click. Photos, punch-list closeout, change-order field records — packaged, signed, ready to send."*
- **Audit trail beat:** half-day closeout — 08:00 arrived, 12:30 closed. Reads as a real project-close morning.

---

## Buttons worth clicking during the demo

| Button | Lives on | What it proves |
|---|---|---|
| **Download Report** | Summary header | Real signed ZIP downloads via the canonical export pipeline. Open it — REPORTS/ HTML, photos, manifest, sha256. |
| **Print / Save PDF** | Summary header | Same record renders as a clean white-bg paper artifact. Buttons + transient banners hidden; sections never split mid-page. |
| **Regenerate** | Summary header (admin only) | Bumps `reportRevision` and writes a new history entry. Demonstrates the immutable revision chain. |
| **Onboarding Ready step** | `/onboarding?orgId=<org>` | Industry-specific recap card + premium "Your operational workspace is ready" hero. Shows PeakOps reflecting the buyer's plan back to them. |
| **Start Job** | Mission Control | Industry-aware chips (Splice / Stormwater / Outage / Closeout per industry) + placeholder. **Cancel without submitting** during demos to avoid creating throwaway data. |

---

## Visual / copy gotchas to know

- **muni / utility / contractor logos are SVG monograms.** Quick + intentional. If a buyer asks "can we replace that?" — yes, drop a PNG/JPG into Settings → Organization, the 48×48 slot updates immediately. Alpha already shows what a real uploaded PNG looks like.
- **Telecom alpha's notes mention `Internal Alpha`** in the title (`Fiber splice verification — Internal Alpha Test`). For external buyers, the muni / utility / contractor demos lead more cleanly. Lead with one of those three unless the buyer is specifically telco.
- **Audit Trail times are in the org's Los_Angeles timezone.** If a buyer asks about timezone, mention it's per-org configurable (it is — `orgs/{org}.timezone`).
- **Generate Report button** is hidden when `packetMeta.status="ready"` already. All four demos are pre-baked, so buyers only see Download Report + Regenerate + Print. Good. If you ever see "Generate Report" on muni / utility / contractor again, re-run `node scripts/generateDemoReport.cjs --kind=<kind> --apply`.

---

## Screenshots worth capturing (for decks, marketing, pitches)

Top 7 shots in priority order:

1. **Closed Summary header (telecom alpha)** — full peakops logo + TELECOM FIELD RECORD + Closed pill + meta line. The single "what PeakOps is" hero shot.
2. **Print / PDF preview** of the same Summary — sells "shareable artifact, no login required."
3. **Mission Control (industry of choice)** — industry-aware subhead + filing hint + one Closed row. Sells the day-to-day surface.
4. **Onboarding Ready step recap card** — premium "YOU'RE LIVE" eyebrow + per-industry recap. Sells "tailored, not generic."
5. **Side-by-side montage of all four Summary headers** — telecom + muni + utility + contractor. Sells "we're not just one vertical."
6. **Audit Trail close-up (utility, with the 06:42 / 09:18 alignment visible)** — sells "documented chain of custody that matches the field narrative."
7. **Settings → Organization branding card (alpha, with logo on file)** — sells white-label readiness.

---

## What's intentionally NOT in this demo (yet)

- Real-time field-app capture (separate slice; planned).
- Multi-user invite flow (works in Settings → Team but adds confusion to a 10-minute demo).
- Logo upload through Settings → Organization for muni / utility / contractor (works — but the SVG monograms already loaded look intentional; skip unless the buyer specifically asks about white-label).
- Per-org custom domains (`muni.peakops.app`, etc.) — works conceptually via Vercel domain aliasing, not wired yet.

---

## If something looks wrong mid-demo

| Symptom | Fast fix |
|---|---|
| Closed pill wraps to its own line awkwardly | Already fixed in Closed Pill Wrap Polish 1.0.1. If you see it, hard-refresh. |
| Logo slot empty on muni / utility / contractor | Re-run `node next-app/scripts/uploadDemoBranding.cjs --apply`. |
| Audit trail timestamps don't match Field Notes | Re-run `node next-app/scripts/polishDemoTimelines.cjs --kind=<kind> --anchorAt=<iso> --apply` then regenerate. |
| Download Report 403/404 | Click Regenerate once — produces a fresh packetMeta. |
| Console error about claim or 403 on /api/fn/* | Sign out + back in; the Claim Access Hardening retry usually masks it, but a token reset is the fastest fix. |
| Anything else | The four bootstrap + seed + generate scripts in `next-app/scripts/` are idempotent. Worst case: delete the org's `source: "demo-artifact-seed"` incident, re-run the 5-step seed sequence. |

---

## Closing line (10 seconds)

> "Four industries, one platform. Today. Closed records, signed reports, printable PDFs, branded headers — all from the same source of truth. Your team's work, structured for the audit that comes after."

Then: silence. Let the buyer ask the first question.
