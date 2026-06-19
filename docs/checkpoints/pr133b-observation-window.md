# PR 133B — Passive Validation Observation Checkpoint

**Status:** awaiting 24h post-calibration confirmation
**Decision checkpoint:** **2026-06-20T16:30Z** (~24h after calibration commit)
**Org under observation:** `peakops-internal-alpha`
**Validator mode:** `passive_log` (no enforcement; logs only)
**Tracking task:** #231

---

## Calibration summary

A 9-day passive observation window (2026-06-09 → 2026-06-18) produced 72 validator events on alpha — 59 would-be blocks (81.9%), all against synthetic data (test fixtures + demo records tagged `filingTypesRequired: ["DIRS"]` without DIRS-required fields). Zero `clear` events across the entire window — the calibration triangle was missing its passing leg.

On 2026-06-19, four demo records were re-classified to exercise the validator's discrimination accuracy on representative data. Commit **`b7f945c`** — `demo(dataset): calibrate DIRS validation fixtures` — applied the changes via the existing `scripts/dev/stage_demo_dataset_v1.mjs` patch pass.

### Post-calibration state mix (verified 2026-06-19T16:30Z)

| Record | Customer | Title | filingTypes | State | Notes |
|---|---|---|---|---|---|
| `demo_20260616T122606Z_5ax3` | Northgate Mutual Telecom | Fiber splice — 24th Ave N corridor outage | `["DIRS"]` | **`clear`** ✓ | Populated `startTime` + `affectedCustomers: 142` + flipped one evidence item to `type: "LOG"`. First-ever `clear` observed in the window. |
| `demo_field_work_001` | Cascade Fiber Networks | Fiber splice verification — Segment 14 | `[]` | **`not_evaluated`** ✓ | DIRS stripped — internal maintenance, not an outage. |
| `demo_rejected_001` | Riverbend Power & Light | OTDR validation — East Ring | `[]` | **`not_evaluated`** ✓ | DIRS stripped — fiber-link test work, not an outage. |
| `demo_draft_001` | Pioneer Broadband Cooperative | Cabinet inspection — North Spokane | `["DIRS"]` | **`issues_blocking`** | **Control case** — untouched. Validator correctly continues to catch the real gap. |

### Distribution achieved

- **1 × `clear`** — the previously-missing leg of the calibration triangle
- **2 × `not_evaluated`** — DIRS-irrelevant records correctly skipped
- **1 × `issues_blocking`** — control case proving the catch path is still alive
- **0 × `passive_validation_failed`** errors across the full 9-day window + calibration spike
- **p95 elapsedMs:** 2 (calibration run) / 47 (9-day window) — performance budget intact

---

## Decision checkpoint: 2026-06-20T16:30Z

Scheduled cron `f3e49145` (one-shot) fires at this time. Manual fallback if the session ends before then:

```bash
gcloud logging read 'textPayload:"compliance_check"' \
  --project=peakops-pilot --freshness=26h --limit=500 \
  --format='value(timestamp,textPayload)' > /tmp/recheck.txt

node scripts/dev/trigger_validation_calibration.mjs

gcloud logging read 'textPayload:"passive_validation_failed"' \
  --project=peakops-pilot --freshness=26h | wc -l
```

### Close #231 if all 5 conditions hold

1. **Northgate** (`demo_20260616T122606Z_5ax3`) remains `state: "clear"`
2. **field_work** (`demo_field_work_001`) remains `state: "not_evaluated"`
3. **rejected** (`demo_rejected_001`) remains `state: "not_evaluated"`
4. **draft** (`demo_draft_001`) remains `state: "issues_blocking"` (control case still firing correctly)
5. **No validator drift** — zero `passive_validation_failed` log lines in the 26h window; error/warn counts on the calibrated records match the post-calibration baseline (Northgate 0/0, Cascade 1/0, Riverbend 1/0, Pioneer 1/1)

If all 5 hold → close #231 → open PR 133C scoping ticket for enforcement/blocking mode (new `VALIDATION_MODE_BLOCK` constant + write-path gate + UI error shape contract + operator prompt for missing fields).

If anything drifted → do NOT close #231. Investigate root cause before any enforcement work begins.

---

## Why not promote to blocking now

Two structural reasons documented in the prior observation review:

1. **The code has no blocking mode.** Validator constants in `functions_clean/_readiness.js` are `OFF`, `PASSIVE_LOG`, `PASSIVE_PERSIST` only. Header comment: *"PASSIVE VALIDATION — does NOT gate any operator workflow. Never returns an error that blocks the caller. PR 133B."* Promoting to blocking requires PR 133C (a code change), not a config flip.

2. **24h confirmation is cheap insurance.** Confirms the calibrated state persists across normal operator activity and that no edge case flips it back unexpectedly. The cost of one more day is trivial against the cost of shipping enforcement on a misclassified baseline.
