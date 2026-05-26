# Industry mode architecture

PeakOps supports per-org **industry framing**. The default mode
is the generic proof/acceptance vocabulary (PR 71/82/84/85). The
first specialized mode is **telecom** (fiber / broadband closeout
workflows, PR 86).

## Files

| File | Purpose |
|---|---|
| `orgIndustry.ts` | Static allowlist of orgIds → industry. Migrates to per-org Firestore field in a later PR. |
| `telecomTemplates.ts` | Telecom-specific work-package templates with full metadata (label, purpose, requiredProof, acceptanceCriteria, etc.). |
| `industryTerms.ts` | Cross-industry vocabulary lookup. Helper is built; broad application is staged across follow-up PRs. |

## How an org gets telecom mode

1. Add the `orgId` string to `TELECOM_ORGS` in `orgIndustry.ts`.
2. (Optional) Run `scripts/seedTelecomDemo.cjs` to populate demo
   work packages for that org.

That's it. The next time anyone with that org's claim hits
`/incidents/new`, they see the 4 telecom templates instead of
the 5 generic archetypes.

## Template → backend archetype mapping

Two telecom templates map cleanly to existing `ARCHETYPE_ENUM`
values (PR 81a). Two collapse to `custom` as a bridge until a
small follow-up backend PR extends the enum:

| Telecom template | Backend archetype |
|---|---|
| Fiber Splice Package Closeout | `fiber_splice_verification` ✅ lossless |
| Restoration Completion Closeout | `storm_restoration_proof` ✅ lossless |
| Drop Installation Completion | `custom` ⚠️ bridge |
| Punch-List Resolution | `custom` ⚠️ bridge |

The bridge is **invisible to the operator** — the template's full
label + description + proof list lives in `telecomTemplates.ts`
and renders losslessly on the UI side.

## What this layer is NOT

- Not a template builder (templates are static literals)
- Not a workflow engine
- Not a rules engine (`acceptanceCriteria` is informational text)
- Not a dynamic forms engine
- Not a CRM, FSM, dispatch, scheduling, routing, or inventory
  system

The industry layer's job is **vocabulary + framing only**. The
backend incident model stays universal across industries.

## Roadmap (not commitments)

- **PR 87 (recommended)** — backend: add
  `drop_installation_completion` and `punch_list_resolution` to
  `ARCHETYPE_ENUM`, removing the two bridges above.
- **Later** — per-org Firestore `industry` field, deprecating
  the `TELECOM_ORGS` allowlist.
- **Later** — broader application of `industryTerms.term()` to
  Records cards, Dashboard hero, Review/Summary surfaces (one
  surface per PR).
- **Later** — additional industry modes (utility / construction
  inspection / etc.) when there's a customer to anchor them.
