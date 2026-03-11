#!/usr/bin/env bash
set -euo pipefail

say() { echo "[demo-bootstrap] $*"; }

say "Running deterministic demo reset + seed + smoke"
scripts/dev/reset_demo_incident.sh
scripts/dev/seed_demo_incident.sh
scripts/dev/smoke.sh

say "DONE"
say "Incident URL: http://127.0.0.1:3001/incidents/inc_demo"
say "Review URL:   http://127.0.0.1:3001/incidents/inc_demo/review"
say "Summary URL:  http://127.0.0.1:3001/incidents/inc_demo/summary"
