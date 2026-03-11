#!/usr/bin/env bash
set -euo pipefail

cd /Users/kesserumini/peakops/my-app

echo "[demo-go] clean slate"
bash scripts/dev/kill_drift_hard.sh || true

echo "[demo-go] reset + seed"
bash scripts/dev/reset_demo.sh

echo "[demo-go] ✅ done"
