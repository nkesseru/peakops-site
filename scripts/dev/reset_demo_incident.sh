#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FS_PORT="${FS_PORT:-8085}"
FN_PORT="${FN_PORT:-5002}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"

say() { echo "[reset-demo] $*"; }
fail() { echo "[reset-demo] FAIL: $*" >&2; exit 1; }

if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi
if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi

if ! lsof -nP -iTCP:"${FS_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Firestore emulator is not listening on ${FS_PORT}. Start emulators first."
fi
probe_code="$(curl -s -o /dev/null -w '%{http_code}' "${FS_BASE}" || true)"
if [[ "${probe_code}" == "000" ]]; then
  fail "Cannot reach Firestore emulator at ${FS_BASE}"
fi

delete_collection_docs() {
  local subcol="$1"
  local list_url="${FS_BASE}/incidents/${INCIDENT_ID}/${subcol}?pageSize=500"
  local out_file
  out_file="$(mktemp /tmp/peakops_reset_${subcol}.XXXXXX.json)"
  local code
  code="$(curl -sS -o "${out_file}" -w '%{http_code}' "${list_url}" || true)"
  if [[ "${code}" -lt 200 || "${code}" -gt 399 ]]; then
    rm -f "${out_file}"
    fail "Failed listing subcollection ${subcol} (${code})"
  fi
  jq -r '.documents[]?.name // empty' "${out_file}" | while IFS= read -r full_name; do
    [[ -z "${full_name}" ]] && continue
    local rel
    rel="${full_name#projects/${PROJECT_ID}/databases/(default)/documents/}"
    local del_url="${FS_BASE}/${rel}"
    curl -sS -X DELETE "${del_url}" >/dev/null || true
  done
  rm -f "${out_file}"
}

say "Deleting incident subcollections for ${INCIDENT_ID}"
delete_collection_docs "jobs"
delete_collection_docs "evidence_locker"
delete_collection_docs "timeline"
delete_collection_docs "conversion_jobs"

say "Deleting incident doc incidents/${INCIDENT_ID}"
curl -sS -X DELETE "${FS_BASE}/incidents/${INCIDENT_ID}" >/dev/null || true

say "Best-effort storage cleanup under orgs/${ORG_ID}/incidents/${INCIDENT_ID}/uploads/"
if lsof -nP -iTCP:"${FN_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  list_code="$(curl -sS -o /tmp/peakops_reset_list.json -w '%{http_code}' "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=500" || true)"
  if [[ "${list_code}" -ge 200 && "${list_code}" -le 399 ]]; then
    say "No direct delete endpoint configured; storage cleanup skipped (best effort)."
  else
    say "Storage cleanup skipped (functions not reachable for listEvidenceLocker)."
  fi
else
  say "Storage cleanup skipped (functions emulator not listening)."
fi

say "DONE reset incident ${INCIDENT_ID}"
