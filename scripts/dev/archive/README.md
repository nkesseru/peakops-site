# scripts/dev/archive/

Reference-only copies of legacy dev tooling. Not part of any active workflow.
Preserved so the original design intent + recipe stays discoverable in `git log`
without implying these scripts are current.

If a future task needs to revive any of these, copy back to `scripts/dev/`
and update against current schemas before running.

## seed_demo_recovery.mjs

- Original PR 133 dedicated demo-org seeder.
- Targeted `peakops-demo` org (hard safety rail refuses any other org).
- Superseded by `scripts/dev/stage_demo_dataset_v1.mjs`, which seeds the same
  rejection→recovery scenario on `peakops-internal-alpha` via Record B.
- Archived for reference only.

## stage_demo_recovery_alpha.mjs

- Original PR 133 alpha recovery staging workflow.
- Generated live resubmission-token scenarios (stopped before customer accept
  so the operator could click through `/review/{token}` in a browser).
- Superseded by `scripts/dev/stage_demo_dataset_v1.mjs`, which now seeds the
  full customer_rejected + recovery_case state idempotently.
- Archived for reference only.
