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
die(){ echo "[fn-gate] FAIL: $*" >&2; exit 1; }

mkdir -p "${LOG_DIR}"

print_diag_and_fail() {
  local msg="$1"
  echo "[fn-gate] FAIL: ${msg}" >&2
  echo "[fn-gate] --- /tmp/peakops/fn_gate.log tail ---" >&2
  tail -n 220 "${LOG_FILE}" 2>/dev/null >&2 || true
  echo "[fn-gate] --- functions_clean env files ---" >&2
  ls -la functions_clean | grep env >&2 || true
  echo "[fn-gate] --- functions_clean/index.js head ---" >&2
  sed -n '1,40p' functions_clean/index.js >&2 || true
  exit 1
}

ensure_config_and_entrypoint() {
  say "ensuring firebase/functions entrypoint config"
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
  const dst = mjsPath + ".disabled_by_fn_gate";
  try { fs.renameSync(mjsPath, dst); } catch (_) {}
}

let idx = fs.readFileSync(idxPath, "utf8");
if (!idx.includes("_emu_bootstrap")) {
  idx = "require(\"./_emu_bootstrap\");\n" + idx;
}
if (!idx.includes("exports.hello")) {
  if (!idx.includes("firebase-functions/v2/https")) {
    idx = "const { onRequest } = require(\"firebase-functions/v2/https\");\n" + idx;
  }
  idx += "\nexports.hello = onRequest((req, res) => res.json({ ok: true, msg: \"hello from functions_clean\" }));\n";
}
fs.writeFileSync(idxPath, idx);
NODE
}

start_functions_only() {
  say "starting functions-only emulator"
  : > "${LOG_FILE}"
  export GCLOUD_PROJECT="${GCLOUD_PROJECT:-${PROJECT_ID}}"
  export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-${PROJECT_ID}}"
  export FIREBASE_STORAGE_EMULATOR_HOST="${FIREBASE_STORAGE_EMULATOR_HOST:-127.0.0.1:9199}"
  export FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-${PROJECT_ID}.appspot.com}"
  export STORAGE_BUCKET="${STORAGE_BUCKET:-${PROJECT_ID}.appspot.com}"
  nohup firebase emulators:start --only functions --project "${PROJECT_ID}" --config "${CONFIG_PATH}" > "${LOG_FILE}" 2>&1 &
}

say "killing emulator/tool processes"
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

still_busy=0
for p in "${PORTS[@]}"; do
  if lsof -nP -iTCP:${p} -sTCP:LISTEN >/dev/null 2>&1; then
    still_busy=1
    say "port ${p} still busy"
    lsof -nP -iTCP:${p} -sTCP:LISTEN || true
  fi
done
if [[ "${still_busy}" != "0" ]]; then
  say "second kill attempt on lingering listener pids"
  linger_pids="$(for p in "${PORTS[@]}"; do lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}'; done | sort -u || true)"
  if [[ -n "${linger_pids}" ]]; then
    for pid in ${linger_pids}; do
      kill -9 "${pid}" >/dev/null 2>&1 || true
    done
  fi
  sleep 1
fi

still_busy=0
for p in "${PORTS[@]}"; do
  if lsof -nP -iTCP:${p} -sTCP:LISTEN >/dev/null 2>&1; then
    still_busy=1
    say "port ${p} still busy after second attempt"
    lsof -nP -iTCP:${p} -sTCP:LISTEN || true
  fi
done
[[ "${still_busy}" == "0" ]] || die "could not free required ports"

say "quarantining functions_clean/.env* files"
Q_DIR="functions_clean/.env_quarantine_$(date +%Y%m%d_%H%M%S)"
mkdir -p "${Q_DIR}"
shopt -s nullglob
for f in functions_clean/.env*; do
  if [[ "${f}" == "${Q_DIR}" ]]; then
    continue
  fi
  mv "${f}" "${Q_DIR}/$(basename "${f}")"
done
shopt -u nullglob

say "writing functions_clean/.env.runtime (dotenv-parse-safe)"
cat > functions_clean/.env.runtime <<'ENV'
GCLOUD_PROJECT=peakops-pilot
FIREBASE_PROJECT_ID=peakops-pilot
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
FIREBASE_STORAGE_BUCKET=peakops-pilot.appspot.com
STORAGE_BUCKET=peakops-pilot.appspot.com
DUMMY=1
ENV

if [[ -f functions_clean/.env || -f functions_clean/.env.local ]]; then
  print_diag_and_fail ".env or .env.local still present after quarantine"
fi

file -I functions_clean/.env.runtime || true
if command -v xxd >/dev/null 2>&1; then
  xxd -g 1 -l 128 functions_clean/.env.runtime || true
fi

ensure_config_and_entrypoint
start_functions_only

for _ in $(seq 1 40); do
  if lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1 || print_diag_and_fail "port 5004 not listening"

HELLO_FILE="$(mktemp /tmp/peakops_fn_gate_hello.XXXXXX)"
HELLO_CODE=""
for _ in $(seq 1 40); do
  HELLO_CODE="$(curl -sS -o "${HELLO_FILE}" -w '%{http_code}' "${FN_BASE}/hello" || true)"
  if [[ "${HELLO_CODE}" == "200" ]]; then
    break
  fi
  sleep 0.25
done
if [[ "${HELLO_CODE}" != "200" ]]; then
  if [[ "${HELLO_CODE}" == "404" ]]; then
    say "/hello returned 404; re-checking config/entrypoint and retrying once"
    ensure_config_and_entrypoint
    pkill -f "firebase emulators:start --only functions" >/dev/null 2>&1 || true
    sleep 1
    start_functions_only
    for _ in $(seq 1 40); do
      HELLO_CODE="$(curl -sS -o "${HELLO_FILE}" -w '%{http_code}' "${FN_BASE}/hello" || true)"
      if [[ "${HELLO_CODE}" == "200" ]]; then
        break
      fi
      sleep 0.25
    done
  fi
  sed -n '1,15p' "${HELLO_FILE}" >&2 || true
  [[ "${HELLO_CODE}" == "200" ]] || print_diag_and_fail "/hello http=${HELLO_CODE}"
fi

HEALTH_FILE="$(mktemp /tmp/peakops_fn_gate_health.XXXXXX)"
HEALTH_CODE="$(curl -sS -o "${HEALTH_FILE}" -w '%{http_code}' "${FN_BASE}/healthzV1" || true)"
if [[ "${HEALTH_CODE}" != "200" ]]; then
  sed -n '1,40p' "${HEALTH_FILE}" >&2 || true
  print_diag_and_fail "/healthzV1 http=${HEALTH_CODE}"
fi

jq -e '.ok == true and ((.functions // []) | index("hello") != null) and ((.functions // []) | index("healthzV1") != null) and ((.functions // []) | index("listEvidenceLocker") != null) and ((.functions // []) | index("createEvidenceReadUrlV1") != null) and ((.functions // []) | index("uploadEvidenceProxyV1") != null)' "${HEALTH_FILE}" >/dev/null || {
  sed -n '1,80p' "${HEALTH_FILE}" >&2 || true
  print_diag_and_fail "healthzV1 missing required handlers"
}

say "PASS"
