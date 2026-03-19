#!/usr/bin/env bash
set -euo pipefail
# DEPRECATED: use scripts/dev/demo_up.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "$REPO_ROOT"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_PATH="${CONFIG_PATH:-$REPO_ROOT/firebase.json}"
NEXT_PORT="${NEXT_PORT:-3001}"

LOG_DIR="/tmp/peakops"
EMU_LOG="$LOG_DIR/boot_pinned_emulators.log"
NEXT_LOG="$LOG_DIR/boot_pinned_next.log"

mkdir -p "$LOG_DIR"

say(){ echo "[boot-pinned] $*"; }
fail(){ echo "[boot-pinned] FAIL: $*" >&2; exit 1; }

wait_port() {
  local port="$1" timeout="${2:-60}"
  for _ in $(seq 1 "$timeout"); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$1" || true; }

assert_ports_free() {
  local ports=(4415 4005 4505 5004 8087 9154 9199)
  for p in "${ports[@]}"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[boot-pinned] port $p still in use:"
      lsof -nP -iTCP:"$p" -sTCP:LISTEN || true
      return 1
    fi
  done
  return 0
}

say "Step 0: hard cleanup"
bash scripts/dev/kill_drift_hard.sh || true

say "Step 1: sanity: ports should be free"
assert_ports_free || fail "ports not free after kill"

attempt=1
max_attempts=4

while [[ $attempt -le $max_attempts ]]; do
  say "Step 2: start emulators attempt=$attempt"
  rm -f "$EMU_LOG"
  nohup firebase emulators:start \
    --project "$PROJECT_ID" \
    --config "$CONFIG_PATH" \
    --only functions,firestore,storage,ui \
    >"$EMU_LOG" 2>&1 &

  # Wait for “some” functions port + the pinned ports
  wait_port 8087 60 || { tail -n 120 "$EMU_LOG" || true; bash scripts/dev/kill_drift_hard.sh || true; attempt=$((attempt+1)); continue; }
  wait_port 9199 60 || { tail -n 120 "$EMU_LOG" || true; bash scripts/dev/kill_drift_hard.sh || true; attempt=$((attempt+1)); continue; }
  wait_port 5004 60 || { tail -n 120 "$EMU_LOG" || true; bash scripts/dev/kill_drift_hard.sh || true; attempt=$((attempt+1)); continue; }

  # Probe /hello on pinned base
  # Why: "Serving at port 8xxx" is the worker runtime port; 5004 is the emulator proxy port.
  HELLO="http://127.0.0.1:5004/${PROJECT_ID}/us-central1/hello"
  say "Probe /hello -> $HELLO"
  ok="$(http_code "$HELLO")"
  if [[ "$ok" != "200" ]]; then
    say "/hello not ready (http $ok), waiting 5s..."
    sleep 5
    ok="$(http_code "$HELLO")"
  fi
  [[ "$ok" == "200" ]] || { tail -n 120 "$EMU_LOG" || true; bash scripts/dev/kill_drift_hard.sh || true; attempt=$((attempt+1)); continue; }

  say "Step 3: start Next (pnpm run next:restart)"
  rm -f "$NEXT_LOG"
  nohup pnpm run next:restart >"$NEXT_LOG" 2>&1 &
  wait_port "$NEXT_PORT" 60 || { tail -n 120 "$NEXT_LOG" || true; fail "next not listening on $NEXT_PORT"; }

  say "Step 4: seed/reset"
  bash scripts/dev/reset_demo.sh

  say "✅ PASS: demo is up"
  echo "Incident: http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo"
  echo "Review:   http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/review"
  echo "Summary:  http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo/summary"
  echo "Logs: $EMU_LOG | $NEXT_LOG"
  exit 0
done

fail "Could not reach functions proxy on 5004 (/hello) after ${max_attempts} attempts. See $EMU_LOG"
