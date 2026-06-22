# DIRS Rulepack v1.1 Checkpoint

**Branch:** `chunk3/dirs-rulepack-v2`
**Prepared:** 2026-06-22
**Sprint type:** Regulatory content (not engineering)
**Scope:** Replace the 1-rule DIRS skeleton with substantively real telecom outage reporting rules. No validator-engine changes. No enforcement-mode changes. No PR 133C work.

---

## A. What changed

| | Before | After |
|---|---|---|
| File | `functions_clean/_complianceRulepacks/dirs/v1.json` (+ canonical mirror at `contracts/rulepacks/dirs/v1.json`) | Same file paths; substantive content rewrite |
| Internal `version` field | `"v1"` | `"v1.1"` — snapshots taken under the prior content remain frozen at `"v1"` |
| Rules | 1 (`dirs.affectedCustomers.required`) | **6** rules, each citing 47 CFR § X.X |
| Evidence requirements | 1 (`dirs.evidence.outageProof`) | **3** evidence requirements |
| Metadata | none | `displayName`, `regulatorySource`, `engineLimitations` (engine ignores; available for SME audit) |

## B. What this rulepack does NOT do

This is **content** work, not engine work. The following are explicitly OUT OF SCOPE for v1.1 and tracked as engine-enhancement work (deferred to PR 133C+):

- **Threshold-based reportability** (e.g. 900,000 user-minutes of E911 service per § 4.9). The engine supports presence checks only; no numeric thresholds.
- **Format checks** (e.g. startTime must be ISO-8601). Engine supports presence only.
- **Cross-field math** (e.g. `resolvedTime - startTime ≥ 30 min` for NORS reportability). Not expressible.
- **Conditional rules** (e.g. "if location.state is in DIRS-activated region, also require X"). Engine supports a static `when.statusIn` gate but no other conditional logic.
- **Evidence-of-required-type per status** (e.g. CLOSED records require restoration LOG, not just any LOG). Evidence checks are global, not status-conditional.

The `engineLimitations` block in the JSON documents this for any SME or regulator reviewing the file.

---

## C. Rule-by-rule

| # | Code | Source | Severity | What it checks | Why this severity |
|---|---|---|---|---|---|
| 1 | `dirs.entity.identification.required` | 47 CFR § 4.11 — Notification content: Entity name | ERROR | `incident.customer` present (the reporting-provider label) | Hard regulatory requirement; first content element listed in § 4.11. |
| 2 | `dirs.geographic_area.required` | 47 CFR § 4.11 — Geographic area affected | ERROR | `incident.location.raw` present (the operator-typed location string, post-normalizer) | Hard regulatory requirement. Engine note: uses `.raw` path because the validator's normalizer always materializes `location` as `{}` minimum; the parent check would never trigger. |
| 3 | `dirs.affected_population.required` | 47 CFR § 4.9 + § 4.11 — Service effects / threshold preconditions | ERROR | `incident.affectedCustomers` present | Necessary precondition for the user-minutes threshold math (which the engine can't do today, but the field MUST be present for any downstream calc). |
| 4 | `dirs.problem_description.required` | 47 CFR § 4.11 — Brief description of the problem | WARN | `incident.notes` present | Explicit § 4.11 content but the operator can satisfy via other means (e.g. attached document). WARN rather than ERROR so the operator can override with judgment. |
| 5 | `dirs.service_category.recommended` | 47 CFR § 4.5 + § 4.9 (per-category thresholds) | WARN | `incident.archetype` present | The archetype is a PeakOps proxy for the FCC's provider-category enum (wireline/wireless/cable/etc.). Not a perfect 1:1; surfaces miscategorization risk. |
| 6 | `dirs.priority.recommended` | FCC public guidance on DIRS triage prioritization | INFO | `incident.priority` present | Soft signal for triage. Not in CFR but reflected in DIRS operational practice. |

All status-gated rules use `when.statusIn: ["ACTIVE", "MITIGATED", "CLOSED"]` so DRAFT incidents don't produce false-positives during initial intake.

## D. Evidence requirements

| # | Code | Source | Severity | Type checked |
|---|---|---|---|---|
| 1 | `dirs.evidence.outageProof` | § 4.11 pertinent information + DIRS substantiation guidance | WARN | `LOG` (operational log substantiating the outage) |
| 2 | `dirs.evidence.situationReport` | FCC DIRS public guidance on situation reporting | INFO | `DOCUMENT` (operator-authored narrative) |
| 3 | `dirs.evidence.restorationProof` | § 4.11 final report attestation | INFO | `LOG` (post-restoration test artifacts) |

**Engine limitation:** Evidence requirements are NOT status-gated. The restorationProof requirement triggers even on ACTIVE records — that's an engine limitation (`evidenceRequirements` shape doesn't support `when`). Documented in `engineLimitations` for future enhancement.

---

## E. Demo records + validator output

A pure-Node scenario matrix lives at `scripts/dev/test_dirs_rulepack_v1_1.mjs`. Four representative incident shapes drive through `runComplianceCheck`:

### Scenario A — fully-compliant ACTIVE incident (Northgate-shape)

Input: title + customer + location + notes + archetype + priority + startTime + affectedCustomers, status=`submitted_to_customer` (normalizes to ACTIVE), one LOG evidence item.

Expected output:
```
ok: true
errors: []
warns: []
infos: [dirs.evidence.situationReport]   ← no DOCUMENT evidence; informational only
```

**Actual output: matches.** v1.1 rulepack ID recorded on the result. The single INFO is a real-world advisory the operator can act on.

### Scenario B — missing geographic_area + affected_population

Input: title + customer + notes + archetype + priority + startTime, status=`in_progress`, location intentionally OMITTED, affectedCustomers intentionally OMITTED.

Expected output:
```
ok: false
errors: [dirs.geographic_area.required, dirs.affected_population.required]
warns: []
infos: [dirs.evidence.situationReport]
```

**Actual output: matches.** Both hard-requirement rules trigger correctly. The customer-entity rule does NOT fire (customer is set). Proves the rules are field-specific, not blanket.

### Scenario C — minimum required only, no evidence

Input: title + customer + location + startTime + affectedCustomers, status=`in_progress`. No notes, no archetype, no priority, no evidence at all.

Expected output:
```
ok: true               ← all ERRORS satisfied
warns: [dirs.problem_description.required,    ← notes missing
        dirs.service_category.recommended,    ← archetype missing
        dirs.evidence.outageProof]            ← LOG missing
infos: [dirs.priority.recommended,            ← priority missing
        dirs.evidence.situationReport,        ← DOCUMENT missing
        dirs.evidence.restorationProof]       ← LOG missing (counted twice, different code)
```

**Actual output: matches.** Derives to `issues_advisory` tier — the engine state for "no ERRORs but soft signal exists." Exactly the right behavior: a bare-bones incident is reportable but flagged for operator review.

### Scenario D — DRAFT status (rules should be quiescent)

Input: title + startTime, status=`draft`. Most fields omitted.

Expected output:
```
ok: true
errors: []
warns: [dirs.evidence.outageProof]            ← evidence requirements are global, not status-gated (engine limitation)
infos: [dirs.evidence.situationReport, dirs.evidence.restorationProof]
```

**Actual output: matches.** No DIRS *field* rules trigger on DRAFT (all are gated to ACTIVE/MITIGATED/CLOSED). Evidence requirements fire because the engine treats them globally. Documented as an engine limitation, not a content bug.

### Live alpha record — Northgate (the calibrated DIRS test record)

Driving the actual production record `orgs/peakops-internal-alpha/incidents/demo_20260616T122606Z_5ax3` through the new rulepack produces:

```
ok: true
rulepackVersion: v1.1
issues:
  - dirs.service_category.recommended (WARN) — archetype not on the record (calibration script didn't set it)
  - dirs.evidence.situationReport (INFO)     — no DOCUMENT-type evidence
```

**This is the right output.** The record is hard-requirement compliant; the validator now surfaces 2 actionable advisory items that an operator can address. Compared to the v1 skeleton (which only checked affectedCustomers and produced `ok: true` with zero signal), v1.1 produces real, citable, operator-actionable output.

---

## F. Deployment

**Risk level: ZERO.** Pure JSON content change. No function code changes. No schema changes. No incident-doc mutations. Existing snapshots stay frozen at their pre-3B-2 rulepack version.

### Deploy

Single-lane Cloud Functions deploy is needed because the rulepack JSON is bundled into the deploy artifact:

```bash
firebase deploy --only functions --project peakops-pilot
```

(Or scoped to just the functions that import the rulepacks: `firebase deploy --only functions:closeIncidentV1,functions:exportIncidentPacketV1,functions:submitFieldSessionV1` — but a full functions deploy is also safe and what we've been doing.)

Wait — actually the rulepack is only consumed by `_complianceValidator.js`, which is itself only invoked by `_readiness.js::refreshReadinessCache` when org `config/validation.mode` is set to `passive_log` or `passive_persist`. So the rulepack changes only take effect when readiness recompute fires on an incident in an org with passive validation enabled. On `peakops-internal-alpha`, that's already the case (mode=`passive_log` per Chunks 1+2 work).

Single-lane deploy: `firebase deploy --only functions --project peakops-pilot`. Any function that bundles `functions_clean/` gets the new JSON.

### Rollback

If the rulepack produces unexpected behavior in production:

```bash
git revert <PR merge SHA>
git push origin main
firebase deploy --only functions --project peakops-pilot
```

Effects of rollback: production goes back to the 1-rule v1 skeleton. Existing snapshots (already frozen at the moment they were taken) are unaffected. New incidents would record `rulepackVersion: v1` again.

### Manual verification (post-deploy)

- [ ] `node scripts/dev/test_dirs_rulepack_v1_1.mjs` → all 17 assertions pass
- [ ] Open a DIRS-tagged incident on alpha (e.g. Northgate or `demo_draft_001`). Check Cloud Logging for the `compliance_check` log line — confirm `rulepackVersion: "v1.1"` and the issue codes match the live-record output above.
- [ ] Re-run the Chunk 3B passive-validation observation window for ~24h with the new rulepack to confirm distribution of state values (clear / advisory / blocking) matches expectation. No code changes; just observe.

---

## G. Final recommendation

**Status: GREEN for content; READY for PR 133C scoping.**

The DIRS rulepack now contains substantively real, cited regulatory content. A telecom compliance officer reviewing the rendered audit packet — or the validator output — will see 6 cited regulatory rules + 3 evidence categories, not a 1-rule skeleton. The "are we actually validating anything?" question now has a defensible answer.

What this unlocks:
- **PR 133C (enforcement / blocking mode) becomes meaningful.** Promoting from `passive_log` to `block` now protects customers from real regulatory risk for cited reasons, instead of enforcing a single field check.
- **Butler demo credibility.** When asked "how does PeakOps enforce DIRS compliance?", the answer is "here are 6 rules from 47 CFR § 4, evidence requirements aligned to § 4.11, and an explicit list of what the engine can't yet enforce" — instead of "we have one field check."
- **SME engagement path.** A regulatory SME can review this rulepack and produce a punch list of "I'd add rule X, change rule Y to ERROR" — concrete, citation-grounded feedback. The skeleton wasn't reviewable; this is.

**What remains for the compliance story to be GREEN end-to-end:**
- NORS rulepack still empty (skeleton). Recommended next sprint: same treatment for NORS, sourced from the same § 4.9 + § 4.11 content.
- Engine-side threshold support (PR 133C scope): can't enforce "900k user-minutes for E911" rule until the engine supports numeric thresholds. Defer.
- BABA / SAR / OE-417 expansion: lower priority. BABA (Build America Buy America) is procurement-side; SAR (Suspicious Activity Report) is financial. Both are out of normal telecom-pilot scope. OE-417 (DOE electricity) has 1 rule already and isn't blocking telecom pilots.

Branch `chunk3/dirs-rulepack-v2`, ready to merge after review. No validator engine changes. No enforcement-mode changes. No PR 133C work.
