#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

FC="${REPO_ROOT}/functions_clean"
ENV_FILE="${FC}/.env"
TS="$(date +%Y%m%d_%H%M%S)"
BAD_ENV="${FC}/.env.firebase_tools_bad_${TS}"
ENV_LOCAL="${FC}/.env.local"
BOOT="${FC}/_emu_bootstrap.js"
IDX="${FC}/index.js"

say() { echo "[fix-fn-env] $*"; }
fail() { echo "[fix-fn-env] FAIL: $*" >&2; exit 1; }

show_file_state() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    file -I "${file}" || true
    sed -n '1,40l' "${file}" || true
    if command -v xxd >/dev/null 2>&1; then
      xxd -g 1 -l 128 "${file}" || true
    fi
  else
    say "missing ${file}"
  fi
}

say "before .env state"
show_file_state "${ENV_FILE}"

if [[ -f "${ENV_FILE}" ]]; then
  cp "${ENV_FILE}" "${BAD_ENV}"
  say "backup written: ${BAD_ENV}"
fi

cat > "${ENV_FILE}" <<'ENV'
DUMMY=1
ENV

cat > "${ENV_LOCAL}" <<'ENV'
FIREBASE_STORAGE_BUCKET=peakops-pilot.appspot.com
STORAGE_BUCKET=peakops-pilot.appspot.com
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
GCLOUD_PROJECT=peakops-pilot
ENV

cat > "${BOOT}" <<'JS'
"use strict";
const fs = require("fs");
const path = require("path");

function isEmulator() {
  return (
    String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB
  );
}

function parseEnv(body) {
  for (const raw of String(body || "").split(/\n/)) {
    const line = String(raw || "").replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1);
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

(function bootstrap() {
  try {
    const envLocalPath = path.join(__dirname, ".env.local");
    if (fs.existsSync(envLocalPath)) {
      parseEnv(fs.readFileSync(envLocalPath, "utf8"));
      console.log("🔥 _emu_bootstrap loaded .env.local:", envLocalPath);
    }
  } catch (e) {
    console.warn("⚠️ _emu_bootstrap parse warning (continuing):", String(e && (e.message || e) || e));
  }
  if (isEmulator() && !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
  }
  if (isEmulator() && !process.env.FIREBASE_STORAGE_BUCKET && process.env.GCLOUD_PROJECT) {
    process.env.FIREBASE_STORAGE_BUCKET = `${process.env.GCLOUD_PROJECT}.appspot.com`;
  }
})();
JS

if [[ ! -f "${IDX}" ]]; then
  fail "missing ${IDX}"
fi
if ! grep -q "_emu_bootstrap" "${IDX}"; then
  tmp="$(mktemp)"
  {
    echo "require('./_emu_bootstrap');"
    cat "${IDX}"
  } > "${tmp}"
  mv "${tmp}" "${IDX}"
  say "prepended bootstrap require into index.js"
fi

say "after .env state"
show_file_state "${ENV_FILE}"
say "after .env.local state"
show_file_state "${ENV_LOCAL}"
say "done"
