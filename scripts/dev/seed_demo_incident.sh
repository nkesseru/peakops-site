#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FS_PORT="${FS_PORT:-8085}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_20260121_121658_26f47b}"
BUCKET="${BUCKET:-${PROJECT_ID}.firebasestorage.app}"

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
NOW_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

say() { echo "[seed-demo] $*"; }
fail() { echo "[seed-demo] FAIL: $*" >&2; exit 1; }

if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi
if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi

if ! lsof -nP -iTCP:"${FS_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Firestore emulator is not listening on ${FS_PORT}. Start emulators first: firebase emulators:start --project ${PROJECT_ID} --config firebase.json --only functions,firestore,ui"
fi

probe_code="$(curl -s -o /dev/null -w '%{http_code}' "${FS_BASE}" || true)"
if [[ "${probe_code}" == "000" ]]; then
  fail "Cannot reach Firestore emulator at ${FS_BASE}"
fi

patch_doc() {
  local doc_path="$1"
  local fields_json="$2"
  local url="${FS_BASE}/${doc_path}"
  local payload
  payload="$(jq -n --argjson f "${fields_json}" '{fields:$f}')"
  curl -sS -X PATCH "${url}" -H 'content-type: application/json' -d "${payload}" >/dev/null
}

mk_evidence_fields() {
  local evidence_id="$1"
  local content_type="$2"
  local original_name="$3"
  local storage_path="$4"
  local conversion_status="$5"

  jq -n \
    --arg orgId "${ORG_ID}" \
    --arg incidentId "${INCIDENT_ID}" \
    --arg evidenceId "${evidence_id}" \
    --arg sessionId "ses_demo_001" \
    --arg phase "INSPECTION" \
    --arg nowTs "${NOW_TS}" \
    --arg bucket "${BUCKET}" \
    --arg storagePath "${storage_path}" \
    --arg contentType "${content_type}" \
    --arg originalName "${original_name}" \
    --arg conversionStatus "${conversion_status}" \
    '{
      orgId: {stringValue: $orgId},
      incidentId: {stringValue: $incidentId},
      evidenceId: {stringValue: $evidenceId},
      sessionId: {stringValue: $sessionId},
      phase: {stringValue: $phase},
      labels: {arrayValue: {values: [{stringValue:"DAMAGE"}] }},
      notes: {stringValue: "Seeded demo evidence"},
      createdAt: {timestampValue: $nowTs},
      storedAt: {timestampValue: $nowTs},
      version: {integerValue: "1"},
      file: {
        mapValue: {
          fields: {
            bucket: {stringValue: $bucket},
            storagePath: {stringValue: $storagePath},
            contentType: {stringValue: $contentType},
            originalName: {stringValue: $originalName},
            conversionStatus: {stringValue: $conversionStatus}
          }
        }
      }
    }'
}

say "Seeding incident ${INCIDENT_ID}"
incident_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg nowTs "${NOW_TS}" \
  '{
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    title: {stringValue: "Demo Incident (Seeded)"},
    status: {stringValue: "open"},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}" "${incident_fields}"

EVIDENCE_IDS=(
  "ev_demo_heic_001"
  "ev_demo_jpg_001"
  "ev_demo_png_001"
  "ev_demo_jpg_002"
  "ev_demo_png_002"
)

CONTENT_TYPES=(
  "image/heic"
  "image/jpeg"
  "image/png"
  "image/jpeg"
  "image/png"
)

ORIGINAL_NAMES=(
  "IMG_4344_2.heic"
  "pole_damage_wide.jpg"
  "meter_panel.png"
  "conductor_close.jpg"
  "site_overview.png"
)

CONV_STATUS=(
  "pending"
  "n/a"
  "n/a"
  "n/a"
  "n/a"
)

for i in "${!EVIDENCE_IDS[@]}"; do
  eid="${EVIDENCE_IDS[$i]}"
  ct="${CONTENT_TYPES[$i]}"
  oname="${ORIGINAL_NAMES[$i]}"
  cstatus="${CONV_STATUS[$i]}"
  sp="orgs/${ORG_ID}/incidents/${INCIDENT_ID}/uploads/ses_demo_001/20260121T121658Z__${oname}"
  fields="$(mk_evidence_fields "${eid}" "${ct}" "${oname}" "${sp}" "${cstatus}")"
  patch_doc "incidents/${INCIDENT_ID}/evidence_locker/${eid}" "${fields}"
done

say "Seeding conversion_jobs entry for HEIC evidence"
job_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg evidenceId "ev_demo_heic_001" \
  --arg bucket "${BUCKET}" \
  --arg storagePath "orgs/${ORG_ID}/incidents/${INCIDENT_ID}/uploads/ses_demo_001/20260121T121658Z__IMG_4344_2.heic" \
  --arg nowTs "${NOW_TS}" \
  '{
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    evidenceId: {stringValue: $evidenceId},
    bucket: {stringValue: $bucket},
    storagePath: {stringValue: $storagePath},
    status: {stringValue: "queued"},
    attempts: {integerValue: "0"},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}/conversion_jobs/ev_demo_heic_001" "${job_fields}"

say "Done. Seeded incident=${INCIDENT_ID} org=${ORG_ID} evidence=5 (including HEIC)."
