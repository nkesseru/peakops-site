#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

ENV_FILE="${REPO_ROOT}/functions_clean/.env"
TS="$(date +%Y%m%d_%H%M%S)"

say() { echo "[fix-functions-env] $*"; }

show_env_state() {
  local path="$1"
  if [[ -f "${path}" ]]; then
    file -I "${path}" || true
    sed -n '1,40l' "${path}" || true
    if command -v xxd >/dev/null 2>&1; then
      xxd -g 1 -l 128 "${path}" || true
    fi
  else
    say "missing: ${path}"
  fi
}

say "before:"
show_env_state "${ENV_FILE}"

if [[ -f "${ENV_FILE}" ]]; then
  cp "${ENV_FILE}" "${ENV_FILE}.bad_${TS}"
  say "backup: ${ENV_FILE}.bad_${TS}"
fi

# strict dotenv: KEY=VALUE only, LF newlines, trailing newline
{
  printf 'FIREBASE_STORAGE_BUCKET=peakops-pilot.appspot.com\n'
  printf 'STORAGE_BUCKET=peakops-pilot.appspot.com\n'
} > "${ENV_FILE}"

say "after:"
show_env_state "${ENV_FILE}"

say "done"
