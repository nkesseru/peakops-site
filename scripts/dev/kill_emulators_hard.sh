#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [[ -z "${REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
fi
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_FILE="${CONFIG_FILE:-firebase.json}"
NEXT_PORT="${NEXT_PORT:-3001}"
if [[ "${CONFIG_FILE}" = /* ]]; then
  CONFIG_PATH="${CONFIG_FILE}"
else
  CONFIG_PATH="${REPO_ROOT}/${CONFIG_FILE}"
fi

PORTS=(4415 4005 4505 5004 8086 8087 9154 9199 5003 5002 5001 3001)

say(){ echo "[kill-hard] $*"; }
fail(){ echo "[kill-hard] FAIL: $*" >&2; exit 1; }

[[ -f "${CONFIG_PATH}" ]] || fail "config file not found: ${CONFIG_PATH}"
say "repoRoot=${REPO_ROOT} configPath=${CONFIG_PATH} projectId=${PROJECT_ID} nextPort=${NEXT_PORT}"

say "Killing listeners on ports: ${PORTS[*]}"

for p in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    say "port $p -> PID(s): $pids"
    kill -9 $pids >/dev/null 2>&1 || true
  fi
done

say "Killing firebase-tools / emulator processes (best-effort)"
pkill -f "firebase-tools" >/dev/null 2>&1 || true
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true

# Extra: kill java that is still holding 8086/8087/9154 (common)
jps >/dev/null 2>&1 && {
  say "Java processes:"
  jps -l || true
}

say "Done."
