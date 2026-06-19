# PEAKOPS MULTI-ORG RELATIONSHIP MODEL — V1

**Status:** Architecture-definition only. Not implementation.
**Date:** 2026-05-06
**Scope:** Foundational model for org sovereignty + cross-org collaboration.

---

## 0. Architecture Overview

PeakOps customers do not operate in isolation. A municipality coordinates with
utility companies; a utility dispatches contractors; a contractor pulls in
specialty subcontractors and vendors. Each of these parties is its own
business with its own data, payroll, compliance posture, and customers.

This model defines how PeakOps represents that reality without collapsing it
into a single tenant or sprouting a parent-org hierarchy:

1. **Organizations are sovereign.** Each org owns its members, its data, its
   billing, and its compliance posture. No organization is "inside" another.
2. **Relationships grant collaboration.** Two orgs that want to work together
   create an explicit, two-sided relationship. Either side can pause or
   terminate it.
3. **Work is shared, not transferred.** When Org A shares an incident with
   Vendor B, the incident still belongs to A. B gets a scoped view + a scoped
   set of write actions, governed by the relationship.
4. **Vendors can evolve into customers.** The same `orgs/{orgId}` doc can act
   as vendor in one relationship and customer in another. Org type is a
   property of the relationship, not the org's identity.
5. **Data remains securely siloed.** Default deny. Cross-org reads happen
   only through explicit shares; security rules check membership in the
   right orgs.

The model has four primitives:

```
                    ┌──────────────────┐
                    │      Org         │  sovereign
                    │  orgs/{orgId}    │
                    └────────┬─────────┘
                             │ 1..N
                             │
                  ┌──────────┴──────────┐
                  │                     │
         ┌────────▼────────┐   ┌────────▼────────┐
         │   Membership    │   │  Relationship   │
         │  (per user)     │   │  (per partner)  │
         └─────────────────┘   └────────┬────────┘
                                        │ 0..N
                                        │
                              ┌─────────▼─────────┐
                              │  Shared Resource  │
                              │ (incident/etc.)   │
                              │ + ScopeDescriptor │
                              └───────────────────┘
```

The rest of this document specifies each primitive, the rules that govern
them, and what is intentionally out of scope.

---

## Non-Negotiable Invariants

These are the rules the rest of the document is built to uphold. If a future
schema change, UI shortcut, or feature request would violate one of these, it
is the change that needs revision — not the invariant.

- **Org sovereignty.** Every org is its own root of trust. No org can read,
  write, suspend, or bill another. Platform staff have no implicit access;
  they must hold an explicit membership in the org they act on.
- **Relationship grants access, never ownership.** A relationship between two
  orgs unlocks scoped collaboration. It never transfers, copies, or
  co-assigns ownership of any resource. The owning org always remains the
  owning org.
- **Shares expose specific resources only.** A share is per-resource (today:
  per-incident). There is no "share my whole org" primitive. Reading
  resource A through a share never grants any access to resource B in the
  same org.
- **Per-share scope can narrow but never widen relationship defaults.**
  Composition is intersection: any field set to `false` in either the
  relationship default or the per-share override is `false` in the
  effective scope. Validation rejects override docs that try to widen.
- **Cross-org writes go through Cloud Functions.** Direct rules permit
  scoped cross-org reads. All writes to a partner's resource (vendor adding
  evidence, advancing state, closing) funnel through callable functions
  that re-validate scope server-side and write with the admin SDK. The
  most sensitive permission logic lives in one place, not in rules.
- **Billing never determines visibility.** A free-collaborator vendor sees
  exactly what their scope grants. A paying enterprise org sees exactly
  what their scope grants. Plan tier, seat count, and payment status are
  invisible to the access-decision path.
- **Demo and customer org separation.** Demo orgs (e.g. `demo-org`) are
  isolated tenants. No real customer org may share with, relate to, or
  borrow members from a demo org. No demo org may be billed. Demo data is
  not seeded into customer orgs and customer data is never leaked into
  demo orgs.
- **Suspended relationships revoke future access but preserve audit
  history.** Pause/terminate immediately blocks new shares and (on
  terminate) revokes existing shares. The relationship doc, its audit
  subcollection, and the historical share records remain — they are
  evidence of what was true, when, and who decided.
- **Snapshot fields are display-only.** `partnerOrgName` on a relationship,
  `ownerOrgName` on an inbound share, `snapshot.title/state` on the inbound
  index — all are best-effort caches refreshed by triggers. Authorization
  decisions, billing decisions, and audit records must read the source of
  truth (the partner's `orgs/{orgId}` doc, the owner's incident), never a
  snapshot.
- **Every access decision is traceable.** Any read or write must be
  explainable as a chain: `user → membership → org → relationship → share
  scope → resource`. Each link in the chain is a real document with an id,
  a status, and a timestamp. If any link is missing, the access is denied.
  This chain is what makes the system auditable, and it is what we test
  against in the security-rules cross-org test matrix.

---

## Canonical Vendor Upgrade Scenario

The model has to support one recurring real-world story end-to-end without
breaking any invariant. This is that story.

**Act 1 — Free collaborator.**
A city (operator org `org_city`) needs a small contractor for a one-off
storm-response splice. The city sends a relationship invite. The contractor
signs up, runs onboarding, and creates `org_vendor` with `orgType: "vendor"`.
The mirrored relationship docs go `active`; the contractor is a
**free collaborator** (`billing.freeCollaborator: true`, `plan: "free"`).

**Act 2 — Working assigned shared jobs.**
The city shares a handful of incidents with the contractor under the **Field**
scope preset. The contractor's field crew sees them in their Inbound view,
captures evidence, advances state, and adds notes. Every cross-org write
goes through a Cloud Function that re-validates the share scope. Ownership
of every incident remains `org_city`. The contractor org has originated
zero incidents; their dashboard correctly shows "no work originated yet."

**Act 3 — Vendor decides to run their own ops in PeakOps.**
Months later, the contractor wants to use PeakOps to run their own
multi-customer dispatch. From Settings they flip `org_vendor.orgType` from
`vendor` to `hybrid`. This triggers:

- Billing reclassification: `freeCollaborator` is now disqualified. A
  30-day grace window begins; after grace they move to `plan: "team"`.
- The Operator UX surfaces unlock in their shell (Jobs originator,
  workflow templates, partner invitations of their own).
- **No data is migrated, copied, or re-owned.** Every existing inbound
  share continues to point at the city's incidents; the contractor still
  has no ownership stake in city work. The city's experience is
  unchanged — they did not need to approve the upgrade and were not
  notified at this layer (though a future product surface might inform
  them).

**Act 4 — Vendor originates their own work.**
The contractor creates incidents under `org_vendor/incidents/...`. These are
**theirs**, fully private by default. They invite their own subcontractors;
those become a new vendor relationship from `org_vendor`'s side. If the
contractor wants to expose any of their own incidents back to the city,
they do so explicitly through the existing relationship (which is already
`active`, just with the contractor as the share *owner* this time, not the
recipient).

**The relationship persists.**
Throughout all four acts, the original `org_city ↔ org_vendor` relationship
keeps the same `relationshipId`. Its `status` stays `active`. The `type` on
the city's mirror remains `vendor`; the contractor's mirror remains
`customer`. What changes is what each side *does* with it: shares flow in
both directions now, the contractor adds the city to their own outbound
share decisions, and either side can pause or terminate it without
affecting the other relationships either org has built.

**Invariants checked against the scenario:**

- Org sovereignty: city never gains access to vendor-originated incidents,
  and vice versa, except through explicit shares. ✓
- Relationship grants access, never ownership: city-owned jobs stay
  city-owned; vendor-owned jobs are private until shared. ✓
- Shares expose specific resources only: the contractor's broader
  originated work is not exposed to the city by virtue of the existing
  relationship. ✓
- Billing never determines visibility: the upgrade from free to paid plan
  changes nothing about what either org can see; it changes who pays. ✓
- Demo/customer separation: this scenario uses two real orgs; `demo-org`
  is not involved and would not have been a valid party. ✓
- Audit traceability: every state transition (invite, accept, orgType
  flip, billing reclassification, share grant, share revoke) is a
  recorded event on the right org's audit subcollection. ✓

---

### Implementation Guardrail

Before any code is written, **the security rules and the Cloud Function
boundary must be designed from the invariants above, not from UI
convenience.** UI surfaces are allowed to make scope decisions easier to
express (presets, defaults, copy), but the underlying access control must
be derivable from the invariants alone. If the only reason a permission
exists is "the UI assumes it," the invariants are being eroded —
re-derive the rule from first principles before shipping.

---

## 1. Firestore Collection Structure

Three layers: top-level identity, per-org sovereign data, and cross-org
indexes for query efficiency.

```
# Top-level (identity + cross-org tokens)
users/{userId}                                       # global identity
users/{userId}/memberships/{orgId}                   # denormalized org list
relationshipInvites/{inviteId}                       # pending invite tokens

# Per-org sovereign data
orgs/{orgId}                                         # the Org doc itself
orgs/{orgId}/members/{userId}                        # membership records
orgs/{orgId}/incidents/{incidentId}                  # owned work (existing)
orgs/{orgId}/workflows/{workflowId}                  # owned templates (existing)
orgs/{orgId}/onboarding/state                        # onboarding state (existing)
orgs/{orgId}/billing/config                          # billing config

# Per-org cross-org collaboration
orgs/{orgId}/relationships/{relationshipId}          # one mirror per side
orgs/{orgId}/relationships/{relationshipId}/audit/   # transition history
orgs/{orgId}/inboundShares/{shareId}                 # what's shared INTO us
                                                     # (denormalized index;
                                                     #  source of truth lives
                                                     #  on the owner's incident)
```

Two notes on this layout:

- **Top-level `incidents/{...}` is intentionally not used.** Incidents stay
  under their owning org. Cross-org reads use the denormalized
  `inboundShares` index plus a one-hop fetch to the owner's path.
- **Relationships are mirrored, not single.** The same `relationshipId`
  appears as a doc in both orgs' subcollections. Either side reads/writes
  its own copy. State convergence is by application logic, not DB primitive.

---

## 2. Org Object Schema

```typescript
// orgs/{orgId}
type Org = {
  orgId: string;                  // doc id
  name: string;
  industry: IndustryKey;          // utilities | telecom | municipality |
                                  // contractor | other
  industryProfileVersion: string; // matches lib/onboarding/industryProfiles
  timezone: string;

  // Sovereignty
  ownerUserId: string;            // root owner, irreducible (one per org)
  createdAt: Timestamp;
  createdBy: string;

  // How this org behaves in relationships
  orgType: "operator" | "vendor" | "hybrid";
  // operator = primary work originator (utility, municipality, telecom,
  //            contractor that originates jobs)
  // vendor   = invited collaborator that does not originate work
  //            (specialty crew, narrow-scope subcontractor)
  // hybrid   = both — originates AND subs to others

  // Public discovery surface (visible to potential partners during invite)
  publicProfile: {
    displayName: string;
    summary?: string;             // one-line description
    serviceArea?: string;         // e.g. "Pacific Northwest"
    industries?: ReadonlyArray<IndustryKey>;
  };

  // Operational state
  status: "active" | "suspended" | "archived";

  // Denormalized counts (best-effort, not authoritative — recomputed by
  // a maintenance job, used for list rendering only)
  memberCount: number;
  activeRelationshipCount: number;

  // Onboarding linkage (already exists)
  onboardingUpdatedAt?: Timestamp;

  updatedAt: Timestamp;
};
```

### Why `orgType` is on the Org, not derived

A pure-vendor org gets a different default UX (no Jobs originator surface,
billing-free tier, fewer onboarding steps). We don't want to recompute that
classification on every render — pin it on the org doc, set during onboarding
based on industry + initial relationship intent, and let the user flip it
later through Settings.

---

## 3. Membership Schema

Membership is **always within one org**. A user with two orgs has two
membership records.

```typescript
// orgs/{orgId}/members/{userId}
type Membership = {
  userId: string;                 // doc id = Firebase auth uid
  orgId: string;

  role: "owner" | "admin" | "supervisor" | "field" | "viewer";

  status: "active" | "invited" | "suspended" | "removed";

  invitedBy?: string;             // userId of inviter
  invitedAt?: Timestamp;
  joinedAt?: Timestamp;

  // Per-surface permissions within THIS org's data.
  // (Cross-org actions are governed by the share's ScopeDescriptor, not
  //  this object.)
  permissions: {
    incidents:    { create: boolean; assign: boolean; close: boolean };
    workflows:    { edit: boolean };
    members:      { invite: boolean; manage: boolean };
    relationships:{ manage: boolean };
    billing:      { view: boolean; manage: boolean };
  };

  updatedAt: Timestamp;
};
```

### Global identity

```typescript
// users/{userId}
type User = {
  uid: string;                    // doc id = Firebase auth uid
  email: string;
  displayName: string;

  primaryOrgId?: string;          // last-active org for shell default

  createdAt: Timestamp;
};

// users/{userId}/memberships/{orgId}
// Denormalized "what orgs am I in" for the org-switcher. Kept in sync by
// a server function that mirrors orgs/{orgId}/members/{uid} writes here.
type UserMembership = {
  orgId: string;
  orgName: string;                // snapshot for display
  role: Membership["role"];
  joinedAt: Timestamp;
  lastActiveAt?: Timestamp;
};
```

### Role semantics

| Role        | Within-org capability                                          |
|-------------|----------------------------------------------------------------|
| owner       | Everything. Cannot be removed via UI. Exactly one per org.     |
| admin       | Members, relationships, billing read. No ownership transfer.   |
| supervisor  | Manage incidents (create/assign/close); cannot manage members. |
| field       | Work assigned incidents; capture evidence; add notes.          |
| viewer      | Read-only. Used for auditors / inactive members / executives.  |

A member's role within their **own** org does not grant them anything in a
**partner** org. Cross-org capability is always derived from the share's
`ScopeDescriptor` plus their role in their own org.

---

## 4. Relationship Schema

A relationship is the explicit collaboration link between two orgs. It is
**mirrored**: one doc lives under each org, both share the same
`relationshipId`.

```typescript
// orgs/{orgId}/relationships/{relationshipId}
type Relationship = {
  relationshipId: string;         // shared id across both mirror copies

  // Which org owns THIS copy
  selfOrgId: string;
  // The other party
  partnerOrgId: string;
  partnerOrgName: string;         // snapshot — display only, refresh job
                                  // mirrors orgs/{partnerOrgId}.name
  partnerOrgType: Org["orgType"];

  // Classification — describes the partner's role FROM SELF's perspective.
  // The mirrored doc on the partner side typically has the inverse.
  type: "vendor" | "customer" | "peer";
  // vendor   = partner provides services to me
  // customer = I provide services to partner
  // peer     = equal collaboration (mutual aid, joint operations)

  // Lifecycle
  status:
    | "invited"      // I sent invite, awaiting partner accept
    | "pending"      // partner sent invite, awaiting my accept
    | "active"       // both sides accepted
    | "paused"       // suspended by either side; no new shares; existing
                     //   shares stay active until expiry or revoke
    | "terminated";  // ended; existing shares revoked; record retained

  initiatedBy: string;            // userId of inviter
  initiatedAt: Timestamp;
  acceptedAt?: Timestamp;
  pausedAt?: Timestamp;
  pausedBy?: string;
  terminatedAt?: Timestamp;
  terminatedBy?: string;
  terminatedReason?: string;

  // Default scope applied to every share through this relationship.
  // Per-share overrides may NARROW this; never widen it.
  defaultScope: ScopeDescriptor;

  // Operator-side organization (e.g. "Storm response 2026", "Tier-1 splice")
  tags: ReadonlyArray<string>;

  updatedAt: Timestamp;
};
```

### One-relationship-per-direction-per-pair invariant

A pair of orgs (A, B) may have at most:
- one relationship where A.type = "vendor" / B.type = "customer"
- one relationship where A.type = "customer" / B.type = "vendor"
- one relationship where both sides have type = "peer"

These are independent — a pair can hold all three simultaneously (rare), and
each is its own mirrored doc pair.

### Invite tokens (pre-acceptance state)

```typescript
// relationshipInvites/{inviteId}
type RelationshipInvite = {
  inviteId: string;               // doc id; URL-safe random
  fromOrgId: string;
  fromOrgName: string;            // snapshot
  fromUserId: string;             // who sent it

  // Recipient may not have an org yet — invite carries enough to seed one
  toEmail: string;
  toOrgId?: string;               // set if recipient already has an org
  proposedType: "vendor" | "customer" | "peer";  // from sender's POV
  proposedDefaultScope: ScopeDescriptor;

  status: "open" | "accepted" | "declined" | "expired" | "revoked";
  expiresAt: Timestamp;           // 7 days from createdAt by default
  createdAt: Timestamp;
  consumedAt?: Timestamp;
};
```

When a recipient with no org clicks the link, they run onboarding (creating
a vendor-typed org) and then accept the invite — at which point we create the
two mirror Relationship docs and delete the invite token.

---

## 5. Relationship Permission Model — `ScopeDescriptor`

A `ScopeDescriptor` answers two questions: *what can this partner read* and
*what can this partner do*.

```typescript
type ScopeDescriptor = {
  // Resource read — coarse-grained, NOT per-attribute
  read: {
    summary:  boolean;            // title, state, location, owner org name
    detail:   boolean;            // full incident body, description
    evidence: boolean;            // photos, signatures, attachments
    timeline: boolean;            // audit log / state transitions
    pii:      boolean;            // names, contacts, addresses (default false)
  };

  // Resource action
  write: {
    addEvidence:    boolean;      // upload photos, sign attestations
    addNotes:       boolean;      // add free-text notes / comments
    advanceState:   boolean;      // can move state forward in lifecycle
    assignMembers:  boolean;      // assign their OWN org's members
    closeIncident:  boolean;      // mark incident closed (terminal action)
  };

  // Member visibility — does the partner see who's working what?
  members: {
    seePartnerRoster: boolean;    // can they see OWNER org's member list
    exposeOwnRoster:  boolean;    // do their own members appear to OWNER
  };

  // Time bound — null means open-ended
  expiresAt?: Timestamp;
};
```

### Composition rule

When sharing an incident through a relationship:

```
effectiveScope = relationship.defaultScope ∩ incident.shareOverride
                                            // override may NARROW only
```

Any field set to `false` in either layer becomes `false` in the effective
scope. Validation rejects override docs that set a field to `true` when the
relationship default is `false`.

### Recommended scope presets

For v1 UX, expose three preset names that map to ScopeDescriptors. The user
never builds one byte-by-byte:

| Preset       | Use case                                | Default for     |
|--------------|------------------------------------------|------------------|
| **Observer**     | Customer / auditor / read-only viewer  | type=customer    |
| **Field**        | Vendor doing the work in the field     | type=vendor      |
| **Joint Ops**    | Mutual aid / shared incident control   | type=peer        |

Concrete preset values:

```
Observer:  read={summary,detail,timeline}, write={}, members={seeOwn,hidePartner}
Field:     read={summary,detail,evidence}, write={addEvidence,addNotes,advanceState},
                                            members={seeOwn,exposeRoster}
Joint Ops: read=ALL except pii, write={addEvidence,addNotes,advanceState,assignMembers},
                                          members={both true}
```

`pii=true` is never part of a preset. It must be enabled deliberately, with
an audit-log entry capturing who and why.

---

## 6. Shared Operational Scope Model

Sharing an incident attaches metadata to both sides: an authoritative record
on the owner's incident, and a denormalized pointer in the recipient's
inbound index.

```typescript
// orgs/{ownerOrgId}/incidents/{incidentId}
// Existing incident doc — adds a shareSettings field.
type IncidentShareSettings = {
  shareSettings: {
    // Queryable list — security rules and queries pivot off this.
    sharedWithOrgIds: string[];

    // Per-partner scope detail. Overrides may NARROW the relationship default.
    shares: {
      [partnerOrgId: string]: {
        scope: ScopeDescriptor;
        sharedBy: string;             // userId
        sharedAt: Timestamp;
        sharedVia: string;            // relationshipId
        revokedAt?: Timestamp;
      };
    };
  };
};

// orgs/{recipientOrgId}/inboundShares/{shareId}
// Recipient queries THIS subcollection for "what's been shared with us".
// The actual incident lives at the owner's path; this is an index.
type InboundShare = {
  shareId: string;                    // = `${ownerOrgId}__${incidentId}`
  ownerOrgId: string;
  ownerOrgName: string;               // snapshot
  resourceType: "incident" | "workflow" | "report";
  resourceId: string;
  resourcePath: string;               // full path for one-hop fetch

  // Display snapshot — refreshed by a Cloud Function trigger on
  // owner-side incident writes. Used for list rendering without
  // having to read across orgs in the list query.
  snapshot: {
    title: string;
    state: string;
    updatedAt: Timestamp;
  };

  scope: ScopeDescriptor;             // effective (post-composition)
  sharedAt: Timestamp;
  expiresAt?: Timestamp;

  status: "active" | "revoked" | "expired";
};
```

### Why the denormalized inbound index

Without it, "what work has been shared with us" requires a collection-group
query across every org's incidents — security rules and cost both fail at
scale. The inbound index is recipient-owned, recipient-readable, and refreshed
by an owner-side trigger. It is **not authoritative**: revocation must
update both the owner's `shares[partnerOrgId]` AND the recipient's
`inboundShares/{shareId}`, in that order, in a Cloud Function.

---

## 7. Visibility Rules by Relationship Type

These are **defaults** — every field is overrideable per-relationship and
per-share. They exist so the UI can pick a sensible preset.

| Relationship | Read defaults                          | Write defaults                          | Member visibility                        |
|--------------|-----------------------------------------|------------------------------------------|-------------------------------------------|
| **vendor**       | summary, detail, evidence              | addEvidence, addNotes, advanceState      | seePartnerRoster=false, exposeOwnRoster=true |
| **customer**     | summary, detail, timeline              | (none)                                   | seePartnerRoster=true, exposeOwnRoster=true  |
| **peer**         | summary, detail, evidence, timeline    | addEvidence, addNotes, advanceState, assignMembers | both true                              |

Notes:
- `pii=false` for all three defaults. Always opt-in.
- `closeIncident=false` for vendor/peer defaults. Closing is a sovereign
  action on the owner side. Override is possible (e.g., contractor closes
  their own delivered work) but never default.
- Customer relationships default to read-only. The customer is the
  beneficiary of work, not the doer.

---

## 8. Transition Flow — Invited Vendor → Active Partner

```
[ no relationship between Org A (operator) and Org B (vendor) ]
                     │
                     │ Org A admin clicks "Invite vendor" in Settings.
                     │ A's app:
                     │   - creates relationshipInvites/{inviteId}
                     │     { fromOrgId: A, toEmail, proposedType: "vendor",
                     │       proposedDefaultScope: presets.Field, expiresAt: +7d }
                     │   - creates orgs/A/relationships/{rid} with
                     │     status="invited", partnerOrgId=tbd
                     │   - sends email with /invite?token={inviteId}
                     ▼
[ invite sent — A side has a placeholder relationship in status=invited ]
                     │
                     │ Recipient receives email, clicks link.
                     │ Two paths:
                     │
                     │  Path A: recipient already has a PeakOps account + org
                     │    - signs in
                     │    - sees "Invitation from {fromOrgName}"
                     │    - reviews proposed scope, accepts
                     │
                     │  Path B: recipient is new
                     │    - signs up (creates user)
                     │    - runs onboarding (creates orgs/{B} with orgType=vendor)
                     │    - returns to invite acceptance
                     ▼
[ recipient has signed in AND has an org ]
                     │
                     │ Acceptance:
                     │   - creates orgs/B/relationships/{rid} with
                     │     status="active", type="customer" (mirror perspective),
                     │     defaultScope = inverse-or-mirror of A's
                     │   - updates orgs/A/relationships/{rid}.status="active"
                     │     and partnerOrgId=B (was placeholder)
                     │   - writes audit entries on both sides
                     │   - marks relationshipInvites/{inviteId}.status="accepted"
                     │   - mirrors users/{recipientUid}/memberships/{B}
                     ▼
[ ACTIVE — A can now share incidents with B under defaultScope ]
                     │
                     │ Operations from here:
                     │   - A shares incidents → IncidentShareSettings updates,
                     │     inbound index doc created on B
                     │   - B sees shared work in "Inbound" view of Jobs
                     │   - B's field crew advances state, captures evidence
                     │   - A receives state changes via security-rules-permitted
                     │     writes; updates flow back through A's normal lifecycle
                     │
                     │ Evolution paths:
                     │   - A grants more scope (e.g. timeline read) → defaultScope
                     │     update on A side, audit entry, B's UI surfaces new fields
                     │   - B becomes ALSO a customer → second mirror pair created,
                     │     B's orgType promoted vendor → hybrid
                     │   - either side pauses → status=paused; new shares blocked,
                     │     existing shares stay active until manually revoked
                     │   - either side terminates → status=terminated;
                     │     all shares set to status=revoked; record retained
                     │     for audit; pair can be re-invited later (new rid)
```

### Edge cases that v1 must handle

- **Invite to an email that maps to an existing user but no org.** Run
  onboarding inline.
- **Invite to an email that maps to an existing user with multiple orgs.**
  Acceptance UI asks which org accepts the invite.
- **Two-way race: A and B independently invite each other.** Detect by
  `(fromOrgId, toOrgId, proposedType)` tuple; second invite auto-resolves
  to acceptance of the first.
- **Invite expires.** Token deleted; A's placeholder relationship is also
  deleted (or marked terminated with reason="invite_expired").

---

## 9. Billing Ownership Model

```typescript
// orgs/{orgId}/billing/config
type BillingConfig = {
  payerOrgId: string;           // who pays — defaults to self (orgId)
  plan: "free" | "team" | "enterprise";
  seatCount: number;            // == count of members.where(status=active)

  // Vendor-specific fields
  freeCollaborator: boolean;    // true while the org is purely inbound
  // (no originated incidents, no outbound relationships, member count <= N)
};
```

### Rules

1. **Each org pays for itself.** No relationship transfers billing. A's
   invitation to B does not put B on A's bill.
2. **Pure vendors are free collaborators.** An org that has only inbound
   relationships, has originated zero incidents, and has at most 5 members
   (configurable) qualifies for `freeCollaborator: true`. They pay nothing.
3. **The moment a vendor originates work or invites their own crew above
   the threshold, billing kicks in.** They get a 30-day grace window, then
   move to `plan: "team"`.
4. **Hybrid orgs always pay.** Originating any work disqualifies free tier.
5. **Customer relationships do not affect billing.** A municipality that
   receives shared incidents from a contractor is not billed for that.
   They're billed for THEIR own seats and originated work.
6. **Seats follow the org, not the role.** Field crew seats and admin seats
   are billed identically; pricing tiers can introduce role-based pricing
   in v2.

### Why this rule set

The vendor-free-collaborator rule is the unlock for the marketplace effect:
operators can pull their entire vendor network onto PeakOps without selling
each vendor a license. Vendors who work enough incidents through PeakOps
upgrade naturally when they hit value (originating their own work or
expanding their team).

---

## 10. Recommended Auth / Org Isolation Rules

The security posture is **default deny**, with two read paths into any
resource: (a) you're a member of the owning org, or (b) you're a member of
an org the resource is shared with under a scope that permits the action.

### Helpers (Firestore rules)

```
function isMember(orgId) {
  return request.auth != null
    && exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
}

function memberRole(orgId) {
  return get(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role;
}

function isAdminOrOwner(orgId) {
  return isMember(orgId) && memberRole(orgId) in ["owner", "admin"];
}

function userOrgs() {
  // List of orgs this user is a member of (read from users/{uid}/memberships/*)
  return /* query expansion */;
}

function isSharedWithMyOrgs(ownerOrgId, incidentId) {
  let inc = get(/databases/$(database)/documents/orgs/$(ownerOrgId)/incidents/$(incidentId)).data;
  return inc.shareSettings != null
    && inc.shareSettings.sharedWithOrgIds.hasAny(userOrgs());
}
```

### Rule sketches

```
match /users/{userId} {
  allow read, write: if request.auth.uid == userId;
}

match /orgs/{orgId} {
  allow read:  if isMember(orgId);
  allow write: if isAdminOrOwner(orgId);
}

match /orgs/{orgId}/members/{memberUserId} {
  allow read:  if isMember(orgId);
  allow create, update, delete: if isAdminOrOwner(orgId);
  // ADDITIONAL: a user can read their own membership record
  allow read:  if request.auth.uid == memberUserId;
}

match /orgs/{orgId}/incidents/{incidentId} {
  allow read:  if isMember(orgId)
                || isSharedWithMyOrgs(orgId, incidentId);
  allow write: if isMember(orgId)  // owners can always write
                || (
                  isSharedWithMyOrgs(orgId, incidentId)
                  && shareScopeAllows(request.auth.uid, orgId, incidentId, request.method)
                );
}

match /orgs/{orgId}/relationships/{relationshipId} {
  allow read:  if isMember(orgId);
  allow write: if isAdminOrOwner(orgId);
}

match /relationshipInvites/{inviteId} {
  // The recipient (matching by toEmail or toOrgId) and the sender's admins
  // can read; only the sender's admins can write; recipient writes
  // acceptance through a Cloud Function, not direct rule.
}
```

### Cross-org write enforcement

Cross-org **writes** are the riskiest operation. The recommendation is to
funnel them through Cloud Functions, not direct rules:

- Direct rules permit cross-org **reads** when share scope allows.
- Cross-org **writes** (e.g., a vendor adding evidence to the operator's
  incident) go through a callable function that re-validates the scope
  server-side and writes with admin SDK. This keeps the most sensitive
  permission logic in one place and out of rules.

---

## 11. Recommended V1 Guardrails

Hard rules baked into the v1 design that prevent foot-guns later:

1. **No cross-org member operations.** Org A cannot invite a user directly
   into Org B. The only cross-org primitive is a Relationship.
2. **One active relationship per (pair, type, direction).** The pair (A, B)
   may hold at most one active relationship of each (type, direction).
3. **Scope can only narrow, never widen.** Per-share overrides are a subset
   of relationship default scope. Validation rejects widening.
4. **No "platform-level" admin role.** Platform staff who need to act on
   org data must be added as explicit members of that org (via support
   tooling, with audit logging). No god-mode.
5. **Soft-delete relationships.** Termination sets status, never deletes
   the doc. Hard-delete is a support-tooling-only action.
6. **Snapshot fields are display-only.** `partnerOrgName` on a relationship
   doc is a snapshot. The source of truth is `orgs/{partnerOrgId}.name`.
   A nightly job (or trigger) refreshes snapshots; UI must not treat them
   as canonical.
7. **Owner role is irreducible and singular.** Each org has exactly one
   owner. Ownership transfer is a deliberate two-step proposal/accept flow,
   out of v1 scope (admin can promote-to-owner is the v1 escape hatch,
   gated on the current owner's confirmation).
8. **Invite tokens expire (7 days).** Stale invitations rot to
   `status=expired` via scheduled function.
9. **Audit log on every relationship transition.** Each status change writes
   `orgs/{orgId}/relationships/{rid}/audit/{eventId}`. Required for
   compliance posture; cheap to build now, expensive to add later.
10. **Cloud Function trigger maintains denormalized indexes.** Owner-side
    incident writes update the recipient's `inboundShares/{shareId}.snapshot`.
    Don't try to do this client-side.
11. **All cross-org actions log who did what, in which org, on which
    resource.** This is the scaffolding for SOC2 / compliance later.
12. **Industries from `lib/onboarding/industryProfiles` are the canonical
    set.** No ad-hoc strings. Adding an industry is a code change, not a
    data change.

---

## 12. What NOT to Overbuild Yet

Things that look reasonable but are explicitly out of scope for v1:

1. **No per-attribute redaction.** Scopes are at the resource level
   (incident summary vs detail vs evidence). No "redact field X for partner
   Y" — the explosion of edge cases is not worth the v1 cost. PII is the
   one boolean today.
2. **No multi-org auth domains.** A user has one Firebase uid and lives in
   N orgs. Don't build SAML-per-org or org-bound IdPs. v2 problem.
3. **No org-of-orgs / parent-child hierarchy.** No conglomerate model. If a
   parent company owns three subsidiaries, they create three orgs and
   three peer relationships. The hierarchy lives in the relationship graph,
   not in the org doc.
4. **No relationship marketplace.** No "find me a vendor" search, no public
   directory beyond `publicProfile`. Invitations are explicit, by email or
   by direct org link.
5. **No billing per-relationship.** Don't build "Org A subsidizes B's seats."
   Each org pays for itself.
6. **No real-time presence across orgs.** Cross-org work updates are
   eventually consistent. No live cursor / live editor / live status dot
   for partner-org members.
7. **No fine-grained workflow sharing.** Share whole incidents, not steps
   of a workflow. Sub-incident sharing is a v2 problem with its own
   permission surface.
8. **No org-to-org messaging primitive.** Notes-on-shared-incidents is the
   communication channel. No DMs, no channels, no threads.
9. **No SLA enforcement engine.** Track relationship metadata (response
   time, closure rate); SLA computation and alerting are v2.
10. **No data residency controls.** All Firestore. Sovereignty is logical
    (security rules), not geographic. Regional data residency is a v2 sales
    requirement that drives a separate architecture pass.
11. **No automated relationship-trust scoring.** Don't build "B closed 92%
    of incidents on time" badges yet. Capture the data; surface scoring
    later when there's real signal.
12. **No revenue share / payout flows.** A municipality paying a contractor
    through PeakOps is a payments product, not a relationship feature.
    Years away.

---

## 13. Recommended Implementation Order

The order minimizes rework: each step extends the previous step's data
model without forcing a migration.

| # | Step                                                       | Why first / why later                                  |
|---|------------------------------------------------------------|---------------------------------------------------------|
| 1 | **Org + Membership schema verified against this doc**      | v1 already has these; verify shape, fill gaps (orgType, ownerUserId, denormalized counts). |
| 2 | **`users/{uid}/memberships` denormalization + org-switcher** | Required for any user to live in more than one org.   |
| 3 | **Relationship doc + invite token flow (no shares yet)**   | Establishes the relationship primitive in isolation. UI: Settings → Partners list, invite form, accept flow. |
| 4 | **Audit log subcollection on relationships**               | Cheap to add now, expensive to backfill later.        |
| 5 | **`shareSettings` on existing incidents + `inboundShares` index** | Enables the actual collaboration value prop.    |
| 6 | **Cloud Function trigger to maintain `inboundShares.snapshot`** | Required for recipient-side list rendering at scale. |
| 7 | **Scope presets in UI (Observer / Field / Joint Ops)**     | Hide the ScopeDescriptor field-by-field UX from users; ship presets first. |
| 8 | **Recipient-side "Inbound" view of Jobs page**             | The first surface where partners see shared work.    |
| 9 | **Per-share scope overrides UI (advanced)**                | Most users won't touch this; ship the data model first, UI second. |
| 10 | **Vendor → hybrid evolution flow**                         | Unlocks "vendor becomes customer" path; needs settings + onboarding flip. |
| 11 | **Billing integration (free collaborator vs operator)**    | Once vendors exist in volume, billing classification matters. |
| 12 | **Security-rules hardening pass with cross-org test matrix** | Last because it requires all surfaces to be stable. |

Steps 1–3 are the foundation and unblock most product surfaces. Steps 5–8
are the visible value prop. Everything else is hardening / expansion.

---

## 14. Lifecycle Diagrams

### Relationship lifecycle

```
              ┌────────────┐
              │  invited   │ ◄── A creates invite + placeholder relationship
              └─────┬──────┘
                    │ B accepts
                    ▼
              ┌────────────┐
              │   active   │ ◄── normal operating state
              └─────┬──────┘
                    │
        ┌───────────┼───────────┐
        │ either    │ either    │ either
        │ pauses    │ resumes   │ terminates
        ▼           ▲           ▼
   ┌─────────┐      │      ┌─────────────┐
   │ paused  │──────┘      │ terminated  │
   └─────────┘             └─────────────┘
        │                         ▲
        │ either terminates       │
        └─────────────────────────┘
```

Invite token lifecycle (parallel, until accepted):

```
[ open ]──accepted──►[ accepted ]   (relationship goes to active)
   │
   ├──declined──►[ declined ]       (placeholder relationship deleted)
   │
   ├──revoked──►[ revoked ]         (inviter cancelled)
   │
   └──TTL expires──►[ expired ]     (placeholder relationship terminated
                                     with reason="invite_expired")
```

### Incident share lifecycle

```
[ owner creates incident ]
            │
            │ owner shares with partner via active relationship
            ▼
[ shareSettings.shares[partnerOrgId] = { scope, sharedAt, sharedVia } ]
[ inboundShares/{shareId} on partner side, status=active ]
            │
            │ partner reads / writes per scope
            ▼
[ work proceeds — both sides see updates per scope ]
            │
            │
   ┌────────┼────────┐
   │ owner  │ partner│ either
   │ revokes│ leaves │ pauses parent relationship
   ▼        ▼        ▼
[ status=revoked ] [ inbound link removed ] [ writes blocked, reads continue
                                              until owner revokes ]
            │
            ▼
[ historical record retained on owner side; partner inbound entry
  marked status=revoked but not deleted (audit) ]
```

### Vendor → hybrid evolution

```
[ Vendor org B, only inbound relationships ]
            │
            │ B's owner: "Settings → Org type → I want to originate work"
            ▼
[ orgType: vendor → hybrid ]
[ billing: freeCollaborator → false (with grace window) ]
            │
            │ B creates first incident → enters Operator UX
            │ B can now invite ITS OWN vendors (relationship, type=vendor,
            │ from B's POV)
            ▼
[ B is now a hybrid org operating in both directions ]
```

---

## 15. Future Scalability Notes

Decisions deferred but with the data model designed to absorb them:

1. **Top-level `incidentShares` index when per-org `inboundShares`
   subcollection exceeds Firestore's efficient query range (~10k docs).**
   Switch to a top-level collection partitioned by `recipientOrgId` with
   composite indexes on `(recipientOrgId, status, sharedAt)`. The schema
   doesn't change, just the location.
2. **Per-attribute redaction layer.** When regulated jurisdictions
   (telecom NORS, healthcare mutual aid) require attribute-level masking,
   add a `redactionPolicy` to ScopeDescriptor. Deferred until a real
   compliance ask materializes.
3. **Tiered scope presets with named identities.** Bronze/Silver/Gold or
   industry-specific templates ("NORS-aware", "FEMA-grant-ready",
   "mutual-aid-default"). Layer on top of the boolean ScopeDescriptor.
4. **Org graph analytics.** BigQuery export of the relationship graph and
   share volume. Powers questions like "which contractors are most-shared
   across utilities", "what's the average time from invite to first share".
5. **Bulk share operations.** Storm response: share 50 incidents to 10
   vendors in a single batched-write call. Needs a server-side function;
   the data model already supports it.
6. **Relationship trust score.** Computed metadata: closure rate, evidence
   quality, response time, dispute rate. Surfaces in the partner picker UI
   as a recommendation signal.
7. **Org graph hierarchy view.** A read-only visualization of the
   relationship graph for executive/audit consumption. Not a hierarchy in
   the data model — just a view layered on the existing relationship graph.
8. **Cross-org reporting.** A municipality's compliance report that pulls
   incidents from N contractors. Requires a federated read API on top of
   the share index.
9. **Ownership transfer flow.** Two-step propose/accept with a cool-down
   window and notification to all admins. v2.
10. **Offline-first vendor mobile experience.** Field crews from vendor
    orgs working in low-connectivity areas. Eventually-consistent writes
    against shared incidents need conflict resolution rules.

---

## Appendix A — Relation to existing v1 modules

This model layers cleanly on the current v1:

- `orgs/{orgId}` already exists (used by onboarding, incidents, settings).
  Need to add: `orgType`, `ownerUserId`, `publicProfile`, denormalized
  counts.
- `orgs/{orgId}/incidents/{incidentId}` already exists. Need to add:
  `shareSettings.{ sharedWithOrgIds, shares }`.
- `orgs/{orgId}/onboarding/state` already exists (this conversation).
  Onboarding can capture initial `orgType` and seed `publicProfile`.
- `orgs/{orgId}/inviteDrafts/{...}` already exists from onboarding.
  Distinct from `orgs/{orgId}/members/{...}` and from `relationshipInvites`
  — drafts are intra-org member invites, this doc adds a separate
  cross-org relationship invite primitive.

No existing collection needs renaming. No data migration is required for
the foundational v1 step.

---

## Appendix B — Glossary

- **Org** — a sovereign tenant. Owns members, data, billing.
- **Membership** — a user's role within one org. A user with N orgs has
  N memberships.
- **Relationship** — an explicit, two-sided collaboration link between two
  orgs. Mirrored: one doc per side, same `relationshipId`.
- **Share** — a specific resource (today: an incident) made visible to a
  partner org through an active relationship. Carries its own ScopeDescriptor.
- **ScopeDescriptor** — the (read, write, members, expiresAt) bundle that
  governs what a partner can do with a share. Composes with relationship
  default by intersection (narrowing only).
- **Inbound share** — a partner-side index entry pointing to a share whose
  authoritative copy lives on the owner side.
- **Operator** — an org type that originates work (utility, municipality,
  telecom, contractor that originates jobs).
- **Vendor** — an org type that does not originate work, only collaborates
  on shares from operators.
- **Hybrid** — both. The promotion path from vendor.
- **Free collaborator** — billing classification: a vendor org with no
  outbound relationships, no originated incidents, and ≤ N members. Pays
  nothing.
