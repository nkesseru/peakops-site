#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
SEED_MODE="${SEED_MODE:-review}"
FN_BASE="http://127.0.0.1:5004/${PROJECT_ID}/us-central1"

say(){ echo "[stack-smoke] $*"; }
die(){ echo "[stack-smoke] FAIL: $*" >&2; exit 1; }

assert_functions() {
  local hello_code
  hello_code="$(curl -sS -o /tmp/peakops_stack_smoke_hello.out -w '%{http_code}' "${FN_BASE}/hello" || true)"
  [[ "${hello_code}" == "200" ]] || {
    sed -n '1,80p' /tmp/peakops_stack_smoke_hello.out || true
    die "/hello http=${hello_code}"
  }

  local health_code
  health_code="$(curl -sS -o /tmp/peakops_stack_smoke_health.out -w '%{http_code}' "${FN_BASE}/healthzV1" || true)"
  [[ "${health_code}" == "200" ]] || {
    sed -n '1,120p' /tmp/peakops_stack_smoke_health.out || true
    die "/healthzV1 http=${health_code}"
  }
  jq -e '.ok == true and ((.functions // []) | index("hello") != null) and ((.functions // []) | index("listEvidenceLocker") != null) and ((.functions // []) | index("createEvidenceReadUrlV1") != null) and ((.functions // []) | index("uploadEvidenceProxyV1") != null)' /tmp/peakops_stack_smoke_health.out >/dev/null || {
    sed -n '1,160p' /tmp/peakops_stack_smoke_health.out || true
    die "healthzV1 missing required handlers"
  }
}

say "gate_fn_registration"
bash scripts/dev/gate_fn_registration.sh
assert_functions

say "demo_up"
SEED_MODE="${SEED_MODE}" bash scripts/dev/demo_up.sh
assert_functions

say "PASS"
