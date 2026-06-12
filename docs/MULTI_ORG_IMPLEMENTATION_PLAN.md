# PEAKOPS MULTI-ORG IMPLEMENTATION PLAN — V1

**Status:** Implementation plan. No code in this pass.
**Date:** 2026-05-06
**Source of truth:** [`MULTI_ORG_RELATIONSHIP_MODEL.md`](./MULTI_ORG_RELATIONSHIP_MODEL.md)

---

## 0. Foundation Posture

Every recommendation in this plan is derived from one chain:

```
user → membership → org → relationship → share scope → resource
```

Every read, every write, and every audit log must be explainable as a walk
along this chain. The phases below build the chain link by link, in the
order that minimizes rework and lets each link be tested before the next is
added.

**This document does NOT specify:**
- Schema details (see the architecture doc)
- TypeScript types beyond rough shape hints
- UI mockups
- Stripe / billing integration internals

**This document DOES specify:**
- Phase-by-phase build order
- Files / areas / collections / functions per phase
- Security risks and acceptance criteria per phase
- Pre-launch checklists
- Rollback paths

---

## Phase 1 — Customer Org Isolation Foundation

### Goal
Verify every existing read and write is scoped to one `orgId`, and add the
missing fields on `orgs/{orgId}` that the rest of the model assumes
(`orgType`, `ownerUserId`, `kind`, `status`, `publicProfile`, denormalized
counts). No data migration; additive only.

### Files / areas likely touched
- `firestore.rules` — strengthen the `match /orgs/{orgId}/...` block to
  require membership for every read/write.
- `next-app/src/lib/auth/assertOrgMember.ts` (new) — callable-side helper
  that fails closed when the actor is not an active member of the targeted
  org.
- `next-app/src/lib/firebaseAdmin.ts` — funnel admin reads through a
  per-org wrapper that audits the calling chain.
- `next-app/middleware.ts` — verify `orgId` is resolved from session
  context, never trusted from URL alone.
- `next-app/src/lib/onboarding/onboardingPersistence.ts` — extend the
  onboarding patch to set `orgType`, `ownerUserId`, `kind: "customer"` on
  org creation.
- `functions_clean/_authz.js` (new) — shared module imported by every
  callable.
- `functions_clean/<verbV1>.js` — retrofit the high-traffic V1 functions
  to call the assertion at the top (start with: `closeIncidentV1`,
  `addEvidenceV1`, `assignJobOrgV1`).

### Firestore collections involved
- `orgs/{orgId}` — additive fields only.
- `orgs/{orgId}/incidents/{incidentId}` — read-posture audit; no schema
  change.
- `orgs/{orgId}/workflows/{...}` — read-posture audit.
- `orgs/{orgId}/onboarding/state` — already exists.

### Functions needed
- `bootstrapOrgV1` (new) — atomic org creation: writes `orgs/{orgId}`,
  the founding `orgs/{orgId}/members/{ownerUid}` record, and
  `users/{ownerUid}/memberships/{orgId}` in a single batched write.
- `_authz.js` (new shared module) — `assertActorMember(orgId, uid)`,
  `assertActorRole(orgId, uid, allowedRoles[])`. Imported by every callable.

### Security risks
- **URL-trust orgId leakage.** Any V1 callable that accepts `orgId` from
  the request body and reads/writes without verifying membership is a
  tenant escape. Audit every existing callable.
- **Orphaned orgs.** An org without `ownerUserId` cannot have its
  permissions model anchored. Bootstrap function must guarantee the
  invariant.
- **Existing data shape drift.** Older orgs (created before this phase)
  must work without `orgType` set — code must default to `"operator"` on
  read.

### Acceptance criteria
- Every `orgs/{orgId}/...` write requires membership in `{orgId}` via rules.
- Every existing V1 callable validates `orgId` membership before any
  Firestore read/write.
- New orgs created via onboarding have `orgType`, `ownerUserId`,
  `kind: "customer"`, `status: "active"` set atomically.
- Existing orgs that lack the new fields read with sensible defaults; a
  one-off backfill script ships in `next-app/scripts/backfillOrgFields.ts`.
- `assertActorMember` fails closed (returns deny) if the membership doc
  is missing, status≠active, or the user lacks auth.

### What NOT to overbuild yet
- No URL restructure (still `?orgId=` in v1).
- No per-attribute redaction.
- No relationship UI.
- No org-deletion flow (status="archived" suffices).
- No data migration tool — additive defaults only.

---

## Phase 2 — Membership + Roles

### Goal
Establish `orgs/{orgId}/members/{userId}` as the canonical membership
record, mirror it to `users/{userId}/memberships/{orgId}` for the
org-switcher, and ship role-based UI gating. Owner is irreducible; admin
manages members; supervisor/field/viewer are scoped per the architecture
doc.

### Files / areas likely touched
- `next-app/src/lib/membership/` (new) — `loadMembership`, `listMembers`,
  `currentRole` helpers.
- `next-app/app/settings/team/` (existing skeleton) — flesh out as the
  member roster + invite + role-edit UI.
- `next-app/app/_components/OrgSwitcher.tsx` (new) — shell-level switcher
  driven by `users/{uid}/memberships/{orgId}`.
- `functions_clean/inviteOrgMemberV1.js` (likely already exists; verify
  signature matches phase plan).
- `functions_clean/acceptOrgMembershipV1.js` (new).
- `functions_clean/setMemberRoleV1.js` (new).
- `functions_clean/removeOrgMemberV1.js` (new — soft-remove).
- `functions_clean/onMembershipWriteTriggerV1.js` (new — Firestore trigger
  that mirrors writes to the user-side denorm).
- `firestore.rules` — `match /orgs/{orgId}/members/{userId}` and
  `match /users/{userId}/memberships/{orgId}` blocks.

### Firestore collections involved
- `orgs/{orgId}/members/{userId}`
- `users/{userId}` — base identity doc.
- `users/{userId}/memberships/{orgId}` — denormalized switcher list.

### Functions needed
- `inviteOrgMemberV1` — admin-only; writes a membership doc with
  `status: "invited"` + a join token; emails recipient.
- `acceptOrgMembershipV1` — recipient-side; promotes status invited→active;
  trigger mirrors to `users/{uid}/memberships/{orgId}`.
- `setMemberRoleV1` — admin-only; writes audit entry. Owner role is
  unreachable via this function (owner transfer is out of v1 scope).
- `removeOrgMemberV1` — soft-remove (status="removed"; doc retained).
- `onMembershipWriteTriggerV1` — Firestore trigger maintaining
  `users/{uid}/memberships/{orgId}` mirror.

### Security risks
- **Self-elevation.** A member must not be able to elevate their own role.
  `setMemberRoleV1` must reject `request.auth.uid === targetUid`.
- **Owner role evasion.** No callable in v1 may write `role: "owner"`
  except `bootstrapOrgV1`. Owner transfer is deliberately out of scope.
- **Stale switcher mirror.** A removed member who still has
  `users/{uid}/memberships/{orgId}` will see the org in the switcher.
  Trigger must remove the mirror within seconds; UI must re-validate
  membership on org-switch.
- **Mismatched orgId between membership and user mirror** — the trigger
  must always write the mirror under the right `users/{uid}` path.

### Acceptance criteria
- A complete invite → accept loop produces an active member, an active
  user mirror, and an audit entry.
- A user listed in `users/{uid}/memberships/...` can sign in and see that
  org in the switcher.
- Removing a member denies further access on the next request and within
  seconds clears the switcher mirror.
- An admin cannot promote themselves to owner.
- A non-admin cannot invoke `setMemberRoleV1`.

### What NOT to overbuild yet
- No SAML / SCIM / IdP integration.
- No per-feature granular permission editor; role enum only.
- No bulk import.
- No user merge or email change.
- No "view as another role" debugging surface.
- No owner transfer flow.

---

## Phase 3 — Demo Org vs Customer Org Separation

### Goal
Cleanly partition `demo-org` (and any other demo/internal orgs) from real
customer orgs. Demo becomes a tagged tenant that no real customer org can
relate to, share with, borrow members from, or be billed alongside.

### Files / areas likely touched
- `next-app/src/lib/orgKind.ts` (new) — table-driven `getOrgKind(orgId)`
  returning `"demo" | "customer" | "internal"`.
- `next-app/src/lib/demoActor.ts` (existing) — extend to use the new
  classification and refuse customer-context calls.
- `firestore.rules` — explicit deny on cross-relate / cross-share when
  either party is `kind != "customer"` and the other is `kind == "customer"`.
- `functions_clean/_authz.js` — `assertNotCrossKind(orgIdA, orgIdB)`
  helper used by every relationship and share callable.
- `next-app/app/settings/*` — hide invite + relationship surfaces in
  demo orgs.
- Billing layer (Phase 6) — demo orgs always free, never invoiced.

### Firestore collections involved
- `orgs/{orgId}.kind` — new field, set at create time.
- All cross-org subcollections (`relationships`, `inboundShares`,
  `relationshipInvites`) — guard by kind.

### Functions needed
- `assertNotCrossKind(orgIdA, orgIdB)` — shared helper.
- `seedDemoOrgV1` (support tooling, not user-facing) — guarantees a clean
  demo state; only operates on `kind: "demo"` ids.
- `resetDemoOrgV1` (support tooling) — wipes demo data, reseeds fixtures.

### Security risks
- **Accidental customer→demo relationship.** A customer admin invites
  `demo-org`; would expose customer data to whichever account holds the
  demo tenant.
- **Accidental demo→customer share.** A demo seed script writes a share
  pointing into a customer org.
- **Membership cross-pollination.** A demo user's uid added to a customer
  org's members subcollection by a misrouted seed script.
- **Billing leak.** A demo org accidentally classified as `customer` and
  invoiced.

### Acceptance criteria
- `assertNotCrossKind` rejects any relationship invite, acceptance,
  share, or member-add where one side is `kind != "customer"` and the
  other is `kind == "customer"`.
- `kind` is set on every existing org doc (one-time backfill);
  `demo-org` → `"demo"`, all real orgs → `"customer"`.
- Seed scripts are id-prefix-restricted (`demo-*`, `scratch-*`).
- A demo org can never have `billing/config.payerOrgId` set to a non-demo id.
- Demo UI surfaces hide invite + relationship CTAs.

### What NOT to overbuild yet
- No multi-region demo isolation.
- No automated demo reset cron (manual support-tool action is fine for v1).
- No "switchable demo persona" UX.
- No tenanted demo-per-customer model.

---

## Phase 4 — Vendor Relationship Records

### Goal
Implement the mirrored Relationship doc + invite token primitive
end-to-end. After this phase: an admin in Org A can invite Org B (or a
brand-new email), B accepts, both sides see the active relationship in
their Settings → Partners view. **No incidents are shared yet** — this
phase establishes the relationship primitive in isolation.

### Files / areas likely touched
- `next-app/src/lib/relationships/` (new) — types, helpers, scope presets
  (Observer / Field / Joint Ops).
- `next-app/app/settings/vendors/` (existing skeleton) — flesh out as the
  Partners list + invite form + accept/decline flows.
- `next-app/app/invite/[token]/page.tsx` (new route) — invite landing page.
- `functions_clean/inviteRelationshipV1.js` (new).
- `functions_clean/acceptRelationshipV1.js` (new).
- `functions_clean/declineRelationshipV1.js` (new).
- `functions_clean/pauseRelationshipV1.js` (new).
- `functions_clean/resumeRelationshipV1.js` (new).
- `functions_clean/terminateRelationshipV1.js` (new).
- `functions_clean/revokeRelationshipInviteV1.js` (new).
- `functions_clean/relationshipInviteExpireScheduledV1.js` (new — daily cron).
- `firestore.rules` — `match /orgs/{orgId}/relationships/{...}` and
  `match /relationshipInvites/{inviteId}` blocks.

### Firestore collections involved
- `orgs/{orgId}/relationships/{relationshipId}`
- `orgs/{orgId}/relationships/{relationshipId}/audit/{eventId}`
- `relationshipInvites/{inviteId}` (top-level token)

### Functions needed
- `inviteRelationshipV1` — admin sends invite; creates URL-safe random
  token + placeholder relationship in status="invited" on sender side.
- `acceptRelationshipV1` — recipient accepts; **atomic batched write**
  creates the two mirror relationship docs with same `relationshipId`,
  status="active"; deletes the invite token; writes audit on both sides.
- `declineRelationshipV1` — recipient declines; deletes placeholder +
  token; audit on sender side.
- `pauseRelationshipV1` / `resumeRelationshipV1` — either side may pause;
  status="paused" blocks new shares; existing shares continue.
- `terminateRelationshipV1` — either side may terminate; soft-deletes
  (status="terminated"); marks all current shares status="revoked"
  on both ends.
- `revokeRelationshipInviteV1` — sender cancels before acceptance.
- `relationshipInviteExpireScheduledV1` — daily cron; expires invites
  past TTL, terminates orphan placeholders with reason="invite_expired".

### Security risks
- **Mismatched mirror state.** If the atomic write of the two mirror docs
  partially fails, one side is active and the other is missing — a
  zombie relationship. Use `WriteBatch.commit()` with all-or-nothing
  semantics.
- **Token entropy.** Brute-force guessing must be impractical; use
  `crypto.randomBytes(32)` URL-safe encoded.
- **Self-relationship.** Org A inviting Org A — must reject at function
  entry.
- **Acceptor not admin of accepting org.** Acceptor must be admin/owner
  of the org they're accepting *for*.
- **Duplicate active relationship.** Same `(fromOrgId, toOrgId, type)`
  cannot have two active relationships. Function must transaction-check
  before writing.
- **Cross-kind invite.** Demo↔customer rejected via
  `assertNotCrossKind` (Phase 3).

### Acceptance criteria
- A complete invite→accept loop produces two mirror relationship docs
  with identical `relationshipId`, both `status: "active"`, plus an
  audit entry on each side.
- Acceptance is atomic: any step failure → no docs persist, token
  remains valid for retry.
- Decline / expire / revoke leave no orphan placeholder.
- Audit entries written for every status transition.
- A pair of orgs cannot create a duplicate active relationship of the
  same `(type, direction)`.
- Invite tokens expire after 7 days and are cleaned by the cron.

### What NOT to overbuild yet
- No share UI yet — relationships exist but do nothing operationally.
- No `defaultScope` byte-by-byte editor; preset selection only.
- No marketplace / public discovery.
- No trust-score surface.
- No relationship templates beyond preset application.

---

## Phase 5 — Shared Job Access

### Goal
Wire incident-level sharing through an active relationship, with
recipient-side inbound view + scoped writes. Owner shares → recipient
sees in Inbound list → recipient acts within their scope.

### Files / areas likely touched
- `next-app/src/lib/incidents/share.ts` (new) — share helpers, scope
  composition (intersection).
- `next-app/app/incidents/[incidentId]/IncidentClient.tsx` — share
  controls in the admin view.
- `next-app/app/incidents/page.tsx` — Inbound filter / tab.
- `next-app/src/lib/incidents/inbound.ts` (new) — inbound share loader.
- `functions_clean/shareIncidentV1.js` (new).
- `functions_clean/revokeIncidentShareV1.js` (new).
- `functions_clean/onIncidentWriteRefreshInboundSnapshotV1.js` (new
  Firestore trigger).
- `functions_clean/crossOrgIncidentMutationV1.js` (new) — single callable
  entry point for vendor writes (addEvidence, addNotes, advanceState,
  closeIncident — each gated by scope).
- `firestore.rules` — extend `incidents/{...}` rule to permit reads when
  `request.auth.uid` is a member of an org in `shareSettings.sharedWithOrgIds`.

### Firestore collections involved
- `orgs/{orgId}/incidents/{incidentId}` — gain `shareSettings`.
- `orgs/{recipientOrgId}/inboundShares/{shareId}` — denormalized index.

### Functions needed
- `shareIncidentV1` — owner shares with partner; validates active
  relationship; computes effective scope (relationship default ∩
  per-share override); writes `shareSettings.shares[partnerOrgId]` +
  mirrors to recipient's `inboundShares/{shareId}`.
- `revokeIncidentShareV1` — owner revokes; updates both ends synchronously.
- `onIncidentWriteRefreshInboundSnapshotV1` — Firestore trigger; refreshes
  `inboundShares.snapshot.{title,state,updatedAt}`.
- `crossOrgIncidentMutationV1` — **the only path** for vendor-side
  writes to an owner's incident. Re-validates scope server-side per
  action (addEvidence, addNotes, advanceState, assignMembers,
  closeIncident); writes via admin SDK. Logs the chain trace
  `user → membership → vendor org → relationship → share scope →
  incident` to the audit log.

### Security risks
- **Direct cross-org write bypass.** Rules must default-deny direct
  writes to a partner's `incidents/{...}`. Vendor writes go through the
  callable only.
- **Snapshot used in authz.** Authorization decisions must read the
  authoritative incident, NEVER the recipient's `inboundShares.snapshot`.
- **Widening override.** Per-share scope override must be intersected
  with the relationship default at write time. Validation at function
  entry; trust no client value.
- **Stale inbound after revoke.** Revocation must update
  `shareSettings` AND `inboundShares` synchronously (transaction or
  batched write); otherwise revoked shares appear in recipient's list.
- **PII leak via summary.** `read.pii=false` must strip PII fields from
  any payload returned to a partner reader. Audit the `summary` /
  `detail` payload structure to ensure no PII is included by default.
- **Owner org can be tricked into sharing with terminated relationship.**
  `shareIncidentV1` must verify the relationship is currently
  `status: "active"` at write time, not just at UI render time.

### Acceptance criteria
- Owner can share → recipient sees in Inbound view within seconds.
- Recipient can perform exactly the scoped writes via the callable;
  every other action returns 403 with a chain-trace explanation in the
  audit log.
- Revoke removes recipient access on the next read.
- Snapshot trigger updates `inboundShares.snapshot` within 60s of an
  owner-side incident change.
- Direct Firestore writes by vendor auth context are denied by rules;
  only the callable succeeds.
- Per-share scope override that tries to widen relationship default is
  rejected at write with a clear error.

### What NOT to overbuild yet
- No bulk share UX (one incident at a time).
- No per-attribute redaction (resource-level only — `summary` /
  `detail` / `evidence` / `timeline` / `pii`).
- No real-time presence on cross-org incidents.
- No share templates beyond presets.
- No notifications / inbox / digest.
- No time-bound share auto-expire UI (data model supports `expiresAt`;
  ship the field, defer the UI).

---

## Phase 6 — Vendor Upgrade Path

### Goal
Implement the vendor → hybrid orgType flip with billing reclassification
and operator-UX unlock. Validate the canonical scenario from the
architecture doc end-to-end.

### Files / areas likely touched
- `next-app/src/lib/orgType.ts` (new) — type guards + valid transition
  table (vendor↔hybrid, hybrid↔operator).
- `next-app/src/lib/billing/` (new) — classification logic, grace-period
  helpers.
- `next-app/app/settings/billing/page.tsx` (new) — plan + grace surface.
- `next-app/app/settings/profile/page.tsx` — orgType flip UI for owner.
- `functions_clean/setOrgTypeV1.js` (new).
- `functions_clean/recomputeBillingClassificationV1.js` (new).
- `functions_clean/onIncidentCreateRecomputeBillingV1.js` (new trigger —
  if vendor org originates an incident, disqualify free tier immediately).
- `functions_clean/gracePeriodCronV1.js` (new — daily; grace expirations
  flip plan vendor→team).

### Firestore collections involved
- `orgs/{orgId}.orgType` — flip target.
- `orgs/{orgId}/billing/config` — plan + freeCollaborator + grace state.
- `orgs/{orgId}/billing/audit/{eventId}` — every classification change.

### Functions needed
- `setOrgTypeV1` — owner-only callable; validates the transition is
  legal; writes orgType + triggers reclassification.
- `recomputeBillingClassificationV1` — pure function; given the org's
  current state (orgType, originated incident count, member count,
  outbound relationship count), returns the correct
  `{ plan, freeCollaborator, graceUntil }`.
- `onIncidentCreateRecomputeBillingV1` — Firestore trigger on
  `orgs/{orgId}/incidents/{...}` create; if `freeCollaborator` was true,
  start grace and recompute.
- `gracePeriodCronV1` — daily; flips plan to "team" once
  `graceUntil < now`.

### Security risks
- **Surprise upgrade.** A vendor flips to hybrid and is immediately
  charged. Solve via grace window (default 30 days) with prominent UI.
- **Free→paid silent transition.** Grace expiration must surface in UI
  before activating, with email notification.
- **Grace bypass.** Org originates work but classification logic doesn't
  fire — incident-create trigger must be reliable.
- **Owner-only enforcement.** `setOrgTypeV1` must reject if caller is
  not the org owner.
- **Cross-org effects.** Billing reclassification must NEVER alter
  partner-org data, the relationship doc, or share scope. Verify via
  test matrix.

### Acceptance criteria
- Owner flips vendor→hybrid: orgType updates, `billing.freeCollaborator`
  flips to false, `graceUntil` set 30 days out.
- Existing inbound shares continue to function with no scope changes.
- City-side relationship doc is unchanged; the `partnerOrgType`
  snapshot updates via a refresh job (lazy; not a write trigger).
- Originating an incident in a vendor org disqualifies free tier
  immediately even without an explicit orgType flip (auto-promotes
  vendor→hybrid as a separate transition with audit entry).
- The canonical four-act scenario in `MULTI_ORG_RELATIONSHIP_MODEL.md` §
  Canonical Vendor Upgrade Scenario passes end-to-end in test fixtures.

### What NOT to overbuild yet
- No real Stripe (or other) integration — model the state, defer the
  payment processor wiring.
- No invoicing UI.
- No tier upgrade flows beyond vendor→hybrid (and the implicit
  hybrid→operator if/when ownership becomes the only orgType in use).
- No usage metering beyond seat count + originated-incident count.
- No proration logic.
- No payment failure / dunning flows.

---

## Phase 7 — Security Rules + Cloud Function Gates

### Goal
Comprehensive rules pass + the cross-org callable boundary that gates all
cross-org writes. This is the phase where the invariants get enforcement
teeth. **Designed from the invariants chain, not from UI convenience.**

### Files / areas likely touched
- `firestore.rules` — full rewrite covering every collection introduced
  in Phases 1–6. Default-deny at root.
- `functions_clean/_authz.js` — extend to a complete chain validator.
- `functions_clean/crossOrgIncidentMutationV1.js` — single entry point
  for vendor writes (already exists from Phase 5; this phase hardens it).
- All existing `*V1.js` callables — retrofitted to call
  `assertActorMember` and `assertActorRole` at the top.
- `next-app/middleware.ts` — verify session-bound `orgId` resolution
  (no URL trust).
- `next-app/__tests__/firestore-rules/` (new) — Firebase rules unit tests.
- `functions_clean/__tests__/authz/` (new) — chain validator tests.

### Firestore collections involved
- All. Every collection must have an explicit allow rule; the implicit
  fallthrough must be deny.

### Functions needed
- `_authz.js` exports:
  - `assertActorMember(orgId, uid)` — denies if no active membership.
  - `assertActorRole(orgId, uid, allowedRoles[])` — denies if role
    not in list.
  - `assertActiveRelationship(orgIdA, orgIdB, relationshipType?)` —
    denies if no active relationship between the two.
  - `assertShareScope(actorOrgId, ownerOrgId, incidentId, action)` —
    re-derives effective scope from authoritative docs (never
    snapshots) and denies if action is not granted.
  - `chainTraceForAuditLog(uid, ownerOrgId, action)` — produces the
    full `user → membership → org → relationship → share → resource`
    record for the audit subcollection.
  - `assertNotCrossKind(orgIdA, orgIdB)` — Phase 3 helper, surfaced here
    too.
- `crossOrgIncidentMutationV1` — single callable that:
  1. Reads action from request body (`addEvidence` | `addNotes` |
     `advanceState` | `assignMembers` | `closeIncident`).
  2. Calls `assertShareScope` for that action.
  3. Writes via admin SDK if allowed.
  4. Logs chain trace to owner's incident audit subcollection.

### Security risks
- **Rule/callable inconsistency.** Rules permit a write that the
  callable would deny, or vice versa. Mitigation: test matrix
  (Phase 8) covers both surfaces with the same fixtures.
- **Snapshot-in-authz.** Any code path in `_authz.js` that reads from a
  snapshot field is a critical bug. Code review checklist + grep audit
  required.
- **New collection without a rule block.** A future phase adds a
  collection but forgets the rule; default-deny at root catches this
  but tests must verify.
- **Scope widening at the function layer.** A callable that accepts a
  scope object from the client and uses it directly (instead of
  re-deriving from the authoritative relationship + share docs) is a
  privilege escalation. Validation: callable always re-reads the
  relationship default + share override and intersects them server-side.

### Acceptance criteria
- Default-deny at the root of `firestore.rules`.
- Every collection has an explicit allow path; rules emulator tests
  confirm.
- 100% of cross-org writes go through `crossOrgIncidentMutationV1`;
  direct cross-org writes are denied by rules.
- Every callable logs a chain trace on every state-changing action.
- Rules emulator suite covers: reads (member, partner-via-share,
  unrelated user), writes (member, partner-via-callable, partner-direct),
  cross-kind attempts.
- Code review checklist confirms no `_authz.js` path reads a snapshot
  field for an authorization decision.

### What NOT to overbuild yet
- No per-attribute redaction (resource-level only).
- No rule-level rate limiting (Cloud Armor / App Check handle this).
- No custom auth claims for relationship state (re-derive at every call).
- No regional residency rules.

---

## Phase 8 — QA / Test Matrix

### Goal
A test matrix that exhaustively validates the invariant chain across
role × relationship state × scope preset × action × kind. Both automated
(emulator + unit + integration) and a manual Chrome QA pass.

### Files / areas likely touched
- `next-app/__tests__/multi-org/` (new) — integration tests against
  emulator.
- `next-app/__tests__/firestore-rules/` (new — from Phase 7) — rules
  emulator unit tests.
- `functions_clean/__tests__/authz/` (new — from Phase 7) — `_authz.js`
  unit tests.
- `next-app/scripts/qa/multi-org-matrix.ts` (new) — fixture seeder +
  manual run guide.
- `docs/MULTI_ORG_QA_RUNBOOK.md` (new) — Chrome QA path with
  step-by-step expected outcomes.

### Firestore collections involved
- All. Test fixtures seed full chains across multiple orgs.

### Test categories (each with fixtures + assertions)

1. **Within-org access matrix** — every role × every action × own org.
2. **Cross-org with active relationship + scope preset** — vendor /
   customer / peer × Observer / Field / Joint Ops × every action.
3. **Cross-org without relationship** — every attempt denies.
4. **Cross-org with paused relationship** — new shares deny; existing
   reads continue; existing writes deny.
5. **Cross-org with terminated relationship** — every action denies;
   audit trail still readable.
6. **Cross-org with widening scope override** — write rejected.
7. **Snapshot drift** — owner renames the partner org; partner's
   relationship snapshot is stale; authorization still works correctly.
8. **Demo↔customer crossings** — invite, accept, share, member-add all
   deny.
9. **Vendor → hybrid mid-flow** — relationship persists, ownership
   unchanged, billing reclassifies, no partner data leaked.
10. **Audit trail coverage** — every state-changing action across the
    matrix produces a chain-trace audit entry.
11. **Chain-break cases** — remove the membership; access denied even
    if the share doc still exists.
12. **Concurrent updates** — two admins flipping pause/resume; final
    state is consistent.

### Functions needed
- Test fixture seeder that creates: 4 orgs (1 demo, 3 customer with
  varying orgType), 8 users with cross-org memberships, 6 active
  relationships covering all type combinations, 12 shared incidents
  covering every preset.
- A "matrix runner" that walks every cell and asserts the expected
  allow/deny outcome.
- A snapshot of the audit log structure post-run for reviewer sign-off.

### Security risks
- **Test gap.** A cell in the matrix that's silently skipped (e.g.,
  test marked `.skip`). The matrix runner must fail the build if any
  declared cell has no assertion.
- **Test orgs leaking into prod.** Tests run only against the emulator
  or a dedicated test project; CI must enforce this.

### Acceptance criteria
- Every cell in the matrix has at least one assertion.
- All deny cases fail closed (deny if rule missing).
- Audit trail records the full chain for every passing access.
- Manual Chrome QA runbook signed off by owner + one reviewer before
  any real customer onboards.
- CI runs the matrix on every PR that touches `firestore.rules`,
  `_authz.js`, or any V1 callable.

### What NOT to overbuild yet
- No load testing (defer to pre-public-launch).
- No fuzz testing of rules (defer).
- No automated penetration testing (manual review only for v1).
- No chaos / failure-injection tests on the relationship transition
  flow.

---

## Implementation Order Recommendation

The phases are not strictly linear; some interleave. The recommended order
minimizes rework by shipping each invariant link before adding the next:

```
1. Phase 1 — org isolation foundation
        ↓
2. Phase 2 — membership + roles
        ↓
3. Phase 3 — demo separation
        ↓
4. Phase 4 — relationship records
        ↓
5. Phase 5 — shared job access
        ↓
6. Phase 7 — security rules + Cloud Function gates  (interleaves with 4 + 5)
        ↓
7. Phase 6 — vendor upgrade path
        ↓
8. Phase 8 — full test matrix
        ↓
9. Manual Chrome QA pass + first-customer checklist
```

Phase 7 is split: the `_authz.js` skeleton + default-deny rules ship with
Phase 1; rules for relationships ship with Phase 4; rules for shares ship
with Phase 5; the comprehensive hardening pass is the dedicated Phase 7
deliverable. This mirrors the architecture-doc principle that rules are
designed from invariants — they are not a final-step polish.

---

## Before First Real Customer — Checklist

- [ ] Phases 1, 2, 3, 4, 5, 7, 8 complete.
- [ ] Every existing org doc has `kind` set (one-time backfill).
- [ ] Every existing org doc has `orgType` and `ownerUserId` set.
- [ ] `assertNotCrossKind` blocks every demo↔customer crossing in tests.
- [ ] Test matrix all green; no `.skip`.
- [ ] Manual Chrome QA runbook signed off.
- [ ] Audit-log spot-check on 5 random shares: chain trace recoverable
      end-to-end from the audit subcollections.
- [ ] Backup + restore drill on a test org; restore preserves
      relationships and shares correctly.
- [ ] Support tooling: a "view as org X" admin path that does NOT bypass
      rules (it uses a temporary explicit support membership).
- [ ] Rules emulator suite passes locally and in CI.
- [ ] Grep audit confirms 100% of cross-org writes go through
      `crossOrgIncidentMutationV1`.
- [ ] Operator + at least one vendor-org test account walked through the
      full canonical scenario in production environment with real auth.
- [ ] Demo org cannot be invoiced (verified by classification function).
- [ ] An owner-removal scenario tested: org with one owner cannot lose
      their owner via UI.
- [ ] Customer-facing copy reviewed for honesty: "shared" vs "owned",
      "draft" vs "active", "free collaborator" vs "paid plan".

---

## Before Public Self-Serve — Checklist

(Adds to the first-customer list above; everything there must still hold.)

- [ ] Phase 6 complete (vendor upgrade path live).
- [ ] Self-serve onboarding allows org creation without a support handoff.
- [ ] Self-serve relationship invite UX is unambiguous about scope.
- [ ] Public profile editor exists (`publicProfile` fields editable).
- [ ] Plan grace-period UI surfaces clearly with email reminders.
- [ ] Billing tier selection UX exists end-to-end.
- [ ] Recipient invite acceptance runs end-to-end without owner
      intervention from the inviting org.
- [ ] Email deliverability verified for invites + acceptance + grace
      reminders.
- [ ] Abuse controls: rate-limit invite sends per (sender org, hour).
- [ ] Email verification required before relationship acceptance.
- [ ] Public terms + DPA visible at signup.
- [ ] App Check enforced on every callable.
- [ ] Demo isolation tested with a real signup that explicitly tries to
      reach demo data.
- [ ] Support runbook for "rogue invite", "stuck transition", "billing
      escalation", "scope dispute" exists and is linked from the admin
      surfaces.
- [ ] Customer-facing scope preset documentation with screenshots.
- [ ] At least one full-cycle SOC2-style audit pass on the chain-trace
      audit logs.

---

## Rollback / Escape Hatch Notes

- **Per-phase feature flag.** Every phase ships behind a server-side
  flag (`flags/multiOrg.relationships`, `flags/multiOrg.shares`,
  `flags/multiOrg.vendorUpgrade`). Toggleable without redeploy.
- **Soft-delete only.** No hard deletes for v1. Everything is
  status-driven; recovery is "flip status back."
- **Per-org read-only mode.** Support callable
  `setOrgReadOnlyV1(orgId, true)` blocks writes without deleting
  anything; useful while investigating an incident.
- **Dual-read for index migrations.** When migrating
  `orgs/{orgId}/inboundShares` to a top-level collection (future
  scalability), do dual-read for a transition window.
- **Rules rollback.** Keep the last 3 deployed `firestore.rules`
  versions in `archive/rules/`. A `make rules-rollback` script restores
  the previous one.
- **Function rollback.** Cloud Functions versioned;
  `firebase functions:rollback` pins the previous revision.
- **Relationship escape hatch.** If a relationship lands in mismatched
  mirror state (one side active, other pending), a support callable
  `forceTerminateRelationshipV1` writes both mirrors atomically and
  audit-logs the support uid that ran it.
- **Share emergency revoke.** `revokeAllSharesFromOrgV1(orgId, reason)`
  invalidates every outbound share from one org with an audit reason.
  Useful for incident response.
- **Demo wipe.** `resetDemoOrgV1` rebuilds demo fixtures from a known
  seed. Idempotent. Demo-id-restricted.
- **Billing escape.** `setBillingPlanV1` (admin support tooling only)
  manually overrides plan/grace state when classification logic gets
  stuck. Audit-logged.
- **Identity escape.** `forceRemoveMembershipV1` (support only)
  removes a user from an org and clears their `users/{uid}/memberships`
  mirror in one batched write.

---

## Top 5 Risks

1. **URL-trust orgId.** Any callable that reads `orgId` from the request
   without verifying membership is a tenant escape. Phase 1 must audit
   every existing handler. Mitigation: `assertActorMember` at the top
   of every callable; CI grep that fails the build if a callable
   imports `firebase-admin/firestore` without importing `_authz.js`.

2. **Mirror drift on relationships.** If the two mirror docs of a
   relationship diverge (one active, one missing), the system has a
   permission ambiguity and an audit hole. Mitigation: every
   relationship state change uses `WriteBatch` for atomicity; a
   reconciliation cron flags drift; `forceTerminateRelationshipV1`
   handles the recovery.

3. **Snapshot in authorization path.** Any code path that uses a
   `snapshot` field for a permission decision can grant access to a
   stale role or scope. Mitigation: `_authz.js` re-reads authoritative
   docs every call; code review checklist; grep ban on `snapshot.role`
   / `snapshot.scope` reads outside the recipient list view.

4. **Demo↔customer crossing.** An accidental relationship, share, or
   member-add between a demo org and a real customer org leaks one
   side's data into the other. Mitigation: `assertNotCrossKind` at the
   entry of every relationship + share + member callable; rules-level
   block as belt-and-braces; Phase 3 dedicated to this.

5. **Cross-org write bypass.** Any direct Firestore write to a partner's
   resource that doesn't go through `crossOrgIncidentMutationV1`
   defeats the entire scope model. Mitigation: rules default-deny
   cross-org writes; the callable is the only allowed path; Phase 8
   test matrix asserts this with negative cases.

---

## Recommended First Coding Pass

The single highest-leverage commit, scoped tight enough to land in one
PR:

1. Add the missing fields to `orgs/{orgId}` as **optional** with
   sensible defaults on read: `orgType`, `ownerUserId`, `kind`,
   `status`, `publicProfile`. No backfill required for the new code to
   function.
2. Create `next-app/src/lib/orgKind.ts` returning
   `"demo" | "customer" | "internal"` for an orgId — table-driven from
   a hardcoded list for v1 (`demo-org` → demo; everything else →
   customer; internal reserved for support tooling).
3. Create `functions_clean/_authz.js` with one export:
   `assertActorMember(orgId, uid)` that fails closed.
4. Retrofit the three highest-traffic V1 callables to call
   `assertActorMember` at the top: `closeIncidentV1`,
   `addEvidenceV1`, `assignJobOrgV1`.
5. Tighten the `match /orgs/{orgId}/...` block in `firestore.rules` to
   require a membership doc for read and write.
6. Extend `src/lib/onboarding/onboardingPersistence.ts` to set
   `orgType: "operator"`, `kind: "customer"`, `status: "active"`, and
   `ownerUserId: <creator uid>` when an org is created. (The
   onboarding flow already runs through this file from the prior
   pass.)
7. One-line backfill script in `next-app/scripts/backfillOrgFields.ts`
   that sets `kind: "customer"` on every existing org except `demo-org`
   (which gets `kind: "demo"`).

This is Phase 1's first slice. It establishes the foundation of the
invariant chain (`user → membership → org`) on the existing data without
breaking any current surface, and lays the only-shared-via-`_authz.js`
discipline that every subsequent phase depends on.

---

## Appendix — Cross-Reference to Architecture Invariants

Every phase must continue to honor the invariants from
`MULTI_ORG_RELATIONSHIP_MODEL.md` § Non-Negotiable Invariants. The
mapping:

| Invariant                                                       | Phase(s) where enforced                |
|------------------------------------------------------------------|-----------------------------------------|
| Org sovereignty                                                  | 1, 2, 7                                  |
| Relationship grants access, never ownership                      | 4, 5, 6, 7                              |
| Shares expose specific resources only                            | 5, 7                                    |
| Per-share scope can narrow but never widen                       | 5, 7                                    |
| Cross-org writes through Cloud Functions                         | 5, 7                                    |
| Billing never determines visibility                              | 6, 7, 8 (test matrix verifies)          |
| Demo / customer org separation                                   | 3, 7, 8                                 |
| Suspended relationships revoke future, preserve audit            | 4, 5                                    |
| Snapshot fields are display-only                                 | 4, 5, 7                                 |
| Every access decision traceable through the chain                | 1, 2, 4, 5, 7, 8                        |

If a phase's acceptance criteria fail to honor one of these invariants,
the phase is incomplete — re-derive the rule from the architecture doc
before merging.
