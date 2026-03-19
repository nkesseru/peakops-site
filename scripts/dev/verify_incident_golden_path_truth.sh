#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FS_PORT="${FS_PORT:-8087}"
FN_PORT="${FN_PORT:-5004}"

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

need_cmd curl
need_cmd jq

echo "== verify incident golden path truth =="
echo "orgId=${ORG_ID}"
echo "incidentId=${INCIDENT_ID}"
echo

INCIDENT_JSON="$(curl -fsS "${FS_BASE}/incidents/${INCIDENT_ID}")" || fail "could not fetch incident doc"
JOBS_JSON="$(curl -fsS "${FS_BASE}/incidents/${INCIDENT_ID}/jobs?pageSize=500")" || fail "could not fetch jobs"
EVIDENCE_JSON="$(curl -fsS "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=500")" || fail "could not fetch evidence_locker"
TIMELINE_JSON="$(curl -fsS "${FN_BASE}/getTimelineEventsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=500")" || fail "could not fetch timeline events"

PACKET_STATUS="$(echo "$INCIDENT_JSON" | jq -r '.fields.packetMeta.mapValue.fields.status.stringValue // ""')"
PACKET_JOB_COUNT="$(echo "$INCIDENT_JSON" | jq -r '.fields.packetMeta.mapValue.fields.jobCount.integerValue // "0"' | tr -d '"')"
PACKET_EVIDENCE_COUNT="$(echo "$INCIDENT_JSON" | jq -r '.fields.packetMeta.mapValue.fields.evidenceCount.integerValue // "0"' | tr -d '"')"
PACKET_EXPORTED_COUNT="$(echo "$INCIDENT_JSON" | jq -r '.fields.packetMeta.mapValue.fields.exportedCount.integerValue // "0"' | tr -d '"')"
PACKET_SKIPPED_COUNT="$(echo "$INCIDENT_JSON" | jq -r '.fields.packetMeta.mapValue.fields.skippedCount.integerValue // "0"' | tr -d '"')"

APPROVED_JOB_COUNT="$(echo "$JOBS_JSON" | jq '[.documents[]? |
  {
    status:(.fields.status.stringValue // "" | ascii_downcase),
    reviewStatus:(.fields.reviewStatus.stringValue // "" | ascii_downcase)
  }
  | select(.reviewStatus=="approved" or .status=="approved")
] | length')"

LOCKER_EVIDENCE_COUNT="$(echo "$EVIDENCE_JSON" | jq '(.documents // []) | length')"

TIMELINE_COUNTS="$(echo "$TIMELINE_JSON" | jq '[.docs[]? | (.type // "" | ascii_downcase)] | group_by(.) | map({type: .[0], count: length})')"

count_event() {
  local event_type="$1"
  echo "$TIMELINE_COUNTS" | jq --arg t "$event_type" '[.[] | select(.type == $t) | .count][0] // 0'
}

FIELD_SUBMITTED_COUNT="$(count_event field_submitted)"
INCIDENT_CLOSED_COUNT="$(count_event incident_closed)"
JOB_APPROVED_COUNT="$(count_event job_approved)"
JOB_COMPLETED_COUNT="$(count_event job_completed)"
JOB_REVIEWED_COUNT="$(count_event job_reviewed)"
EVIDENCE_ADDED_COUNT="$(count_event evidence_added)"

echo "packetStatus        = ${PACKET_STATUS}"
echo "packetJobCount      = ${PACKET_JOB_COUNT}"
echo "packetEvidenceCount = ${PACKET_EVIDENCE_COUNT}"
echo "packetExportedCount = ${PACKET_EXPORTED_COUNT}"
echo "packetSkippedCount  = ${PACKET_SKIPPED_COUNT}"
echo "approvedJobCount    = ${APPROVED_JOB_COUNT}"
echo "lockerEvidenceCount = ${LOCKER_EVIDENCE_COUNT}"
echo
echo "timeline counts:"
echo "$TIMELINE_COUNTS" | jq .
echo

[[ "$PACKET_STATUS" == "ready" ]] || fail "packetMeta.status must be ready"
[[ "$PACKET_JOB_COUNT" == "$APPROVED_JOB_COUNT" ]] || fail "packetMeta.jobCount (${PACKET_JOB_COUNT}) != approved jobs (${APPROVED_JOB_COUNT})"
[[ "$PACKET_EVIDENCE_COUNT" == "$LOCKER_EVIDENCE_COUNT" ]] || fail "packetMeta.evidenceCount (${PACKET_EVIDENCE_COUNT}) != evidence locker count (${LOCKER_EVIDENCE_COUNT})"
[[ "$FIELD_SUBMITTED_COUNT" -ge 1 ]] || fail "expected field_submitted >= 1"
[[ "$INCIDENT_CLOSED_COUNT" -ge 1 ]] || fail "expected incident_closed >= 1"
[[ "$JOB_APPROVED_COUNT" -ge 2 ]] || fail "expected job_approved >= 2"

echo "PASS: incident golden path truth verified"
