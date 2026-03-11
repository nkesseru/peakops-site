# PeakOps Demo Checklist (Golden Path)

Use these commands only:

1. `bash scripts/dev/demo_up.sh`
2. `MODE=seed-only bash scripts/dev/reset_demo.sh`
3. `bash scripts/dev/demo_smoke.sh`
4. `bash scripts/dev/demo_doctor.sh`

Notes:
- `demo_up.sh` is the single blessed boot entrypoint.
- `reset_demo.sh` in `MODE=seed-only` only reseeds + verifies; it does not restart emulators/Next.
- If you see `Could not load config file .../firebase.json`, rerun with one of the commands above. Scripts now auto-`cd` to repo root; if it still happens, treat as a script bug.
