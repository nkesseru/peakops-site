#!/usr/bin/env bash
# Boot firebase emulators against a clearly-test project ID, run the
# PR 108 readiness-freshness smoke, and tear down. Prod is NOT touched
# (the emulator suite runs entirely on localhost; project ID differs
# from peakops-pilot for belt-and-braces safety).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PROJECT_ID="peakops-emu-smoke"
EMU_LOG="$ROOT/.logs/emu_pr108.log"
mkdir -p "$ROOT/.logs"
: > "$EMU_LOG"

# Boot only what we need. Storage emulator is required because
# addEvidenceV1 probes object existence when FUNCTIONS_EMULATOR=true.
echo "[launcher] starting emulators (project=$PROJECT_ID), log -> $EMU_LOG"
firebase emulators:start \
  --project "$PROJECT_ID" \
  --only functions,firestore,auth,storage \
  > "$EMU_LOG" 2>&1 &
EMU_PID=$!
trap 'echo "[launcher] tearing down emulators (pid=$EMU_PID)"; kill -TERM $EMU_PID 2>/dev/null || true; wait $EMU_PID 2>/dev/null || true' EXIT

# Wait up to 90s for "All emulators ready"
READY=0
for i in $(seq 1 90); do
  if grep -q "All emulators ready" "$EMU_LOG"; then READY=1; break; fi
  if ! kill -0 $EMU_PID 2>/dev/null; then
    echo "[launcher] emulator process died early. Tail:"
    tail -50 "$EMU_LOG"
    exit 1
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "[launcher] timed out waiting for emulators. Tail:"
  tail -80 "$EMU_LOG"
  exit 1
fi
echo "[launcher] emulators ready"

# Env for the node smoke script — point firebase-admin at the emulator
# suite. The ports come from firebase.json.
export PROJECT_ID
export REGION="us-central1"
export FN_HOST="127.0.0.1:5004"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8087"
export FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
export FIREBASE_STORAGE_EMULATOR_HOST="127.0.0.1:9199"
export GCLOUD_PROJECT="$PROJECT_ID"
export GOOGLE_CLOUD_PROJECT="$PROJECT_ID"

node "$ROOT/scripts/dev/smoke_readiness_pr108.mjs"
SMOKE_RC=$?

# Last 50 lines of emulator log for context (especially refresh warns).
echo "──────────────── emulator log tail ────────────────"
tail -50 "$EMU_LOG"
echo "──────────────── end log tail ────────────────"

exit $SMOKE_RC
