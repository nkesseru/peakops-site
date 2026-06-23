# PR 133C — Enforcement / Blocking Mode

**Branch:** `pr133c/enforcement-blocking-mode`
**Date:** 2026-06-23
**Risk:** LOW (per-org opt-in, default OFF, fully reversible via single Firestore Console edit)

Replaces the `passive_log`/`passive_persist`-only validator with a new `block` mode that refuses customer-shipping callables when DIRS ERROR-severity findings or unsatisfied required acceptance proof exist. Admin/owner can override with an acknowledged reason. Override records are **internal-only** for this PR per policy decision (deferred to a later PR after pilot feedback).

## What's in / What's out

| | In PR 133C | Deferred |
|---|---|---|
| New mode value `"block"` recognized by `readValidationMode` | ✅ | — |
| Three gated callables refuse under `block` mode | ✅ | — |
| Admin/owner override path (`acknowledgeViolations` + reason) | ✅ | — |
| Override → audit subcollection, Cloud Logging, incident timeline | ✅ | — |
| Override → embedded in `packet-manifest.json.compliance.override` | ✅ | — |
| Override → customer-facing README / CUSTOMER_SUMMARY mentions | ❌ | Later PR after pilot feedback |
| `createOrgV1` auto-enables `block` for new orgs | ❌ — opt-in only | — |
| Operator UI for readiness chip + "send anyway" affordance | ❌ | PR 133D (UI) |
| WARN/INFO-severity escalation to blocking | ❌ — ERROR only | — |
| Engine threshold/cross-field math | ❌ — engine untouched | Engine sprint |
| NORS/OE-417/BABA rulepacks | ❌ — DIRS only | Future content sprints |

## Blocking conditions (the only two)

- **DIRS ERROR-severity findings** (from `runComplianceCheck`). Today those are the three v1.1 ERROR rules: `dirs.entity.identification.required`, `dirs.geographic_area.required`, `dirs.affected_population.required`.
- **`acceptanceReadiness.state === "requirements_missing"`** — the operator's own template required-proof items unsatisfied. Surfaces as the synthetic code `acceptance.requirements_missing`.

WARN/INFO findings, unknown checks, encouraged-tier gaps: **warn-only**, no behavior change vs. passive modes.

## Gated callables (3)

| Callable | Gate insertion site |
|---|---|
| `exportIncidentPacketV1` | After `computeAcceptanceReadiness`, before packet construction begins |
| `createCustomerReviewLinkV1` | After the jobs-not-approved check, before the packet-version-pin check |
| `mintResubmissionLinkV1` | After `incData` is loaded + status validated, before packet-version checks |

NOT gated: `createIncidentV1`, `addEvidenceV1`, `markJobCompleteV1`, `updateJobStatusV1`, `approveJobV1`, `closeIncidentV1`. Internal lifecycle stays untouched — only customer-shipping callables are gated.

## Override semantics

- Roles allowed: `owner`, `admin` only.
- Request body must include:
  - `acknowledgeViolations: true`
  - `violationAcknowledgmentReason: "<20-500 chars>"`
- Single-use per call. Does NOT persist on the incident. Each subsequent shipment requires its own override.
- Override fields are validated by `parseOverride` in `functions_clean/_enforcement.js`.

## Audit surface (4 channels, INTERNAL)

For every gate fire (with or without override):

1. **Audit subcollection** — `orgs/{orgId}/audit/{auditId}` with `type` of either:
   - `compliance_block_triggered` (no override / override rejected)
   - `compliance_block_overridden` (admin/owner override accepted)
2. **Cloud Logging** — structured log entry tagged by callable name.
3. **Incident timeline** — `incidents/{incidentId}/timeline_events` with same types.
4. **Packet manifest** (export only) — `packet-manifest.json.compliance.{mode, codes, rulepackVersionsByType, override?}`. Always present; `override` only set when override was used.

## API responses

**On block (no override):** HTTP 412 + body:
```json
{
  "ok": false,
  "error": "compliance_block",
  "mode": "block",
  "codes": [{"code": "dirs.entity.identification.required", "severity": "ERROR", "source": "dirs"}, ...],
  "overridable": true,
  "rulepackVersionsByType": {"DIRS": "v1.1"},
  "overrideHint": "Admin/owner may bypass with acknowledgeViolations=true and violationAcknowledgmentReason (20-500 chars).",
  "ackError": "override_required"
}
```

**On role-rejected override:** HTTP 403 + `ackError: "override_role_required"`.
**On bad reason:** HTTP 400 + `ackError: "override_reason_invalid"`.
**On allow / valid override:** original 200 response shape — caller cannot distinguish from a non-block deploy.

## Files touched

- `functions_clean/_enforcement.js` — NEW (~165 lines): evaluateEnforcement, parseOverride, recordBlockTriggered, recordBlockOverridden, _evidenceTypesFromList helpers
- `functions_clean/_readiness.js` — VALIDATION_MODE_BLOCK constant + persist-on-block branch
- `functions_clean/exportIncidentPacketV1.js` — gate after acceptanceReadiness; override record into packet-manifest.json
- `functions_clean/createCustomerReviewLinkV1.js` — gate after jobs-approved
- `functions_clean/mintResubmissionLinkV1.js` — gate after incident loaded
- `scripts/dev/smoke/butler_full_dry_run.mjs` — Phase 7: 6-case enforcement test matrix + audit verification
- `docs/checkpoints/pr-133c-enforcement.md` — this file

## Phase 7 test matrix

The Butler dry-run now extends to a Phase 7 that flips a throwaway org's `config/validation.mode = "block"` and exercises six cases against an intentionally-blocking incident (no `customer`, no `affectedCustomers`):

| Case | Callable | Override | Actor | Expected |
|---|---|---|---|---|
| A | `exportIncidentPacketV1` | none | admin | 412 `compliance_block` with ≥1 code |
| B | `exportIncidentPacketV1` | yes (reason ok) | field | 403 — authz rejects before override path |
| C | `exportIncidentPacketV1` | yes, reason="short" | admin | 400 `override_reason_invalid` |
| D | `exportIncidentPacketV1` | yes, valid reason | admin | 200 success, packetVersion present |
| E | `createCustomerReviewLinkV1` | none | admin | 412 `compliance_block` |
| F | `createCustomerReviewLinkV1` | yes, valid reason | admin | 200 success, token issued |
| Audit | post-flow query | — | — | `orgs/{orgId}/audit` contains both `compliance_block_triggered` and `compliance_block_overridden` |

A 65-second pre-wait flushes the in-process 60s `__validationModeCache` between mode change and first gated call.

## Deploy + verify

1. `gh pr merge <PR#> --squash`
2. Scoped deploy:
   ```
   firebase deploy --only functions:exportIncidentPacketV1,functions:createCustomerReviewLinkV1,functions:mintResubmissionLinkV1 --project peakops-pilot
   ```
3. Baseline verify (mode still off / passive_log default — backwards compat):
   ```
   node scripts/dev/smoke/butler_full_dry_run.mjs
   ```
   All 7 phases must pass. Phase 7 flips the dry-run org's mode to `block` and tests enforcement. The dry-run org is torn down at the end so no permanent state change.
4. Inspect Cloud Logging for `compliance_block_triggered` + `compliance_block_overridden` events with correct codes.

## Rollback

- **Per-org rollback (no deploy):** edit `orgs/{orgId}/config/validation.mode` → `passive_log` via Firestore Console. Effective within 60s (existing TTL cache invalidates).
- **Code rollback:** `git revert <PR 133C SHA>` + redeploy. Passive modes continue normally; existing data unaffected (no schema migration).

## Why this is GREEN-grade

- Per-org opt-in via config doc. Default behavior is unchanged for every org that doesn't explicitly set `mode=block`.
- Override path always exists for admin/owner — operators are never trapped.
- All four audit channels populated for every gate fire (triggered or overridden) — full audit-defensibility.
- Phase 7 of the dry-run is the regression test: 6 cases + audit verification, runs end-to-end against live `peakops-pilot`.
- Customer-facing override visibility is explicitly deferred (per policy decision) — keeps the customer-side experience identical until the pilot decides.
