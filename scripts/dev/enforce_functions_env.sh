#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

FC_DIR="${REPO_ROOT}/functions_clean"
ENV_FILE="${FC_DIR}/.env"
ENV_LOCAL="${FC_DIR}/.env.local"
TS="$(date +%Y%m%d_%H%M%S)"
Q_DIR="${FC_DIR}/.env_quarantine_${TS}"

say(){ echo "[enforce-fn-env] $*"; }
fail(){ echo "[enforce-fn-env] FAIL: $*" >&2; exit 1; }

[[ -d "${FC_DIR}" ]] || fail "functions_clean directory not found: ${FC_DIR}"

if [[ -f "${ENV_LOCAL}" ]]; then
  mkdir -p "${Q_DIR}"
  mv "${ENV_LOCAL}" "${Q_DIR}/.env.local"
  say "quarantined .env.local -> ${Q_DIR}/.env.local"
fi

tmp_env="$(mktemp)"
cat > "${tmp_env}" <<'ENV'
GCLOUD_PROJECT=peakops-pilot
FIREBASE_PROJECT_ID=peakops-pilot
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
FIREBASE_STORAGE_BUCKET=peakops-pilot.appspot.com
STORAGE_BUCKET=peakops-pilot.appspot.com
ENV
mv "${tmp_env}" "${ENV_FILE}"

say "wrote parse-safe ${ENV_FILE}"
file -I "${ENV_FILE}" || true
if command -v xxd >/dev/null 2>&1; then
  xxd -g 1 -l 128 "${ENV_FILE}" || true
fi
sed -n '1,40l' "${ENV_FILE}" || true

say "done"

