#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FS_PORT="${FS_PORT:-}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"

say() { echo "[seed-demo-blank] $*"; }
fail() { echo "[seed-demo-blank] FAIL: $*" >&2; exit 1; }

resolve_emulator_ports() {
  local cfg="firebase.json"
  local fs_port="${FS_PORT}"

  if [[ -z "${fs_port}" && -f "${cfg}" ]]; then
    fs_port="$(jq -r '.emulators.firestore.port // empty' "${cfg}" 2>/dev/null || true)"
  fi

  FS_PORT="${fs_port:-8087}"
}

if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi
if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi

resolve_emulator_ports

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
NOW_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

patch_doc() {
  local doc_path="$1"
  local fields_json="$2"
  local url="${FS_BASE}/${doc_path}"
  local payload out_file code
  payload="$(jq -n --argjson f "${fields_json}" '{fields:$f}')"
  out_file="$(mktemp /tmp/peakops_seed_patch.XXXXXX.json)"
  code="$(curl -sS -o "${out_file}" -w '%{http_code}' -X PATCH "${url}" -H 'content-type: application/json' -d "${payload}" || true)"
  if [[ "${code}" -lt 200 || "${code}" -gt 299 ]]; then
    cat "${out_file}" >&2 || true
    rm -f "${out_file}"
    fail "patch_doc failed (${code}) path=${doc_path}"
  fi
  rm -f "${out_file}"
}

if ! lsof -nP -iTCP:"${FS_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Firestore emulator is not listening on ${FS_PORT}"
fi

probe_code="$(curl -s -o /dev/null -w '%{http_code}' "${FS_BASE}" || true)"
if [[ "${probe_code}" == "000" ]]; then
  fail "Cannot reach Firestore emulator at ${FS_BASE}"
fi

say "Seeding blank demo org docs"

org_main_fields="$(jq -n --arg orgId "${ORG_ID}" --arg nowTs "${NOW_TS}" '{
  orgId: {stringValue: $orgId},
  name: {stringValue: "Riverbend Electric"},
  displayName: {stringValue: "Riverbend Electric"},
  createdAt: {timestampValue: $nowTs},
  updatedAt: {timestampValue: $nowTs}
}')"
patch_doc "orgs/${ORG_ID}" "${org_main_fields}"

org_peer_a_fields="$(jq -n --arg nowTs "${NOW_TS}" '{
  orgId: {stringValue: "northgrid-services"},
  name: {stringValue: "Northgrid Services"},
  displayName: {stringValue: "Northgrid Services"},
  createdAt: {timestampValue: $nowTs},
  updatedAt: {timestampValue: $nowTs}
}')"
patch_doc "orgs/northgrid-services" "${org_peer_a_fields}"

org_peer_b_fields="$(jq -n --arg nowTs "${NOW_TS}" '{
  orgId: {stringValue: "metro-lineworks"},
  name: {stringValue: "Metro Lineworks"},
  displayName: {stringValue: "Metro Lineworks"},
  createdAt: {timestampValue: $nowTs},
  updatedAt: {timestampValue: $nowTs}
}')"
patch_doc "orgs/metro-lineworks" "${org_peer_b_fields}"

say "Seeding blank incident ${INCIDENT_ID}"

incident_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg nowTs "${NOW_TS}" \
  '{
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    title: {stringValue: "Riverbend Electric Incident"},
    status: {stringValue: "open"},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}" "${incident_fields}"

say "Seeding demo jobs for review queue testing"

job_001_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg assignedOrgId "northgrid-services" \
  --arg nowTs "${NOW_TS}" \
  '{
    jobId: {stringValue: "job_demo_001"},
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    assignedOrgId: {stringValue: $assignedOrgId},
    title: {stringValue: "Inspect pole base A"},
    status: {stringValue: "complete"},
    notes: {stringValue: ""},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}/jobs/job_demo_001" "${job_001_fields}"

job_002_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg assignedOrgId "metro-lineworks" \
  --arg nowTs "${NOW_TS}" \
  '{
    jobId: {stringValue: "job_demo_002"},
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    assignedOrgId: {stringValue: $assignedOrgId},
    title: {stringValue: "Inspect pole base B"},
    status: {stringValue: "complete"},
    notes: {stringValue: ""},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}/jobs/job_demo_002" "${job_002_fields}"

job_003_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg assignedOrgId "metro-lineworks" \
  --arg nowTs "${NOW_TS}" \
  '{
    jobId: {stringValue: "job_demo_003"},
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    assignedOrgId: {stringValue: $assignedOrgId},
    title: {stringValue: "Inspect pole base C"},
    status: {stringValue: "open"},
    notes: {stringValue: ""},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}/jobs/job_demo_003" "${job_003_fields}"



say "Verifying seeded incident and job"
incident_code="$(curl -s -o /tmp/peakops_seed_incident_verify.json -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}" || true)"
if [[ "${incident_code}" -lt 200 || "${incident_code}" -gt 299 ]]; then
  cat /tmp/peakops_seed_incident_verify.json >&2 || true
  fail "incident verify failed (${incident_code}) incidents/${INCIDENT_ID}"
fi

jobs_code="$(curl -s -o /tmp/peakops_seed_jobs_verify.json -w '%{http_code}' "${FS_BASE}/incidents/${INCIDENT_ID}/jobs?pageSize=20" || true)"
if [[ "${jobs_code}" -lt 200 || "${jobs_code}" -gt 299 ]]; then
  cat /tmp/peakops_seed_jobs_verify.json >&2 || true
  fail "jobs verify failed (${jobs_code}) incidents/${INCIDENT_ID}/jobs"
fi

job_count="$(jq -r '(.documents // []) | length' /tmp/peakops_seed_jobs_verify.json 2>/dev/null || echo 0)"
if [[ "${job_count}" -lt 1 ]]; then
  cat /tmp/peakops_seed_jobs_verify.json >&2 || true
  fail "expected at least 1 seeded job, got ${job_count}"
fi

say "DONE blank seed incident=${INCIDENT_ID}"
