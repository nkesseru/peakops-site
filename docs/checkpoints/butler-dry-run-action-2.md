# Butler-Style End-to-End Customer Dry-Run — Action 2

**Date:** 2026-06-23
**Type:** Customer-reality sprint (NOT engineering, NOT enforcement work)
**Scope:** Provision a brand-new throwaway org (NOT `peakops-internal-alpha`) and drive the complete onboarding + operational + compliance + recovery workflow on live `peakops-pilot` as the customer would experience it — using only systems shipped in Chunks 1, 2, 3B-1, 3B-2, and DIRS rulepack v1.1.
**Script:** `scripts/dev/smoke/butler_full_dry_run.mjs` (run 5 of 5 → 0 errors)
**Artifacts:** `/tmp/butler_dryrun_findings_7de7.json`

---

## A. Executive Summary — **YELLOW (lift to GREEN with one entitlement-default change + one CS-runbook update)**

A real telecom prospect resembling Butler America could be **provisioned, activated, taken through a full incident lifecycle, customer-accepted, taken through a rejection-recovery cycle, and re-accepted** on the systems shipped in Chunks 1–3B-2 + DIRS v1.1. Phase 3 (happy path) and Phase 4 (recovery) both ran GREEN end-to-end. Org isolation, claims plumbing, template seeding, customer-token mint, recovery auto-create, recovery auto-resolve, and operator-notification fan-out all functioned correctly.

The system is **not green** because three founder dependencies stand between "org exists in Firestore" and "customer can self-serve":

1. **`riskDefenseModule` entitlement is OFF by default on every new org.** `createOrgV1` does not write a `billing/state` doc and the default-state object returned by `_billing.js` has `entitlements: {}`. The first time the customer admin clicks "Send to Customer for Review" or "Generate Packet," they get `feature_off`. Resolution today requires an internal admin to visit `/admin/orgs/{orgId}/billing` and toggle the feature on. **This is the #1 single blocker between activation and operation.** Neither `docs/CUSTOMER_ACTIVATION_PLAYBOOK.md` nor any of the customer-email templates mentions this step.
2. **Recovery loop is admin-only.** `updateRecoveryCaseV1` requires `ROLES_ADMIN_ONLY`. A supervisor cannot advance a recovery case through `open → in_progress → ready_to_resubmit`. On a 3-person customer team, the most senior person becomes the bottleneck on every reject/recover cycle.
3. **Magic links are out-of-band.** `createOrgV1` and `inviteOrgMemberV1` mint links but don't send email. CS-runnable activation requires a human to copy/paste from script output into the welcome template.

Compliance story: the DIRS v1.1 rulepack now produces real, cited findings, **but** the validator is in `passive_log` mode — meaning a packet can be exported, sent for review, and customer-accepted while missing `affectedCustomers` (a 47 CFR § 4.9 / § 4.11 ERROR-severity field). The end-to-end test produced exactly this outcome: a customer accepted a packet whose DIRS validation said `ok: false`. This is the gap PR 133C exists to close.

**With one small code change** (default `entitlements.riskDefenseModule = true` in `createOrgV1`) and one playbook update, this would move to GREEN for activation + operations. PR 133C remains the right next sprint, but for a different reason than originally framed — see G.

## B. Activation Score — **72 / 100**

| Sub-score | Weight | Score | Notes |
|---|---|---|---|
| Provisioning correctness | 25 | 24/25 | Org doc, members, claims, starter template, Auth users all wired correctly. 17.4s total wall time for a 3-person org. Cross-org isolation enforced. |
| Provisioning ergonomics (CS surface) | 15 | 12/15 | `scripts/activateCustomerOrg.cjs` works. Welcome email template has the right 10 placeholders. -3 for hand-copy of magic links into email. |
| Default entitlements | 20 | 0/20 | **CRITICAL.** New org gets `entitlements={}`. Packet export and customer review link both fail until founder flips `riskDefenseModule`. Activation Playbook silent on this. |
| First-screen experience | 20 | 8/20 | Customer admin lands on empty `/dashboard` with no welcome message, no "starter template ready" callout, no team-invite confirmation, no deep-link to `/onboarding`. The 7-step `/onboarding` wizard exists but is decoupled from `activateCustomerOrg.cjs` state. |
| Team-invite visibility | 10 | 4/10 | Magic links are issued and the claims propagate, but the customer admin has no in-app way to see "who did I invite and have they accepted." |
| Auth + recovery surface | 10 | 8/10 | Firebase action URL pattern works, magic links are well-formed. -2 for lost-link recovery requiring `teamRecoveryV1` or Firebase Console (no UX in app). |

## C. Operational Readiness Score — **78 / 100**

| Sub-score | Weight | Score | Notes |
|---|---|---|---|
| Incident → close lifecycle | 25 | 25/25 | createIncident → createJob → startSession → markArrived → evidence (5 items, signed URLs working) → submitSession → markJobComplete (field) → review (sup) → approve (sup) → close (sup) all GREEN end-to-end. |
| Packet generation | 15 | 13/15 | Packet generated, customer review link issued, customer accept works. -2 because validator state at packet-time is invisible to operator. |
| Customer-side review surface | 15 | 14/15 | Token route works without auth (per Chunk 1+2 UX hotfix). Customer accept and reject both succeed. Operator notifications fan out correctly (admin saw `report_ready`, `customer_review_link_created`, `customer_accepted`). |
| Rejection + recovery lifecycle | 20 | 16/20 | Reject auto-creates recovery case with the right `cause.primary=missing_test_result`. Resubmission link mints. Customer accept on resubmission auto-resolves the case to `recovered` and the incident back to `customer_accepted`. -4 because the recovery loop requires admin role (sup blocked). |
| Job state machine discoverability | 10 | 6/10 | Field uses `markJobCompleteV1`, sup uses `updateJobStatusV1` then `approveJobV1`. The transitions are correct but **undocumented in any customer-facing surface**. A naive API consumer hits `invalid_transition` errors and "open → review not allowed". |
| Role separation correctness | 10 | 8/10 | Field, supervisor, admin all gated correctly. -2 because recovery cases require admin (see C4) and the supervisor's `/admin/orgs/{orgId}/billing` surface requires `peakopsInternalAdmin`. |
| Audit + notification trail | 5 | 4/5 | Notifications fanned out correctly. -1 because `incidents/{id}/timeline_events` returned 0 events to the dry-run reader (likely a path-mirror artifact between legacy `incidents/{id}` and `orgs/{orgId}/incidents/{id}` — not a functional bug, but worth a quick check). |

## D. Compliance Readiness Score — **62 / 100**

| Sub-score | Weight | Score | Notes |
|---|---|---|---|
| Rulepack content quality | 25 | 24/25 | DIRS v1.1: 6 cited rules + 3 evidence requirements, all sourced to specific 47 CFR sections. SME-reviewable. -1 because cross-field threshold math (e.g. 900,000 user-minutes for E911 per § 4.9) is acknowledged out of scope. |
| Rulepack runtime behavior | 15 | 14/15 | Validator executed correctly against both dry-run incidents, returned `ok=false` for both, recorded `rulepackVersion=v1.1`. -1 because the validator's `missingCount` and `missingItemsPreview` in the readiness cache came back undefined (the cache shape may need a small reconciliation). |
| Enforcement (validator mode) | 25 | 5/25 | **Validator is `passive_log`**. The full Phase 4 incident shipped with `affectedCustomers` missing — a CFR § 4.9 ERROR — and the customer accepted it. This is exactly what PR 133C was framed to fix. |
| Required-field gating at packet-time | 15 | 4/15 | `exportIncidentPacketV1` succeeded against an incident with `requirements_missing` readiness state. No gate between "validator says missing" and "packet ships to customer." |
| Operator visibility of findings | 10 | 7/10 | Validator findings written to readiness cache. -3 because there's no proactive surfacing — operator only sees the findings if they navigate to the incident summary. No "you cannot send this to your customer until you fix X" banner. |
| Audit-defensible packet content | 10 | 8/10 | Packet branding now shows customer's org name (Chunk 3B-2) + "powered by PeakOps" footer. -2 because the validator's snapshot at packet-mint time is not embedded in the packet's audit metadata; a regulator opening the packet can't see "this is what PeakOps validated at submission." |

## E. Founder Dependency Report (most important section)

For each step a customer goes through, this lists what only Nick can do today (and what's documented in the Playbook vs. is tribal knowledge).

### CRITICAL (would block a customer from completing the workflow)

| # | Step | What only Nick can do | Documented? | Fix |
|---|---|---|---|---|
| **E1** | New-org entitlement | Set `orgs/{orgId}/billing/state.entitlements.riskDefenseModule = true` — without this, packet export and customer review link both fail with `feature_off`. | ❌ **NOT in Playbook.** Not in welcome email. Not in any UX. Pure tribal knowledge. | Default `riskDefenseModule: true` in `createOrgV1` for pilot orgs (one-line code change). OR add to Playbook Day-0 step. |
| **E2** | Internal-admin claim | Mint the `peakopsInternalAdmin` custom claim on any CS person's account before they can run `activateCustomerOrg.cjs`. | Mentioned in `CUSTOMER_ACTIVATION_PLAYBOOK.md` as a one-time setup. | Acceptable as-is for now — Nick mints the claim once per CS hire. |

### HIGH (Nick is in the loop on every activation, but a competent CS person could do it with the script)

| # | Step | What only Nick can do | Documented? | Fix |
|---|---|---|---|---|
| **E3** | Magic-link delivery | Copy `firstLoginUrl` + per-teammate `magicLink` from `activateCustomerOrg.cjs` output and paste into welcome email. | ✅ Playbook Day-0 step describes this. | Auto-email via a Cloud Function + a simple transactional email service (Resend/Postmark). Not blocking the pilot. |
| **E4** | Lost-link recovery | Run `teamRecoveryV1` callable OR password-reset from Firebase Console. | ⚠️ Mentioned in passing; not in a customer-facing surface. | Add a "Resend my login link" button on the public login page. Calls `teamRecoveryV1`. |
| **E5** | Recovery-case progression | A supervisor cannot work the recovery loop — `updateRecoveryCaseV1` is admin-only. On every reject/recover cycle, the customer's admin (not supervisor) is the bottleneck. | ❌ Not documented anywhere customer-facing. | Lower the gate to `ROLES_SUPERVISOR_OR_HIGHER` — or carefully scope the state transitions a supervisor can make (e.g. open → in_progress yes; → ready_to_resubmit needs admin). Probably the latter. |

### MEDIUM (Nick is in the loop but the customer can wait)

| # | Step | What only Nick can do | Documented? | Fix |
|---|---|---|---|---|
| **E6** | Custom archetypes | Engineering code change to add an archetype + matching template + matching rulepack hooks. | Tribal. | Acceptable as-is for pilot. Beyond pilot, build an "archetypes" admin UI. |
| **E7** | Custom validation rules | Engineering JSON edit to `_complianceRulepacks/*` + functions deploy. | Documented in `dirs-rulepack-v1-1.md`. | Acceptable for now. SME engagement path is the unlock. |
| **E8** | Onboarding wizard ↔ activate-script reconciliation | The 7-step `/onboarding` wizard is decoupled from what `activateCustomerOrg.cjs` writes. The wizard can overwrite admin-set values. | Tribal. | Either: (a) deep-link the welcome email to `/onboarding?from=activation` and pre-fill from the org doc; (b) hide `/onboarding` when the org has already been activated via the script. |

### LOW (rare or out of normal pilot scope)

| # | Step | What only Nick can do | Documented? |
|---|---|---|---|
| **E9** | Validator mode switching (`passive_log` ↔ `block`) | Firestore Console edit on `orgs/{orgId}/config/validation.mode` | Tribal |
| **E10** | Adding a feature key beyond the canonical billing set | Engineering edit to `_billing.js` + `/admin/orgs/[orgId]/billing/page.tsx` | Tribal |

## F. Top 10 Remaining Gaps (ranked by pilot risk)

| Rank | Gap | Severity | Customer Impact | Revenue Impact | Pilot Risk |
|---|---|---|---|---|---|
| 1 | **`riskDefenseModule` OFF by default on new orgs** (E1) | CRITICAL | Customer cannot send any record to their customer for review. Workflow halts at "send to customer" step. | Pilot bricks day-2 if Nick is unavailable for the billing flip. | 🔴 Highest |
| 2 | **Validator in `passive_log` for CFR ERROR-severity fields** (D3) | HIGH | Packets ship missing CFR § 4.9 / § 4.11 required fields; regulator-defensibility weak. | Butler's compliance officer reviews packet, sees missing `affectedCustomers`, asks why PeakOps let it ship. | 🔴 Highest after E1 |
| 3 | **Recovery loop admin-only** (E5) | HIGH | Every reject/recover cycle blocks on the customer's admin. On a small ops team, this is a delay multiplier. | Slow customer ROI realization during pilot. | 🟡 |
| 4 | **No in-product onboarding for the customer admin** (Phase 2) | HIGH | Customer admin lands on empty dashboard; no clear "what do I do next." High first-day confusion. | Pilot stalls if customer doesn't get traction in week 1. | 🟡 |
| 5 | **No in-app team-invite visibility** (Phase 2) | MEDIUM | Customer admin can't confirm whether teammates received/accepted invites. Asks Nick. | Nick fields support questions during pilot. | 🟡 |
| 6 | **`/onboarding` wizard decoupled from activate-script state** (E8) | MEDIUM | If customer wanders into the wizard, it could overwrite admin-set values. | Data corruption risk during onboarding. | 🟡 |
| 7 | **Job state machine undocumented** (C5) | MEDIUM | API consumers (or future partners) hit `invalid_transition` errors. UI hides this; integrators can't. | Pre-revenue partner inquiries get rough demos. | 🟢 |
| 8 | **Readiness cache `missingCount`/`missingItemsPreview` undefined** (D2) | LOW | Operator sees `state=requirements_missing` with no detail about WHAT's missing. | Customer manually clicks through to find out. | 🟢 |
| 9 | **Magic-link auto-delivery missing** (E3) | LOW | CS person hand-copies links. Acceptable at pilot scale, not at production scale. | One-time CS-hiring decision. | 🟢 |
| 10 | **Timeline events not surfaced to dry-run reader** (C7) | LOW (DIAGNOSIS) | Reader queried `incidents/{id}/timeline_events` and got 0; this may be a path-mirror artifact (data is likely under `orgs/{orgId}/incidents/{id}/timeline_events`). Functional behavior likely intact. | None. Worth a 30-min verify. | 🟢 |

## G. Recommended Next Sprint — **let the evidence decide**

The original framing was "PR 133C (enforcement mode) is the next sprint." **The Butler dry-run produces a more nuanced answer:**

PR 133C is *still* the right next sprint, but its scope should be narrowed and a small parallel fix should precede it. The dry-run reveals that the gap between "DIRS v1.1 produces real findings" and "customer can ship a compliant packet" is **not primarily an enforcement gap** — it's that **enforcement is moot until the entitlement gate exists**. The proposed sequencing:

### G.1 PR 133A — Entitlement default fix + recovery-role relaxation (1-2 days, 1 PR)

The single most impactful unlock the dry-run identified. Two surgical changes:

1. In `createOrgV1`, after the org doc write, also write `orgs/{orgId}/billing/state` with `{status: "trialing", plan: "Pilot", entitlements: { riskDefenseModule: true }}`. Existing orgs unchanged. Idempotent.
2. In `updateRecoveryCaseV1`, change `ROLES_ADMIN_ONLY` to `ROLES_SUPERVISOR_OR_HIGHER` for `open → in_progress`, leave `→ ready_to_resubmit` / `→ recovered` / `→ abandoned` as admin-only.

Risk: ZERO. Same shape as Chunk 3B-2 starter-template auto-seed. Tests already exist for both endpoints.

This single PR moves Activation Score from 72→90, Operational Readiness from 78→85, lifts overall status to GREEN for non-enforcement gaps.

### G.2 PR 133B — Operator visibility for validator findings (3-4 days, 1 PR)

The Butler dry-run showed the validator works but operators can't see findings without drilling into an incident summary. Three small adds:

1. Surface readiness state on the incident card (color chip: green/amber/red).
2. On the "Send to Customer for Review" action, if readiness state is `requirements_missing` and the org's `validation.mode === "passive_log"`, show a confirm modal: "This record has X unmet DIRS requirements. Send anyway?"
3. Embed the validator snapshot (rulepack version + issues list) in the exported packet's audit metadata. Regulator-defensible without changing enforcement behavior.

### G.3 PR 133C — Enforcement mode (the original PR 133C scope) (1-2 weeks)

After G.1 and G.2, this becomes meaningful. The work:

1. `validation.mode` value `"block"` causes `exportIncidentPacketV1` and `createCustomerReviewLinkV1` to reject when ERROR-severity findings exist.
2. Per-org override at `orgs/{orgId}/config/validation.mode`.
3. Engine enhancement to support evidence-status gates (the v1.1 engineLimitations block calls out the need explicitly).
4. Gradual rollout: alpha customer at `passive_persist`, Butler pilot at `passive_log` → `block` after 30-day shadow.

### G.4 Out of scope for the next sprint

These came up but are deferred:

- Customer admin onboarding tour (F4) — UX/design work, defer until after PR 133A/B/C; the activation flow is fixable through email-first messaging in the meantime.
- Magic-link auto-delivery (F9) — pure CS-scale unlock; ship at production-ramp time.
- Custom archetypes admin surface — beyond pilot.

---

## Confidence statement

This is a customer-reality assessment grounded in 5 sequential dry-runs against live `peakops-pilot`. The final run produced zero errors across all 6 phases. Each phase used a fresh throwaway org (different from `peakops-internal-alpha` / Northgate / any preexisting record). Auth users + Firestore docs + recovery cases were fully cleaned up after each run.

What this assessment is NOT: a UI/UX audit of the customer's first 30 days, a load test, a multi-tenant cross-pollination test, or a security review. Those exercises remain. The dry-run answers the specific question: "If Butler America signed today, could they complete the onboard → operate → review → recover → re-accept arc without founder code intervention?" — and the answer is: **yes, after a one-time billing flip; no, without it.**
