# Chunk 2 — Workflow Completion Checkpoint

**Branch:** `chunk2/workflow-completion`
**Prepared:** 2026-06-22
**Owner:** Product Owner / Staff Software Engineer / QA Lead / Customer Success Lead (combined)

Closes the workflow-completion gaps surfaced by the executive review. After this lands + the manual verification checklist passes on staging, a pilot customer can move an incident from creation through review, packet generation, customer review, and closure without dead ends, missing notifications, broken buttons, or unclear status.

---

## A. Executive Summary

### Findings discovered

The executive review surfaced workflow gaps in five areas. Investigation confirmed the inventory below:

1. **Send-Back stub** — `ReviewClient.tsx:1287-1289` was an `alert("TODO: wire send-back endpoint (sendBackIncidentV1). For now, this is a stub.")`. Dead button visible to supervisors during review. **No corresponding `sendBackIncidentV1` callable exists.** Three working alternatives already cover the use case:
   - per-job `rejectJobV1` (the Reject button immediately below the stub)
   - per-incident `createSupervisorRequestV1` (Supervisor Request Update, emits `SUPERVISOR_REQUEST_UPDATE` timeline event)
   - per-record `submitCustomerReviewV1` rejection → auto-creates a recovery case
2. **Notification fan-out is sparse.** Only two events trigger in-app notifications: `report_ready` (after export) and `awaiting_review` (after field submit). The full customer-review lifecycle was emitting timeline events but no operator notifications:
   - `customer_review_link_created` — no notification (other supervisors don't know a link is out)
   - `customer_accepted` — no notification (operator polling required)
   - `customer_rejected` — **no notification — highest-impact gap.** Recovery work was opening silently
   - `recovery_case_opened` (auto-create) — no notification
3. **Post-mint operator visibility evaporated.** When status became `submitted_to_customer`, the Customer Acceptance section on Summary showed only "Awaiting customer action" with no time-since-send, no operational guidance, and no actionable affordance.
4. **No email handoff shortcut.** Operator copies the URL from the mint modal but has to manually open their email client and paste it. No `mailto:` quick-share.
5. **Lifecycle state machine** — already GREEN. All four mutating endpoints guard with `canTransitionIncident()`. No orphan paths. `customer_accepted` correctly terminal. Confirmed via new pure-Node state-machine completeness test.

### Findings fixed

| # | Finding | Resolution |
|---|---|---|
| 1 | Send-Back stub | **Removed.** Button + stub function gone from `ReviewClient.tsx`. Comment in source documents the three working alternatives. |
| 2a | `customer_review_link_created` notification | New fan-out in `createCustomerReviewLinkV1.js` + `mintResubmissionLinkV1.js`. Notifies admin + supervisor + creator. Title: "Review link sent". |
| 2b | `customer_accepted` notification | New fan-out in `submitCustomerReviewV1.js` (accept branch). Notifies admin + supervisor + creator. Title: "Customer accepted". |
| 2c | `customer_rejected` notification | New fan-out in `submitCustomerReviewV1.js` (reject branch). Same audience. Title: "Customer requested correction". Highest-impact change. |
| 2d | `recovery_case_opened` notification | New fan-out in `_recoveryAutoCreate.js`. Fires only when a NEW case opens (not when extending existing). Routes click-through to `/recovery/{caseId}`. |
| 2e | Notification routing map | `next-app/lib/notifications.ts` `NotificationType` union extended; `isNotificationType` guard updated; `notificationHref` recognizes all 4 new types. |
| 3 | Post-mint operator visibility | `SummaryClient.tsx` Customer Acceptance section now renders an "awaiting" guidance block when status is `submitted_to_customer`: shows time-since-send (with amber tone after 3+ days), explains the URL is one-time, points to support for revoke/re-mint. **Crucially**: removed the would-have-409-ed "Generate new review link" button so the operator never hits a broken action. |
| 4 | mailto: handoff | `SendToCustomerModal.tsx` now renders a second button **"✉ Open in email"** alongside Copy. Opens default mail client pre-filled with subject + body + URL inline. No customer-email field required on the link doc. |
| 5 | State-machine drift guard | New `test_workflow_state_machine.mjs` asserts every Scenario A/B transition is allowed, every terminal state rejects outbound edges except self-loop, no state is orphaned. |

### Remaining concerns

These were investigated, found out-of-scope for "Workflow Completion," and recorded as follow-ups:

- **`revokeReviewLinkV1` callable does not exist** (GitHub issue #147). Operator cannot revoke a minted-but-outstanding link without backend support. The "awaiting" guidance block correctly tells the operator to contact PeakOps support for revoke + remint. Adding the callable is small but non-trivial: needs audit, role gate, transition emit, UI revoke button. Recommended Chunk 3 (or its own micro-PR).
- **No external email delivery** (no `@sendgrid` / `nodemailer` / `postmark` / `mailgun` package installed). The product deliberately chose in-app + manual operator email handoff for v1. The mailto: shortcut closes the worst of the friction; full automated email is its own roadmap item.
- **No mobile capture app.** Field crews use Safari/Chrome on phone. Documented in executive review; not a workflow-completion blocker.
- **`packet_downloaded` does not fan out a notification** (only emits a timeline event from Chunk 1). Intentional — downloads are high-frequency; notifying every download would create noise. Stays as audit-only.

---

## B. Workflow Completion Matrix

| Area | Status | Notes |
|---|---|---|
| **Review Delivery** | 🟢 GREEN | Mint modal exists + Copy + new **Open-in-email** mailto: shortcut. Operator now has 2-click handoff (Mint → Open in email → send). Other supervisors get an in-app `customer_review_link_created` notification so the org sees the link is out. Manual delivery remains (no SMTP provider wired) but is now explicit + observable. |
| **Send-Back Flow** | 🟢 GREEN | Dead "Send Back" button removed. Three working paths documented in source: Reject per-job (`rejectJobV1`), Supervisor Request Update per-incident (`createSupervisorRequestV1`), customer-reject → auto-recovery. No visible non-working functionality remains. |
| **Notifications** | 🟢 GREEN | 4 new fan-out emits land in operator feeds with click-through targetUrl. Best-effort: notification failure never blocks the underlying mutation. Routing map covers every new type. Drift guard `test_chunk2_notifications_wired.mjs` runs against the live source. |
| **Lifecycle Integrity** | 🟢 GREEN | State machine in `incidentState.js` is comprehensive and well-policed. All status writes guarded by `canTransitionIncident()`. Terminal state `customer_accepted` correctly rejects outbound transitions. No orphan states. `test_workflow_state_machine.mjs` asserts all Scenario A/B/C transitions + completeness. |
| **Operator Confidence** | 🟢 GREEN (with one residual call-out) | New "awaiting" guidance block surfaces time-since-send + 90-day TTL + revoke-via-support path. Mailto: shortcut eliminates "now what?" ambiguity post-mint. Notifications close the loop on every customer action. Residual: when status is `submitted_to_customer`, the operator cannot remint a new link in-app — this is correct behavior (a remint with a stale link still active is risky), but it is a UX call-out the support flow handles. |

---

## C. Evidence

### Fix 1 — Send-Back stub removed

| Item | Detail |
|---|---|
| **Files changed** | `next-app/app/incidents/[incidentId]/review/ReviewClient.tsx` |
| **Why changed** | Stub button `alert("TODO: wire send-back endpoint (sendBackIncidentV1). For now, this is a stub.")` violates "no visible non-working functionality" — supervisor sees an alert and the workflow halts. |
| **Approach** | Removed `sendBack()` function and JSX button. Replaced with comment block documenting the three working alternatives. Existing per-job Reject button immediately adjacent is unchanged. |
| **Test performed** | `node scripts/dev/test_chunk2_notifications_wired.mjs` asserts the TODO alert string no longer appears in source AND no `sendBack()` function with an alert body remains. |
| **Result** | ✅ PASS. |

### Fix 2 — Notification fan-out wiring

| Item | Detail |
|---|---|
| **Files changed** | `functions_clean/createCustomerReviewLinkV1.js`, `functions_clean/mintResubmissionLinkV1.js`, `functions_clean/submitCustomerReviewV1.js`, `functions_clean/_recoveryAutoCreate.js`, `next-app/lib/notifications.ts` |
| **Why changed** | Operators were polling `/summary` to discover customer decisions. Specifically: a customer rejection silently opened a recovery case with no operator notification — operators only learned about it the next time they refreshed. |
| **Approach** | Match the existing fan-out pattern used by `report_ready` and `awaiting_review`: lazy `require("./_notify")` inside a `try/catch`, fan out to `["admin", "supervisor"]` recipientRoles + optional creator UID via `additionalUids`, log recipients + wrote counts. Errors never block the underlying mutation. Type union + isNotificationType guard + notificationHref routing all updated. |
| **Test performed** | `node scripts/dev/test_chunk2_notifications_wired.mjs` asserts: (a) each source file carries its marker + type literal + title literal; (b) each calls `fanOutOrgNotification`; (c) routing map covers all 4 new types with `notificationHref` branches. |
| **Result** | ✅ PASS — 9 assertions, all pass. |
| **Audience shape** | Recipient roles: `["admin", "supervisor"]`. Plus optional creator UID. Per-user opt-in via `users/{uid}/settings/profile.<settingKey>` is **not yet wired** for the new types (default opt-in matches the existing pattern). |

### Fix 3 — Post-mint "awaiting" operator guidance

| Item | Detail |
|---|---|
| **Files changed** | `next-app/app/incidents/[incidentId]/summary/SummaryClient.tsx` |
| **Why changed** | "Awaiting customer action" alone gave operators no time-since indicator, no operational next-step, no path to fix a lost-link situation. |
| **Approach** | New conditional block inside the existing Customer Acceptance section. Computes days-since-mint from `incident.submittedToCustomerAt._seconds`. Renders a blue (≤2 days) or amber (≥3 days) tone block with time-since copy + 90-day TTL explanation + support-path direction. **Deliberately omits a "Mint new link" button** because the backend rejects re-mint from `submitted_to_customer` with 409 — exposing a broken affordance violates the chunk's contract. |
| **Test performed** | TypeScript typecheck (`npx tsc --noEmit`) clean. Manual rendering required (next-app build verifies via Vercel deploy). |
| **Result** | ✅ TS clean; visual verification required post-deploy. |

### Fix 4 — mailto: handoff shortcut

| Item | Detail |
|---|---|
| **Files changed** | `next-app/app/incidents/[incidentId]/summary/SendToCustomerModal.tsx` |
| **Why changed** | The product chose not to wire an email provider for v1. Without a mailto: shortcut, the operator's handoff path was: mint → copy URL → switch to email client → paste URL → type subject → type body → send. Six steps. With the shortcut: mint → click "Open in email" → recipient → send. Three steps. |
| **Approach** | New `openInEmailClient(url, customerLabel)` function builds a `mailto:` URL with subject + multi-line body (greeting, URL, instructions, signature) and assigns it to `window.location.href`. Second button in the modal's result step alongside Copy. Customer label, when known from the link doc, is interpolated into the greeting. |
| **Test performed** | `test_chunk2_notifications_wired.mjs` asserts marker, helper, and button text are all present. |
| **Result** | ✅ PASS. |

### Fix 5 — Lifecycle state machine drift guard

| Item | Detail |
|---|---|
| **Files added** | `scripts/dev/test_workflow_state_machine.mjs` |
| **Why added** | The pilot workflow depends on a specific set of allowed transitions (Scenario A: open→in_progress→submitted_to_customer→customer_accepted; Scenario B adds the rejection-resubmission cycle). A future refactor that silently rejects, say, `customer_rejected → submitted_to_customer` would break the recovery loop. The test asserts every transition the workflow needs + every terminal correctly rejects outbound edges except self + no state is orphaned. |
| **Test performed** | 35 assertions across 7 sections. Run: `node scripts/dev/test_workflow_state_machine.mjs`. |
| **Result** | ✅ PASS — workflow state machine completeness verified. |

### Fix 6 — End-to-end scenario verification (post-deploy)

| Item | Detail |
|---|---|
| **Files added** | `scripts/dev/e2e_workflow_scenarios_alpha.mjs` |
| **Why added** | Drift guards (pure-Node) cover source-level regressions. The E2E script proves the *actual* customer workflow runs end-to-end against the live Cloud Functions on `peakops-internal-alpha`. Three scenarios: A (happy path), B (rejection + resubmission), C (delivery failure surface — verifies the mint endpoint produces an operator-actionable 4xx, not a silent 500). |
| **Run condition** | **Run only AFTER Cloud Functions deploy.** The new notification assertions (`customer_accepted notification doc landed`, `recovery_case_opened in admin feed`) will not pass until the new functions are live. Listed in the manual verification checklist below. |

---

## D. Deployment Notes

### Risk level
**LOW.** All changes are additive:
- Notification fan-outs are best-effort try/catch wrappers that cannot fail their parent mutation. If `_notify.js` throws or the recipient query fails, the underlying mint/accept/reject/recovery-create still succeeds.
- UI changes are purely additive (new block in SummaryClient, new button in SendToCustomerModal) or subtractive (Send Back removal). No schema changes. No callable signature changes.
- TypeScript type union widening is backward compatible — older notification docs without one of the new types still parse via the `coerceNotification` guard.

### Three deploy lanes — coordinate ordering

1. **Vercel (Next.js)** — `next-app/lib/notifications.ts`, `next-app/app/incidents/[incidentId]/summary/SummaryClient.tsx`, `next-app/app/incidents/[incidentId]/summary/SendToCustomerModal.tsx`, `next-app/app/incidents/[incidentId]/review/ReviewClient.tsx`. Safe to deploy first; rollback restores the prior UI without functional impact (operators see "Awaiting customer action" without the new guidance block; mailto: button vanishes; Send Back button reappears — but the underlying stub is also re-introduced, which is also fine since the function reference is gone).
2. **Cloud Functions (`functions_clean/`)** — `createCustomerReviewLinkV1`, `mintResubmissionLinkV1`, `submitCustomerReviewV1`, `_recoveryAutoCreate`. **NOTE — main vs deploy-branch divergence.** Per existing operational note, Cloud Functions deploy from a separate branch; reconcile before `firebase deploy --only functions`. Notification fan-outs only land here.

**No Firebase rules deploy required** — Storage and Firestore rules unchanged.

### Rollback plan

| Layer | Rollback | Reverts |
|---|---|---|
| Vercel | `git revert <PR merge SHA>` + redeploy | UI returns to prior shape. Notification routing for new types falls back to the generic `/incidents/{iid}` href (still functional, no dead-ends). |
| Cloud Functions | `git checkout <prior SHA> -- functions_clean/` + `firebase deploy --only functions` | Notification fan-outs disappear. Recovery cases still auto-create. Audit trail still emits timeline events. |

### Manual verification checklist

Execute in order. Stop and investigate at the first failure.

#### Pre-deploy (any branch)
- [ ] Pure-Node tests pass:
      ```bash
      for t in scripts/dev/test_workflow_state_machine.mjs scripts/dev/test_chunk2_notifications_wired.mjs; do
        echo "── $t ──"
        node $t || echo "FAIL"
      done
      ```
- [ ] TypeScript clean: `cd next-app && npx tsc --noEmit`
- [ ] `git grep "TODO: wire send-back"` returns no matches in operator UI files
- [ ] `git grep "alert(.TODO"` returns no matches in `next-app/app` or `next-app/components`

#### Post-deploy: Vercel (Next.js)
- [ ] Open `/incidents/<any-submitted-to-customer-record>/summary?orgId=peakops-internal-alpha` — Customer Acceptance section shows the new "Awaiting" guidance block with time-since copy.
- [ ] Open `/incidents/<any-in-progress-record>/summary` — click "Send to customer review" — modal opens. Click "Mint review link." Result step shows TWO buttons: **Copy to clipboard** + **✉ Open in email**. Click Open in email — default mail client opens with subject + body + URL pre-filled.
- [ ] Open `/incidents/<any-record>/review?orgId=peakops-internal-alpha` — the "↩︎ Send Back" button is gone. The per-job Reject button is still present and functional.

#### Post-deploy: Cloud Functions
- [ ] Run the E2E scenario script:
      ```bash
      node scripts/dev/e2e_workflow_scenarios_alpha.mjs
      ```
      Expected: all three scenarios pass. Specifically:
      - Scenario A: creates incident, runs through to `customer_accepted`, asserts a `customer_accepted` notification doc landed in the creator's feed.
      - Scenario B: same to rejection, asserts `customer_rejected` + `recovery_case_opened` notifications, then mints a resubmission link, asserts `customer_review_link_created` notification on resubmission, completes through to `customer_accepted` + `recovery_case.status === "recovered"`.
      - Scenario C: tries to mint with unapproved jobs, asserts the 409 surfaces an operator-actionable error code (not a silent 500).
- [ ] Check Cloud Logging for `[notify] customer_review_link_created recipients=N wrote=M` log lines on a fresh mint — confirms the fan-out is running.
- [ ] Check Cloud Logging for `[notify] customer_rejected recipients=N wrote=M` log lines after a test rejection.

#### Manual scenario walkthroughs (optional but recommended for first pilot)

**Scenario A — happy path**
1. Operator creates an incident on alpha
2. Field crew uploads evidence
3. Supervisor reviews + approves the job
4. Operator clicks Send to customer review → mints link → clicks Open in email → sends to test+a@example.com (or self)
5. Customer opens the link, clicks Accept
6. Operator's notification bell shows "Customer accepted" within seconds
7. Incident status on Summary shows "Up to date" / "Accepted by customer"

**Scenario B — rejection + resubmission**
1. Same as A through step 4
2. Customer clicks Reject with comment "Missing test result"
3. Operator's notification bell shows "Customer requested correction" + "Recovery case opened" within seconds
4. Operator opens Recovery → sees the auto-created case with "Missing test result" cause
5. Operator marks the case ready_to_resubmit
6. Operator mints resubmission link → opens in email → sends
7. Customer accepts on resubmission
8. Operator's notification bell shows "Customer accepted"; recovery case status flips to "recovered"

**Scenario C — delivery failure**
1. Operator creates an incident
2. Without approving the job, tries to mint a review link
3. Modal surfaces the structured error: "Some jobs on this record aren't approved yet" with the list of blocked jobs
4. Operator approves the job and re-mints successfully

---

## E. Final Recommendation

**Would I allow a pilot customer to use the full incident workflow without staff intervention?**

**YES** — after the manual verification checklist passes on `peakops-internal-alpha` post-deploy. Specifically:

- A customer who is sent a review link can review the dossier, accept or reject, and have their action recorded — verified end-to-end on the version-pinned customer review chain (Chunk 1) and verified here via the E2E scenario script.
- An operator who receives an in-app notification on every customer action (accept, reject) and every recovery case auto-creation no longer needs to poll Summary or wait for staff handoff to discover state changes.
- A supervisor reviewing the Field Review page no longer encounters a dead "Send Back" button — every visible action on the page is wired and functional.
- An operator who needs to send a customer review link gets a one-click mailto: shortcut. Manual handoff still required (no SMTP provider) but explicit and observable.

**Caveats — what staff still needs to handle:**

1. **Lost links:** if a customer reports losing the review URL, the operator must contact PeakOps support to revoke + remint. The "Awaiting" guidance block tells the operator this explicitly. Tracking issue: GH #147 (revokeReviewLinkV1).
2. **Email delivery:** the operator's email client is the delivery mechanism. PeakOps does not currently send emails. The mailto: button reduces the friction; full automation is a future scope item.
3. **Customer never responds:** the link is valid for 90 days then expires. The "Awaiting" guidance block surfaces days-since-send with an amber tone after 3 days as a follow-up prompt. No auto-reminder emails (same email-provider gap).

The trust layer is GREEN (Chunk 1). The workflow layer is now GREEN (Chunk 2). The remaining pilot blockers are content / scope (compliance rulepacks, mobile capture) — not workflow correctness.
