#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
EVIDENCE_ID="${EVIDENCE_ID:-ev_demo_heic_001}"
FS_PORT="${FS_PORT:-}"

if [[ -z "${FS_PORT}" ]]; then
  if [[ -f firebase.json ]]; then
    FS_PORT="$(jq -r '.emulators.firestore.port // empty' firebase.json 2>/dev/null || true)"
  fi
fi
FS_PORT="${FS_PORT:-8087}"

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
DOC_URL="${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker/${EVIDENCE_ID}"

say "evidence-doctor" "repoRoot=${REPO_ROOT} fsPort=${FS_PORT} projectId=${PROJECT_ID} incidentId=${INCIDENT_ID} evidenceId=${EVIDENCE_ID}"

CODE="$(curl -sS -o /tmp/peakops_evidence_doctor.json -w '%{http_code}' "${DOC_URL}" || true)"
if [[ "${CODE}" -lt 200 || "${CODE}" -gt 299 ]]; then
  cat /tmp/peakops_evidence_doctor.json 2>/dev/null || true
  fail "evidence-doctor" "fetch failed http=${CODE} url=${DOC_URL}"
fi

TOP_JOBID="$(jq -r '.fields.jobId.stringValue // .fields["jobId"].stringValue // ""' /tmp/peakops_evidence_doctor.json 2>/dev/null || echo "")"
NESTED_JOBID="$(jq -r '.fields.evidence.mapValue.fields.jobId.stringValue // .fields["evidence.jobId"].stringValue // ""' /tmp/peakops_evidence_doctor.json 2>/dev/null || echo "")"
STORAGE_PATH="$(jq -r '.fields.file.mapValue.fields.storagePath.stringValue // .fields["file.storagePath"].stringValue // ""' /tmp/peakops_evidence_doctor.json 2>/dev/null || echo "")"

say "evidence-doctor" "topJobId=${TOP_JOBID:-<empty>} nestedEvidenceJobId=${NESTED_JOBID:-<empty>} storagePath=${STORAGE_PATH:-<empty>}"

if [[ -z "${TOP_JOBID}" && -z "${NESTED_JOBID}" ]]; then
  fail "evidence-doctor" "missing job linkage for ${EVIDENCE_ID} (both top-level jobId and evidence.jobId empty)"
fi

say "evidence-doctor" "PASS"
