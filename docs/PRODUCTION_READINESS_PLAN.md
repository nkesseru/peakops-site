# PeakOps Production Readiness Plan

**Status:** Planning only. No code in this pass.
**Date:** 2026-05-06
**Scope:** Controlled pilot-customer readiness. NOT public launch, NOT
self-serve, NOT marketplace. The narrowest path to a single trusted
customer org running a real lifecycle in production.
**Source slices:** 1–12.1
**Source docs:** `MULTI_ORG_RELATIONSHIP_MODEL.md`,
`MULTI_ORG_IMPLEMENTATION_PLAN.md`, `LOCAL_EMULATOR_AUTH_RUNBOOK.md`.

---

## 0. Framing

This document defines the gating criteria between "the demo runs locally"
and "PeakOps is hosting one real customer's field operations." Every
section is written to be falsifiable — when a row in a checklist is
green, that's an objective state someone else can audit.

What this document is NOT:

- A go-to-market plan.
- A scaling plan (volume, multi-region, sharding).
- A relationship/cross-org rollout plan (Phase 2 work).
- A timeline. The phases below are sequenced; their cadence is
  whatever the team can execute.

What this document IS:

- The unblocking list between Slice 12.1 and one paying pilot.
- The production-safety contract that every change since Slice 1 has
  been building toward.
- The honest list of things still emulator-only or demo-only.

---

## 1. Current State Summary

### 1.1 Verified — production-safe by construction

| Capability | Why it's prod-safe |
|---|---|
| Default-deny Firestore rules | No `match /{document=**} { allow read, write: if true }` fallback (Slice 8). Every read/write requires explicit allow. |
| Member-doc-based authorization | Rules + callables both anchor on `orgs/{orgId}/members/{uid}` existence + active status. Custom-claim-only paths gone except for the chicken-and-egg member-self-seed at create time. |
| Role-aware callable gates | ~30 callables retrofitted through `_authz.js` (Slices 4–7, 9). Five role allow-lists named at every call site. |
| No emulator bypass on deployed surface | `jobAuthz.js` deleted in Slice 7.1. Every `require("./jobAuthz")` import is gone from `functions_clean/`. |
| Resource-integrity checks | Cross-tenant 404/409 leaks closed in Slices 4.1, 6.1, 9 (e.g. `getWorkflowV1`, `getIncidentPacketMetaV1`, `getIncidentNotesV1`, `approveAndLockJobV1`). |
| `_authz.js` chain trace audit logs | Every callable emits `authz_ok` / `authz_denied` with `{fn, orgId, [resource ids], uid, role, requiredRoles, code}`. |
| Demo/customer org isolation | `orgKind.ts` + `assertNotCrossKind` plumbing prevents demo↔customer crossing in seeds, member adds, and (if implemented) relationship invites. |
| `authedFetch` wrapper | Centralized Firebase ID-token attachment on every `/api/fn/*` call (Slice 12). Token-wait timeout (3000 ms) closes cold-load auth race. |
| Lifecycle UI auth-wait gate | Mission Control no longer fires `listIncidentsV1` before Firebase Auth state has resolved (Slice 12.1). |

### 1.2 Emulator-only (must be locked out of production)

| Surface | Production gate already in place |
|---|---|
| `/dev/login` page | Returns a 404 placeholder when `NODE_ENV === "production"`. Refuses to call the mint endpoint when `NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "1"`. |
| `/api/dev/mintCustomToken` | Returns 404 in production unless `?dev=1`; refuses to mint unless emulator-host env vars are set; only ever issues `alg: "none"` unsigned JWTs (production Firebase Auth rejects by design). |
| `/api/dev/createTestNotification` | Existing dev-only gate (404 in prod). |
| `/api/dev/seed-demo-evidence`, `/api/dev/reset-demo` | Server-side; existing dev-only gates. |
| `seedDemoMembership.ts`, `seedDemoRoleMembers.ts`, `seedDemoLifecycleFixtures.ts` | Seed scripts. Demo-org-only and refuse to operate against non-emulator/non-staging projects without `--allow-prod`. |
| `next-app/.env.local` emulator block | Gitignored. Emulator-mode flag (`NEXT_PUBLIC_USE_FIREBASE_EMULATORS=1`) and the `*_EMULATOR_HOST` server vars stay in personal `.env.local` files only. |

### 1.3 Demo-safe (works against demo-org but not exercised in production)

| Surface | Status |
|---|---|
| Onboarding flow | Wired against `demo-org` for the dev/staging walk-through. Persists to `orgs/{orgId}` + drafts. Production validation pending (§2.4). |
| Vendor admin (`/settings/vendors`) | Direct client writes allowed by rules for owner/admin via member doc. Production validation pending. |
| Member admin (`/settings/team`) | Same. Self-seed via custom claim is the only chicken-and-egg path that consults a custom claim. |
| Mission Control (`/incidents`) | Auth-wait gate added (Slice 12.1). `listIncidentsV1` reads dual-write paths. |
| Lifecycle pages (Field/Review/Summary) | Render lifecycle states cleanly under demo seed. Photo rail is empty for the new fixtures (no real Storage objects). |
| `assignVendorToJobV1` callable | Verified live in emulator (Slice 9 + 9.1 smoke). Production not exercised. |

### 1.4 Customer-safe (architecture/rules-level — production-deployable)

These are defined and verified in code/rules; their production deployment
just hasn't happened yet:

- Org/member/role schema (Slice 1–2 architecture).
- Membership backfill script + safety (Slices 1, 3).
- Demo-org bypass refusal at every relevant layer.
- All eight role-allow-list constants in `_authz.js`.
- All non-`/dev/*` /api/fn proxy routes via `enforceOrgAndProxy`.

### 1.5 Prototype / developer-only — not yet customer-facing

| Item | Why it's not customer-ready |
|---|---|
| Cross-org relationships | Architecture documented (`MULTI_ORG_RELATIONSHIP_MODEL.md`) but not implemented in code. |
| Vendor → customer orgType evolution | Same — modeled, not implemented. |
| Org-of-orgs / parent-child hierarchy | Out of v1 scope by design. |
| Real Stripe billing | Plan: free-collaborator vs operator vs hybrid. Not wired. |
| Telecom NORS / DIRS regulatory pipelines | Profile labels exist; filings are honest "future reporting support" copy. |
| Mobile-shell QA | The lifecycle UI is responsive but mobile-specific QA hasn't been run. |
| Public profile editor | `Org.publicProfile` field defined but no UI captures it. |
| Owner transfer flow | Out of v1 scope. |

---

## 2. Production Auth Plan

### 2.1 Real Firebase Auth magic-link flow

The production path is `/login`. It uses `sendSignInLinkToEmail` against
the real `peakops-pilot` project (`lib/auth.ts`). After Slice 11/12, the
`/login` form is unchanged in production (the dev `/dev/login` is hidden
behind `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=1` and `NODE_ENV !== "production"`).

**Verification needed before the first pilot:**
1. Send a magic link to a real `@peakops-pilot.com` test address from
   the production deploy.
2. Sign in. Confirm `auth.currentUser.uid` is the real production uid.
3. Confirm Mission Control's `listIncidentsV1` succeeds — proving the
   bearer-token chain through `enforceOrgAndProxy` →
   `requireOrgAccess` → `verifyAuthHeader` → `adminAuth.verifyIdToken`
   works against the real Firebase Auth signing key.

### 2.2 Production token verification

`adminAuth.verifyIdToken()` runs against real Firebase Auth in
production (no `FIREBASE_AUTH_EMULATOR_HOST` set, so `firebaseAdmin.ts`
loads `applicationDefault()` and validates against Google's signing
keys).

**Verification needed:**
1. Deploy `firebaseAdmin.ts` to production and confirm it boots without
   throwing on missing emulator hosts.
2. Hit any authenticated `/api/fn/*` endpoint with a real production
   token. Confirm `verifyIdToken` accepts.
3. Confirm an unsigned `alg:"none"` token (the dev variant) is rejected
   in production.

### 2.3 Removal of `/dev/login` in production

`/dev/login` and `/api/dev/mintCustomToken` are already 404 in
production builds (verified in code). Belt-and-braces:

1. CI smoke that hits `https://<prod-domain>/dev/login` and asserts 404
   on the deployed bundle.
2. CI smoke that hits `https://<prod-domain>/api/dev/mintCustomToken`
   and asserts 404.
3. A grep guard in CI that fails the build if any non-`/dev/*` route
   ends up importing `/api/dev/...`.

### 2.4 Production org membership creation

This is the single most load-bearing item in the plan. The Slice 8
default-deny rules require `orgs/{orgId}/members/{uid}` for every read.
Without member docs, every signed-in user gets 403 on everything except
their own `users/{uid}/...` data.

Three creation paths exist in code:

| Path | When it fires | Status |
|---|---|---|
| Bootstrap (first member of an org) | New org being provisioned | **Not yet implemented** (§5.1) — chicken-and-egg |
| Self-seed via custom claim | User holds an `orgIds` claim and writes their own member doc | Wired in `firestore.rules` `orgs/{orgId}/members/{memberId}` create rule. Requires server-side claim minting. |
| Owner/admin invite | Existing admin invites a teammate | Wired via `lib/orgMembers.ts` direct write (allowed by rules for owner/admin). |

**For pilot rollout, the only path that matters is bootstrap + first invites.** See §5.

### 2.5 Onboarding → member doc creation

`OnboardingClient.tsx` flows write to:
- `orgs/{orgId}` (name, industry, timezone, kind, orgType, status, ownerUserId)
- `orgs/{orgId}/onboarding/state`
- `orgs/{orgId}/inviteDrafts/...`
- `orgs/{orgId}/jobDrafts/...`

It does NOT currently create `orgs/{orgId}/members/{uid}`. In production,
that means a user running onboarding would land on a `permission-denied`
page after the first save (no member doc → no read access).

**Required**: extend onboarding's first save (the org-step persist) to
also write the owner's member doc atomically. This is a one-day code
change but it's a real production blocker.

### 2.6 First-org owner bootstrap flow

Two acceptable shapes:

**Option A: support-tooling provisioning.**
Internal admin tool that creates `orgs/{orgId}` + `members/{owner-uid}`
in a single transaction. Owner gets an invite link, signs in via
magic-link, lands on `/incidents?orgId=...`.

**Option B: self-serve bootstrap.**
A `bootstrapOrgV1` callable: any authenticated user can create one new
org with themselves as owner. Rate-limited; auditable. Rules permit
`orgs/{orgId}/members/{uid}` self-create when `orgs/{orgId}` doesn't
exist yet AND request.auth.uid == memberId.

For pilot, **Option A** is cleaner. Self-serve bootstrap is a Phase 2
concern when self-serve customers exist.

---

## 3. Production Firestore Rules Plan

### 3.1 Rollout strategy

The rules are already strict. The risk is not the rules themselves —
it's that real production data may not satisfy them.

**Data audit before deploy:**
1. List every `orgs/{orgId}` doc in `peakops-pilot`.
2. For each, list every uid that has ever read or written it (from
   audit log + recent function logs).
3. For every uid in that list, confirm `orgs/{orgId}/members/{uid}`
   exists with `status: "active"`.
4. If any are missing → backfill before deploy.

The backfill should be run via a one-off support script in
`next-app/scripts/`, similar in shape to `seedDemoMembership.ts` but
production-safe (`--allow-prod` required + audit log entry per write).

### 3.2 Avoiding customer lockout

For the pilot, there is no customer to lock out yet — but the internal
alpha (PeakOps team itself, see §9) will hit rules first.

**Pre-deploy gate:** every member of the PeakOps team that signs in
must have a member doc. Run the backfill script first, then deploy
rules.

**Deploy strategy:**
1. Stage the rules under a feature flag at the rules level — Firestore
   doesn't support that natively, so the equivalent is **deploying to a
   parallel project first** (`peakops-pilot-staging` if available), or
   using a controlled push window (after-hours, with rollback ready).
2. Tail the function logs for the first hour. If any callable emits a
   spike of `authz_denied` for known active users, halt and inspect.
3. Confirm `[mission-control] load failed Error: Invalid token` and
   `Missing Authorization header` errors stay at the no-traffic
   baseline.

### 3.3 Staged rollout

PeakOps doesn't have customers using production today. The "stages"
are therefore:

1. **Internal alpha** (PeakOps team, demo data in production project) —
   1 week stable.
2. **Single pilot customer** — 1 month stable.
3. **Per-vertical expansion** — telecom, then municipality, then
   contractor.

### 3.4 Monitoring / logging

Every `authz_ok` / `authz_denied` line from `_authz.js` lands in Cloud
Logging (it's a `console.log` / `console.warn`). Set up a saved Logs
Explorer query for each:

- `authz_denied` count per hour, alerting if it spikes.
- `authz_denied` grouped by `code` — `permission-denied` vs
  `unauthenticated` vs `not-found` separates "user lacks role" from
  "user not signed in" from "missing org doc."
- `authz_ok` baseline — to detect a sudden drop (which would mean the
  callables aren't being reached at all).

### 3.5 Rollback plan

Two layers:

- **Rules rollback**: keep the prior `firestore.rules` version archived;
  a `make rules-rollback` target deploys it. Production should NEVER
  re-introduce the wide-open wildcard fallback that pre-Slice-8 had —
  the rollback target is whichever last-known-good version still has
  default-deny.
- **Callable rollback**: Firebase Functions versioned. `firebase
  functions:rollback` restores the previous revision per function.

No need to roll back both together — the rules and callables are both
fail-closed, and either can be rolled forward independently.

---

## 4. Production Storage Plan

### 4.1 Bucket alignment

Two production buckets exist for legacy reasons:

- `peakops-pilot.appspot.com` (legacy default).
- `peakops-pilot.firebasestorage.app` (newer family).

Code in `createEvidenceReadUrlV1.js` already walks both as candidates.
For the pilot, **standardize on `peakops-pilot.firebasestorage.app`**
(the newer family Firebase recommends going forward).

**Verification needed:**
1. Confirm `firebase.json` storage rules apply to both buckets, OR
   confirm only one bucket is reachable from the app.
2. Confirm `getStorage().bucket()` (admin SDK default) resolves to the
   intended bucket in production.
3. Run an upload through `createEvidenceUploadUrlV1` → `addEvidenceV1`
   → `createEvidenceReadUrlV1` end-to-end and confirm the same bucket
   is referenced at each step.

### 4.2 Signed URL generation

`createEvidenceReadUrlV1.js` mints v4 signed URLs against the resolved
bucket. Production requirement: the runtime service account needs the
`iam.serviceAccounts.signBlob` permission on itself. Verify before pilot.

### 4.3 Evidence upload / read flows

End-to-end production smoke:
1. Create an incident.
2. Start a field session.
3. Upload one photo via the field UI.
4. Confirm the photo lands in the right Storage path.
5. Open the evidence locker page; confirm the thumb renders.
6. Open the report (if generated); confirm the photo embeds.

This is the single most stress-prone path in the lifecycle and the most
likely place to discover a bucket-misalignment bug in production.

### 4.4 Lifecycle image retention

Currently no lifecycle / retention policy is enforced. For pilot, this
is acceptable — every uploaded photo is retained indefinitely. **Define
a policy before second customer**: 7 years for compliance-sensitive
verticals (telecom NORS, FEMA grant), 90 days for transient field
photos.

### 4.5 Storage rules

`firebase/storage.rules` exists but isn't part of the Slice 8 rules
work. Audit before pilot:
- No public read on customer paths.
- Field crews can write to `orgs/{orgId}/incidents/{id}/uploads/` only
  if a member of `orgId`.
- Read scoped the same way.

---

## 5. Production Org Provisioning

### 5.1 First customer org bootstrap

Manual procedure for the first pilot customer:

1. Customer signs DPA + MSA.
2. PeakOps support engineer runs `bootstrapPilotOrgV1` (a script — to
   build) that:
   - Writes `orgs/{orgId}` with: `name`, `industry`, `industryProfileVersion`,
     `timezone`, `orgType` (operator/vendor/hybrid), `kind: "customer"`,
     `status: "active"`, `ownerUserId: <customer-owner-uid>`,
     `createdAt`, `createdBy: support-uid`.
   - Writes `orgs/{orgId}/members/{owner-uid}` with `role: "owner"`,
     `status: "active"`.
   - Audit log entry under `orgs/{orgId}/audit/`.
3. Sends owner a magic-link invite from `peakops-pilot`.
4. Owner signs in, lands on `/incidents?orgId=<their-org>`.

The script does NOT exist yet. **Recommended Slice 14 deliverable.**

### 5.2 Owner / admin assignment

Per the architecture model (`MULTI_ORG_RELATIONSHIP_MODEL.md` § 11),
owner is irreducible (one per org), set by `bootstrapPilotOrgV1`.
Admin can be added later by the owner via the Team admin UI.

### 5.3 orgType / kind / status defaults

For the first pilot:
- `orgType: "operator"` (the customer originates work)
- `kind: "customer"` (NOT `"demo"` — that's reserved for demo-org)
- `status: "active"`

Vendor pilots come later and use `orgType: "vendor"`. Hybrids start as
operators and flip when product confirms (Phase 2).

### 5.4 Industry profiles

`src/lib/onboarding/industryProfiles.ts` defines five profile keys:
utilities, telecom, municipality, contractor, other.

For the FIRST pilot, recommend **contractor**:
- Lowest regulatory ceiling (no NORS, no FEMA reporting).
- Existing PeakOps demo flow is contractor-shaped.
- Field-job lifecycle most directly maps.
- Profile labels are cleaner; no "future reporting support" copy.

Telecom and municipality should follow only after the first pilot has
proven the lifecycle end-to-end.

### 5.5 Vendor onboarding flow

The vendor admin UI (`/settings/vendors`) lets an admin create vendor
records. For the pilot, this is sufficient — the customer's admin adds
their existing vendors as catalog rows; vendor assignment to jobs goes
through `assignVendorToJobV1`. Real cross-org vendor relationships
(invite a vendor as their own org) is Phase 2.

---

## 6. Pilot Customer Readiness Checklist

### 6.1 Minimum viable onboarding

| Step | Owner | Verifies |
|---|---|---|
| Org bootstrapped via `bootstrapPilotOrgV1` (§5.1) | Support | Org doc + owner member doc exist |
| Owner signs in via magic link | Customer owner | Real Firebase Auth in prod works |
| Owner lands on `/incidents?orgId=...` | Customer owner | Mission Control loads under prod rules |
| Owner opens Settings → Team and invites their first admin | Customer owner | Member admin UI works in prod |
| Invited admin signs in, sees the org in their switcher | Invited admin | Member-doc-based authz round-trip |

### 6.2 First workflow

| Step | Verifies |
|---|---|
| Owner creates an industry-appropriate workflow template (or accepts the default) | Workflow templates render |
| Workflow visible to invited admin | Per-org workflow read scoped correctly |

### 6.3 First job

| Step | Verifies |
|---|---|
| Admin creates an incident via the inline form | `createIncidentV1` callable round-trip |
| Admin creates a job under the incident | `createJobV1` |
| Admin assigns a vendor (real, from their catalog) | `assignVendorToJobV1` |
| Field user (invited admin's role: field) starts a session | `startFieldSessionV1` |
| Field user uploads at least one photo | `createEvidenceUploadUrlV1` + `addEvidenceV1`; Storage upload works |
| Field user submits the field session | `submitFieldSessionV1` |
| Supervisor (different role) reviews, approves, or rejects | `approveJobV1` + role gates |
| Supervisor closes the incident | `closeIncidentV1` |

### 6.4 First report

| Step | Verifies |
|---|---|
| Supervisor generates timeline | `generateTimelineV1` |
| Supervisor generates filings (industry-appropriate) | `generateFilingsV1` |
| Supervisor exports the audit packet | `exportIncidentPacketV1` (the most stress-prone path; see §8.3) |
| Customer downloads + opens the packet PDF + ZIP | End-to-end artifact pipeline |

### 6.5 Support expectations

- One PeakOps engineer on call, business-hours, for the first 30 days.
- Direct Slack channel with the customer's primary admin.
- Bugs filed and triaged within 1 business day.
- Hard incidents (data loss, auth lockout) responded to within 1 hour.

### 6.6 Success criteria

- 1 incident lifecycle completed end-to-end in production (intake →
  field → review → close → report).
- Owner + at least 2 invited members signed in successfully via the
  real magic-link flow.
- Zero `authz_denied` events for known-active users.
- Zero customer-data-leak events (no cross-tenant reads in audit logs).
- Customer reports the lifecycle "feels real" in a post-pilot review.

---

## 7. Production Observability

### 7.1 Authz logs

Already emitted (`authz_ok` / `authz_denied` from `_authz.js`).
Required dashboard panels:

- Total `authz_denied` per hour, by `fn`.
- Grouped by `code` (`permission-denied`, `unauthenticated`,
  `not-found`).
- Top 10 uids by denial count (catches a stuck/looping client).
- `authz_ok` count per hour per `fn` (baseline + drop alerting).

### 7.2 Callable logs

Existing `[functions_clean] loaded <fn>` lines on emulator boot.
Production logs should add:

- Per-callable latency p50/p95.
- Per-callable error rate.
- `org_not_party_to_job` and `vendor_archived` business-rule denials
  separate from authz denials.

### 7.3 Incident / report audit logs

Currently the Firestore audit subcollections (`orgs/{orgId}/audit/`,
`orgs/{orgId}/relationships/{rid}/audit/`) are mostly aspirational.
For the pilot, at minimum log:

- Every state transition on incidents (open → in_progress → submitted
  → closed).
- Every job approval / rejection / vendor assignment.
- Every report packet export — with `requestedBy`, generated artifact
  hash, and bucket/path.

### 7.4 Error reporting

- Wire **Sentry** (or equivalent) to client + functions.
- Tag every error with `orgId`, `uid`, `fn`, `incidentId` where
  available.
- Alert on new error signatures.

### 7.5 Crash monitoring

- Browser crash reports via Sentry's React integration.
- Server-side function crashes via Cloud Logging error reports.
- Storage callback failures (HEIC conversion, derivative generation)
  surfaced separately — these don't crash but they degrade UX.

### 7.6 Alerting

For pilot:
- **P0** (page on-call immediately): `authz_denied` spike > 50/hour for
  any known-active uid; production rules deploy fail; storage upload
  proxy 5xx > 10/hour.
- **P1** (Slack alert): report-export failures > 5/hour; lifecycle
  state transition failures > 10/hour.
- **P2** (daily digest): novel error signatures.

---

## 8. Remaining High-Risk Areas

### 8.1 Raw `fetch` surfaces not yet migrated

Slice 12 documented these but did not migrate them:

- `app/admin/contracts/page.tsx`
- `app/admin/contracts/[id]/payloads/page.tsx`
- `app/admin/contracts/[id]/packet/page.tsx`
- `app/admin/usage/page.tsx`
- `app/admin/_components/GuidedWorkflowPanel.tsx`
- `app/admin/incidents/_components/WorkflowPanel.tsx`
- `app/admin/incidents/[id]/page.tsx`
- `app/admin/incidents/page.tsx`
- `src/app/supervisor/incidents/[id]/page.tsx`
- `src/app/supervisor/incidents/page.tsx`

Under the new proxy + rules layer, every one of these will return 401
in production until migrated to `authedFetch`. **Pilot blocker if
admin/supervisor surfaces are part of pilot scope.**

### 8.2 Storage edge cases

- Bucket-family flip (`appspot.com` vs `firebasestorage.app`) — the
  signed-URL prober walks candidates, but the upload proxy may pick a
  different one than `addEvidenceV1` records.
- HEIC → JPEG conversion (`convertHeicOnFinalize`) reliability under
  load.
- Signed-URL expiry (10 min for upload, 15 min for read) — short
  enough that a slow customer upload fails midway.

### 8.3 Report generation reliability

`exportIncidentPacketV1.js` is the longest and most complex callable
in the project (1200+ lines). It assembles:
- the audit-ready PDF,
- the evidence ZIP,
- per-filing artifacts,
- the manifest with hashes for ZIP verification.

Risks:
- Memory pressure on a large incident (100+ photos).
- Storage timeout assembling the ZIP.
- Per-photo conversion failures bubbling up.

**Pilot mitigation**: cap incidents at 50 photos for the first month;
soft-fail on individual conversion errors; surface a "regenerate"
affordance.

### 8.4 Mobile QA gaps

The lifecycle UI uses responsive layouts but no device-specific testing
has been done. Field crews will use phones. Required before pilot:

- iOS Safari + Android Chrome on the field-session capture flow.
- Photo upload from mobile (different EXIF, HEIC handling).
- Touch-target sizing on Field Job page.
- Offline behavior (assume some field uploads happen on poor LTE).

### 8.5 Onboarding persistence gaps

`OnboardingClient.tsx` writes drafts but doesn't yet:

- Bootstrap the owner's member doc (§2.5).
- Convert invite drafts to real invite tokens (still draft-only).
- Convert first-job draft to a real incident (still draft-only).

For the pilot, the support engineer hand-creates the org via §5.1 and
the customer skips onboarding. Onboarding-as-self-serve is a Phase 2
deliverable.

### 8.6 Relationship-sharing not implemented

`MULTI_ORG_RELATIONSHIP_MODEL.md` defines the full vendor↔customer
relationship model. None of it is implemented in code. For pilot,
this is acceptable — first pilot is a single-org operator. Cross-org
vendor relationships are Phase 2.

### 8.7 Production firebaseAdmin re-init contract

`lib/firebaseAdmin.ts` (Slice 10) decides emulator-vs-production at
module-init time based on env vars. Verify in production:

- No `FIREBASE_AUTH_EMULATOR_HOST` set in the production runtime.
- `applicationDefault()` resolves to a real service-account credential.
- `adminAuth.verifyIdToken()` validates tokens against Google's signing
  keys (not the emulator).
- `adminAuth.createCustomToken()` works (signs against the real key).

A 5-minute production smoke covers all four.

### 8.8 Carryover items (acknowledged in earlier slice reports)

- `addMaterialV1` and `approveFieldSessionV1` were retrofitted in
  Slices 3/4 but only wired into `index.js` in Slice 7.1. Confirm the
  production deploy includes those exports.
- `jobAuthz.js` deletion (Slice 7.1) — confirm no production runtime
  is still cached against the old bundle.
- `setEvidenceLabelV1` had a pre-existing `db`-before-declaration bug
  fixed in Slice 7. Confirm the production deploy carries the fix.

---

## 9. Production Rollout Recommendation

### 9.1 Internal alpha (Stage 0)

PeakOps team uses production `peakops-pilot` themselves as a real
customer org. 1 week minimum.

- One bootstrap-pilot-org for the PeakOps internal team.
- Each engineer + designer signs in via real magic link.
- Walk a real lifecycle (one of the team posts a fake incident).
- Triage every novel error before opening to outside customers.

**Exit criteria**: zero novel error signatures in 48 hours of normal
team use.

### 9.2 Single contractor pilot (Stage 1)

The first paying pilot. Industry: **contractor** (per §5.4). Profile:

- 5–15 person org, single workflow type, low regulatory load.
- Admin or owner who is technical enough to triage UX issues.
- Existing relationship with PeakOps (informal partnership, prior
  conversations) — NOT a cold customer.
- Geographic and timezone proximity to the PeakOps team.

1 month minimum at this stage.

**Exit criteria**: §6.6 success criteria met. Customer wants to keep
using it after the pilot.

### 9.3 Telecom pilot (Stage 2)

Telecom adds NORS/DIRS reporting expectations. Must NOT be a first
pilot — the regulatory copy is honest about "future reporting support"
status, but a telecom customer's expectation is high.

Wait until contractor pilot is settled and at least one telecom
relationship is in place to spec the reporting realistically.

### 9.4 Municipality pilot (Stage 3)

Municipality adds FEMA / grant-ready expectations. Same posture as
telecom — defer until the operational lifecycle is proven and a real
municipality relationship can scope the reporting.

### 9.5 Staged org rollout (Stage 4)

Once Stages 1–3 each have one stable customer, opening additional
slots per industry. Still no public self-serve. Each new org is
hand-bootstrapped by support.

### 9.6 Public self-serve

Out of scope of this document. Has its own readiness checklist
(see `MULTI_ORG_IMPLEMENTATION_PLAN.md` § "Before Public Self-Serve").
Probably ≥ 6 months after Stage 1.

---

## 10. Slice 14 Recommendation

**Slice 14: production org bootstrap script + admin/supervisor
surface migration to `authedFetch`.**

Two parallel work streams in one slice:

### 10.1 `bootstrapPilotOrgV1` script

Located at `next-app/scripts/bootstrapPilotOrgV1.ts`. Behavior:

- `--allow-prod` required (production-aware).
- Inputs: `--orgId`, `--orgName`, `--industry`, `--ownerUid`,
  `--ownerEmail`, `--orgType`, `--timezone`.
- Writes `orgs/{orgId}` with all required fields.
- Writes `orgs/{orgId}/members/{ownerUid}` with `role: "owner"`,
  `status: "active"`.
- Atomic batched write so partial failure leaves no orphan org.
- Audit-log entry at `orgs/{orgId}/audit/bootstrap_<ts>` with the
  support engineer's identity.
- Refuses to run if org already exists (use `--force` to overwrite,
  rare).

### 10.2 Admin/supervisor surface migration

Migrate the 10 admin / supervisor pages listed in §8.1 from raw
`fetch("/api/fn/...")` to `authedFetch`. Mechanical work, but
necessary so those pages don't 401 in production.

### 10.3 Production smoke checklist

After Slice 14 deployment, run a one-page checklist:

- [ ] `/login` magic link sends from production.
- [ ] Signed-in user lands on `/incidents?orgId=<their-org>`.
- [ ] Mission Control loads.
- [ ] One end-to-end lifecycle (intake → close → report) completes.
- [ ] No `authz_denied` in logs for the test session.
- [ ] No `Missing Authorization header` 401s on the admin pages.

After this slice and its smoke, the project is one customer-bootstrap
away from a paid pilot.

---

## Appendix — Top 10 Production Blockers (ranked)

| # | Blocker | Severity | Current state |
|---|---|---|---|
| 1 | **No production org bootstrap script** (§5.1) | P0 | Doesn't exist; recommended for Slice 14 |
| 2 | **Onboarding doesn't write member doc for owner** (§2.5) | P0 | Code change pending |
| 3 | **Admin/supervisor surfaces still on raw `fetch`** (§8.1) | P0 | 10 files; recommended for Slice 14 |
| 4 | **Storage bucket alignment unverified** (§4.1) | P1 | Ambiguous between `appspot.com` and `firebasestorage.app` families |
| 5 | **Production token verification not exercised** (§2.2) | P1 | `firebaseAdmin.ts` change not yet booted in prod |
| 6 | **Production member backfill for existing users** (§3.1) | P1 | Unknown how many existing prod users lack member docs |
| 7 | **No observability dashboard for `authz_denied`** (§7.1) | P1 | Logs exist; dashboard doesn't |
| 8 | **No mobile QA on lifecycle pages** (§8.4) | P1 | Field crews use phones |
| 9 | **Report-export memory/timeout limits** (§8.3) | P2 | Stress-test before first 50+ photo incident |
| 10 | **Sentry / error reporting not wired in production** (§7.4) | P2 | First novel bug will be invisible until fixed |

---

## Appendix — Recommended Rollout Order (compact)

1. **Slice 14**: org bootstrap script + admin/supervisor `authedFetch`
   migration + onboarding member-doc bootstrap.
2. **Production deploy** of Slices 1–14 to `peakops-pilot`.
3. **Internal alpha**: PeakOps team uses production for one week.
4. **First contractor pilot**: 1 month, hand-bootstrapped, support
   on-call.
5. **Telecom pilot**: one quarter later, after contractor stabilizes.
6. **Municipality pilot**: when relationship-sharing (Phase 2) is
   underway.
7. **Per-vertical expansion**: hand-bootstrapped, support-curated.
8. **Public self-serve**: separate readiness pass; ≥ 6 months out.

---

## Appendix — Recommended First Pilot-Customer Profile

- **Industry**: contractor.
- **Size**: 5–15 active members.
- **Workflow**: a single, recurring field operation (e.g. inspection
  routes, splice verification, trench audits).
- **Geography**: same timezone as PeakOps team.
- **Relationship**: existing partnership / prior conversation; NOT a
  cold customer.
- **Technical contact**: at least one admin or owner who can triage
  UX bugs in Slack within a business day.
- **Regulatory exposure**: low (no NORS, no FEMA, no grant
  reporting).
- **Volume**: ≤ 50 photos per incident, ≤ 5 active incidents at a
  time, ≤ 20 incidents/month.
- **Patience**: explicitly told the product is in pilot; expects
  rough edges; willing to provide feedback.

---

## Appendix — Go / No-Go Criteria for First Live Org

A go-decision requires every line below to be true at the moment of
bootstrap.

**Auth & rules**
- [ ] `firestore.rules` deployed; default-deny verified by hitting an
      unauthenticated read in production and getting 403.
- [ ] `_authz.js` chain trace verified by hitting `/api/fn/listIncidentsV1`
      as a real signed-in user and getting 200 + `authz_ok` in logs.
- [ ] `/dev/login` returns 404 in production (verified by curl).
- [ ] `/api/dev/mintCustomToken` returns 404 in production (verified
      by curl).

**Provisioning**
- [ ] `bootstrapPilotOrgV1` script exists, tested against staging,
      reviewed by at least one other engineer.
- [ ] Owner uid + email confirmed with the customer.
- [ ] Run script against production with `--allow-prod`.
- [ ] Verify `orgs/{orgId}` doc exists with all required fields.
- [ ] Verify `orgs/{orgId}/members/{ownerUid}` exists with
      `role: "owner"`, `status: "active"`.
- [ ] Audit-log entry visible.

**Storage**
- [ ] Single bucket family chosen and enforced
      (`peakops-pilot.firebasestorage.app`).
- [ ] One end-to-end production photo upload completed.
- [ ] Signed read URL successfully fetched from a different session.

**UI surfaces**
- [ ] Mission Control loads as the owner.
- [ ] Settings → Team works (owner sees themselves).
- [ ] Settings → Vendors works (empty list, ready for first add).
- [ ] All admin / supervisor surfaces in §8.1 migrated to `authedFetch`
      AND verified to return 200 (not 401) for a real prod admin.

**Observability**
- [ ] `authz_denied` log query saved + dashboarded.
- [ ] On-call engineer paged to the relevant queue.
- [ ] Sentry (or equivalent) wired to client + functions.

**Communication**
- [ ] DPA + MSA signed by customer.
- [ ] Customer informed in writing of pilot expectations (rough edges,
      bug-triage SLA, support hours).
- [ ] Slack channel established.
- [ ] Customer's first admin signs in successfully via real magic link
      AND can read their org's data.

**No-go triggers** (any one of these blocks the launch):

- Any production `authz_denied` for a known-active uid in the last 24
  hours.
- Any `Missing Authorization header` 401 on a non-public route in the
  last 24 hours.
- Any cross-tenant read in audit logs.
- Customer-side DPA/MSA not signed.
- On-call engineer not available for the pilot's first 48 hours.
- Storage bucket misalignment unresolved.

---

End of document.
