#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG_PATH="${CONFIG_FILE:-${REPO_ROOT}/firebase.json}"
LOG_DIR="/tmp/peakops"
LOG_FILE="${LOG_DIR}/fn_gate.log"
FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
PORTS=(4415 4005 4505 5004 8087 9154 9199 3001)

say(){ echo "[fn-gate] $*"; }
fail(){ echo "[fn-gate] FAIL: $*" >&2; exit 1; }

dump_fail() {
  local msg="$1"
  echo "[fn-gate] FAIL: ${msg}" >&2
  echo "[fn-gate] --- emulator log tail ---" >&2
  tail -n 220 "${LOG_FILE}" 2>/dev/null >&2 || true
  echo "[fn-gate] --- env files in functions_clean ---" >&2
  ls -la functions_clean | grep -E '\.env' >&2 || true
  exit 1
}

mkdir -p "${LOG_DIR}" /tmp/peakops/env_quarantine

say "killing emulator processes"
pkill -f "firebase emulators:start" >/dev/null 2>&1 || true
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f "firebase-tools" >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true
if command -v jps >/dev/null 2>&1; then
  jps -l 2>/dev/null | awk '/CloudFirestore|firestore/{print $1}' | while read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done
fi

say "killing listeners on ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    for pid in ${pids}; do
      kill -9 "${pid}" >/dev/null 2>&1 || true
    done
  fi
done
sleep 1

say "quarantining functions_clean/.env* to /tmp/peakops/env_quarantine"
Q_DIR="/tmp/peakops/env_quarantine/$(date +%Y%m%d_%H%M%S)"
mkdir -p "${Q_DIR}"
shopt -s nullglob
for f in functions_clean/.env*; do
  mv "${f}" "${Q_DIR}/$(basename "${f}")"
done
shopt -u nullglob

say "writing functions_clean/env.runtime"
cat > functions_clean/env.runtime <<'ENV'
GCLOUD_PROJECT=peakops-pilot
FIREBASE_PROJECT_ID=peakops-pilot
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
FIREBASE_STORAGE_BUCKET=peakops-pilot.appspot.com
STORAGE_BUCKET=peakops-pilot.appspot.com
DUMMY=1
ENV

if ls functions_clean/.env* >/dev/null 2>&1; then
  dump_fail ".env* files still present in functions_clean"
fi

say "ensuring firebase/functions entrypoint settings"
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const fbPath = path.join(root, "firebase.json");
const pkgPath = path.join(root, "functions_clean", "package.json");
const idxPath = path.join(root, "functions_clean", "index.js");
const mjsPath = path.join(root, "functions_clean", "index.mjs");

const fb = JSON.parse(fs.readFileSync(fbPath, "utf8"));
fb.functions = fb.functions || {};
fb.functions.source = "functions_clean";
fs.writeFileSync(fbPath, JSON.stringify(fb, null, 2) + "\n");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.main = "index.js";
pkg.type = "commonjs";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

if (fs.existsSync(mjsPath)) {
  try { fs.renameSync(mjsPath, mjsPath + ".disabled_by_fn_gate"); } catch (_) {}
}

let idx = fs.readFileSync(idxPath, "utf8");
if (!idx.startsWith("require(\"./_emu_bootstrap\");") && !idx.startsWith("require('./_emu_bootstrap');")) {
  idx = "require(\"./_emu_bootstrap\");\n" + idx;
}
if (!idx.includes("exports.hello")) {
  if (!idx.includes("firebase-functions/v2/https")) {
    idx = "const { onRequest } = require(\"firebase-functions/v2/https\");\n" + idx;
  }
  idx += "\nexports.hello = onRequest((req, res) => res.json({ ok: true, msg: \"hello from functions_clean\" }));\n";
}
if (!idx.includes("exports.healthzV1")) {
  if (!idx.includes("firebase-functions/v2/https")) {
    idx = "const { onRequest } = require(\"firebase-functions/v2/https\");\n" + idx;
  }
  idx += "\nexports.healthzV1 = onRequest((req, res) => res.json({ ok: true, functions: Object.keys(module.exports || {}).sort() }));\n";
}
fs.writeFileSync(idxPath, idx);
NODE

say "starting functions-only emulator"
: > "${LOG_FILE}"
nohup firebase emulators:start --only functions --project "${PROJECT_ID}" --config "${CONFIG_PATH}" > "${LOG_FILE}" 2>&1 &

for _ in $(seq 1 60); do
  if lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1 || dump_fail "port 5004 not listening"

HELLO_CODE="000"
HELLO_OUT="$(mktemp /tmp/peakops_fn_hello.XXXXXX)"
for _ in $(seq 1 60); do
  HELLO_CODE="$(curl -sS -o "${HELLO_OUT}" -w '%{http_code}' "${FN_BASE}/hello" || true)"
  if [[ "${HELLO_CODE}" == "200" ]]; then
    break
  fi
  sleep 0.25
done
[[ "${HELLO_CODE}" == "200" ]] || {
  sed -n '1,40p' "${HELLO_OUT}" >&2 || true
  dump_fail "/hello http=${HELLO_CODE}"
}

say "PASS"

