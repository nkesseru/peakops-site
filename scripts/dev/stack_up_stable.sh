#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

SEED_MODE="${SEED_MODE:-review}"

echo "[stack-up-stable] running demo_up with SEED_MODE=${SEED_MODE}"
SEED_MODE="${SEED_MODE}" bash scripts/dev/demo_up.sh

echo "[stack-up-stable] URLs"
echo "http://127.0.0.1:3001/incidents/inc_demo"
echo "http://127.0.0.1:3001/incidents/inc_demo/review"
echo "http://127.0.0.1:3001/incidents/inc_demo/summary"
echo "[stack-up-stable] logs"
echo "/tmp/peakops/demo_up_emulators.log"
echo "/tmp/peakops/demo_up_next.log"

