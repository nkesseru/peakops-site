#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FS_PORT="${FS_PORT:-}"
FN_PORT="${FN_PORT:-}"
STORAGE_PORT="${STORAGE_PORT:-}"
SEED_MODE="${SEED_MODE:-review}"
ORG_ID="${ORG_ID:-riverbend-electric}"
INCIDENT_ID="${INCIDENT_ID:-inc_demo}"
BUCKET="${BUCKET:-}"
HEIC_SAMPLE_FILE="${HEIC_SAMPLE_FILE:-}"
ASSET_DIR="${ASSET_DIR:-scripts/dev/assets}"

FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"
NOW_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
SESSION_ID="ses_demo_${RUN_ID}"

say() { echo "[seed-demo] $*"; }
warn() { echo "[seed-demo] WARN: $*" >&2; }
fail() { echo "[seed-demo] FAIL: $*" >&2; exit 1; }
fail_verify() { echo "[seed-demo] VERIFY_FAIL: $*" >&2; exit 2; }

resolve_emulator_ports() {
  local cfg="firebase.json"
  local fs_port fn_port storage_port
  fs_port="${FS_PORT}"
  fn_port="${FN_PORT}"
  storage_port="${STORAGE_PORT}"

  if [[ -z "${fs_port}" || -z "${fn_port}" || -z "${storage_port}" ]]; then
    if [[ -f "${cfg}" ]]; then
      if [[ -z "${fs_port}" ]]; then
        fs_port="$(jq -r '.emulators.firestore.port // empty' "${cfg}" 2>/dev/null || true)"
      fi
      if [[ -z "${fn_port}" ]]; then
        fn_port="$(jq -r '.emulators.functions.port // empty' "${cfg}" 2>/dev/null || true)"
      fi
      if [[ -z "${storage_port}" ]]; then
        storage_port="$(jq -r '.emulators.storage.port // empty' "${cfg}" 2>/dev/null || true)"
      fi
    fi
  fi

  FS_PORT="${fs_port:-8087}"
  FN_PORT="${fn_port:-5004}"
  STORAGE_PORT="${storage_port:-9199}"
}

if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi
if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi
if ! command -v od >/dev/null 2>&1; then fail "od is required"; fi

resolve_emulator_ports
FS_BASE="http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents"
FN_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1"
say "Using emulator ports firestore=${FS_PORT} functions=${FN_PORT}"
say "Using storage emulator port ${STORAGE_PORT}"
say "Using seed mode ${SEED_MODE}"

STORAGE_BASE="http://127.0.0.1:${STORAGE_PORT}"
STORAGE_EMULATOR_UP="0"
STORAGE_PROBE_CODE="$(curl -s -o /tmp/peakops_seed_storage_probe.out -w '%{http_code}' "${STORAGE_BASE}/storage/v1/b" || true)"
if [[ "${STORAGE_PROBE_CODE}" != "000" ]]; then
  STORAGE_EMULATOR_UP="1"
fi

resolve_seed_bucket() {
  if [[ -n "${BUCKET}" ]]; then
    return
  fi
  local preferred="${PROJECT_ID}.firebasestorage.app"
  local discovered=""
  if [[ "${STORAGE_EMULATOR_UP}" == "1" ]]; then
    discovered="$(
      curl -sS "${STORAGE_BASE}/storage/v1/b" 2>/dev/null \
        | jq -r '.items[0].name // .items[0].id // empty' 2>/dev/null || true
    )"
    if [[ -z "${discovered}" ]]; then
      discovered="$(
        curl -sS "${STORAGE_BASE}/v0/b" 2>/dev/null \
          | jq -r '.items[0].name // .items[0].id // empty' 2>/dev/null || true
      )"
    fi
  fi
  if [[ -n "${discovered}" ]]; then
    BUCKET="${discovered}"
    return
  fi
  if [[ -n "${FIREBASE_STORAGE_BUCKET:-}" ]]; then
    BUCKET="${FIREBASE_STORAGE_BUCKET}"
    return
  fi
  if [[ -n "${STORAGE_BUCKET:-}" ]]; then
    BUCKET="${STORAGE_BUCKET}"
    return
  fi
  BUCKET="${preferred}"
}

resolve_seed_bucket
say "Using storage bucket ${BUCKET}"

decode_b64_to_file() {
  local out_file="$1"
  local data="$2"
  if base64 --help 2>/dev/null | grep -q -- '--decode'; then
    printf '%s' "${data}" | base64 --decode > "${out_file}"
    return
  fi
  if base64 -D </dev/null >/dev/null 2>&1; then
    printf '%s' "${data}" | base64 -D > "${out_file}"
    return
  fi
  printf '%s' "${data}" | base64 -d > "${out_file}"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

hex_prefix() {
  local file_path="$1"
  local nbytes="$2"
  if command -v xxd >/dev/null 2>&1; then
    xxd -p -l "${nbytes}" "${file_path}" | tr -d '\n'
    return
  fi
  od -An -t x1 -N "${nbytes}" "${file_path}" | tr -d ' \n'
}

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

patch_top_level_jobid_only() {
  local doc_path="$1"
  local job_id="$2"
  local url="${FS_BASE}/${doc_path}?updateMask.fieldPaths=jobId"
  local payload
  payload="$(jq -n --arg jobId "${job_id}" '{fields:{jobId:{stringValue:$jobId}}}')"
  curl -sS -X PATCH "${url}" -H 'content-type: application/json' -d "${payload}" >/dev/null
}

patch_jobid_both() {
  local doc_path="$1"
  local job_id="$2"
  local url="${FS_BASE}/${doc_path}?updateMask.fieldPaths=jobId&updateMask.fieldPaths=evidence.jobId"
  local payload
  payload="$(jq -n --arg jobId "${job_id}" '{fields:{jobId:{stringValue:$jobId}, evidence:{mapValue:{fields:{jobId:{stringValue:$jobId}}}}}}')"
  curl -sS -X PATCH "${url}" -H 'content-type: application/json' -d "${payload}" >/dev/null
}

SEED_VERIFY_FILE="/tmp/peakops_seed_evidence.json"

dump_seed_verify_debug() {
  local code="$1"
  local body300 ok_count_line
  body300="$(head -c 300 "${SEED_VERIFY_FILE}" 2>/dev/null | tr '\n' ' ' || true)"
  ok_count_line="$(jq -c '{ok,count}' "${SEED_VERIFY_FILE}" 2>/dev/null || echo '{}')"
  echo "[seed-demo] verify_debug http=${code} body300=${body300}" >&2
  echo "[seed-demo] verify_debug ok_count=${ok_count_line}" >&2
}

fetch_seeded_assignments_with_retry() {
  local attempts=40
  local i code
  : > "${SEED_VERIFY_FILE}"
  for i in $(seq 1 "${attempts}"); do
    code="$(
      curl -sS -o "${SEED_VERIFY_FILE}" -w '%{http_code}' \
        "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=200" || true
    )"
    if [[ "${code}" -ge 200 && "${code}" -le 299 ]] && jq -e '.ok == true and (.docs | type == "array")' "${SEED_VERIFY_FILE}" >/dev/null 2>&1; then
      echo "${code}"
      return 0
    fi
    sleep 0.25
  done
  echo "${code:-000}"
  return 1
}

compute_seed_verify_counts() {
  VERIFY_SEED_COUNT="$(jq -r '[.docs[]? | select((.id // "") | startswith("ev_demo_"))] | length' "${SEED_VERIFY_FILE}" 2>/dev/null || echo "")"
  VERIFY_TOPLEVEL_JOBID_COUNT="$(jq -r '[.docs[]? | select((.id // "") | startswith("ev_demo_")) | select(((.jobId // "") | length) > 0)] | length' "${SEED_VERIFY_FILE}" 2>/dev/null || echo "")"
  VERIFY_JOB1_COUNT="$(jq -r '[.docs[]? | select((.id // "") | startswith("ev_demo_")) | select((.jobId // "") == "job_demo_001")] | length' "${SEED_VERIFY_FILE}" 2>/dev/null || echo "")"
  VERIFY_JOB2_COUNT="$(jq -r '[.docs[]? | select((.id // "") | startswith("ev_demo_")) | select((.jobId // "") == "job_demo_002")] | length' "${SEED_VERIFY_FILE}" 2>/dev/null || echo "")"
  VERIFY_UNKNOWN_COUNT="$(jq -r '[.docs[]? | select((.id // "") | startswith("ev_demo_")) | select(((.jobId // "") | length) == 0)] | length' "${SEED_VERIFY_FILE}" 2>/dev/null || echo "")"
  [[ -n "${VERIFY_SEED_COUNT}" && -n "${VERIFY_TOPLEVEL_JOBID_COUNT}" && -n "${VERIFY_JOB1_COUNT}" && -n "${VERIFY_JOB2_COUNT}" && -n "${VERIFY_UNKNOWN_COUNT}" ]]
}

assert_seeded_job_links_clean_or_fix() {
  local verify_code nested_jid target_job missing_eid
  verify_code="$(fetch_seeded_assignments_with_retry || true)"
  verify_code="${verify_code:-000}"
  if [[ "${verify_code}" -lt 200 || "${verify_code}" -gt 299 ]]; then
    dump_seed_verify_debug "${verify_code}"
    fail "listEvidenceLocker verify assignments failed (${verify_code})"
  fi
  if ! compute_seed_verify_counts; then
    dump_seed_verify_debug "${verify_code}"
    fail "seeded mapping verify failed: unable to parse jq counts from ${SEED_VERIFY_FILE}"
  fi

  if [[ "${SEED_MODE}" == "review" ]]; then
    say "verify: seeded=${VERIFY_SEED_COUNT} topLevelJobId=${VERIFY_TOPLEVEL_JOBID_COUNT} job1=${VERIFY_JOB1_COUNT} job2=${VERIFY_JOB2_COUNT} unknown=${VERIFY_UNKNOWN_COUNT}"
  fi

  if [[ "${VERIFY_SEED_COUNT}" -ne 5 || "${VERIFY_TOPLEVEL_JOBID_COUNT}" -ne 5 || "${VERIFY_JOB1_COUNT}" -lt 2 || "${VERIFY_JOB2_COUNT}" -lt 2 || "${VERIFY_UNKNOWN_COUNT}" -ne 0 ]]; then
    say "seeded mapping verify not clean; attempting deterministic fix"
    while IFS=$'\t' read -r missing_eid nested_jid; do
      [[ -z "${missing_eid}" ]] && continue
      target_job="job_demo_002"
      if [[ -n "${nested_jid}" ]]; then
        target_job="${nested_jid}"
      else
        case "${missing_eid}" in
          ev_demo_png_001|ev_demo_jpg_001) target_job="job_demo_001" ;;
          *) target_job="job_demo_002" ;;
        esac
      fi
      ASSIGN_FIX_CODE="$(
        curl -sS -o /tmp/peakops_seed_assign_fix.out -w '%{http_code}' \
          -X POST "${FN_BASE}/assignEvidenceToJobV1" \
          -H 'content-type: application/json' \
          -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"evidenceId\":\"${missing_eid}\",\"jobId\":\"${target_job}\"}" || true
      )"
      if [[ "${ASSIGN_FIX_CODE}" -lt 200 || "${ASSIGN_FIX_CODE}" -gt 299 ]]; then
        cat /tmp/peakops_seed_assign_fix.out 2>/dev/null || true
        fail "seeded mapping fix assignEvidenceToJobV1 failed (${ASSIGN_FIX_CODE}) evidenceId=${missing_eid} jobId=${target_job}"
      fi
      if ! jq -e '.ok == true' /tmp/peakops_seed_assign_fix.out >/dev/null 2>&1; then
        cat /tmp/peakops_seed_assign_fix.out 2>/dev/null || true
        fail "seeded mapping fix assignEvidenceToJobV1 returned ok!=true evidenceId=${missing_eid} jobId=${target_job}"
      fi
      patch_top_level_jobid_only "incidents/${INCIDENT_ID}/evidence_locker/${missing_eid}" "${target_job}"
      say "seeded mapping fix linked+patched ${missing_eid} -> ${target_job}"
    done < <(
      jq -r '
        .docs[]?
        | select((.id // "") | startswith("ev_demo_"))
        | select(((.jobId // "") | length) == 0)
        | [(.id // ""), (.evidence.jobId // "")]
        | @tsv
      ' "${SEED_VERIFY_FILE}" 2>/dev/null
    )

    verify_code="$(fetch_seeded_assignments_with_retry || true)"
    verify_code="${verify_code:-000}"
    if [[ "${verify_code}" -lt 200 || "${verify_code}" -gt 299 ]]; then
      dump_seed_verify_debug "${verify_code}"
      fail "listEvidenceLocker verify after seeded mapping fix failed (${verify_code})"
    fi
    if ! compute_seed_verify_counts; then
      dump_seed_verify_debug "${verify_code}"
      fail "seeded mapping verify failed after fix: unable to parse jq counts"
    fi
    if [[ "${SEED_MODE}" == "review" ]]; then
      say "verify: seeded=${VERIFY_SEED_COUNT} topLevelJobId=${VERIFY_TOPLEVEL_JOBID_COUNT} job1=${VERIFY_JOB1_COUNT} job2=${VERIFY_JOB2_COUNT} unknown=${VERIFY_UNKNOWN_COUNT}"
    fi
  fi

  if [[ "${VERIFY_SEED_COUNT}" -ne 5 ]]; then
    dump_seed_verify_debug "${verify_code}"
    fail "seeded mapping verify failed: expected 5 seeded docs, got ${VERIFY_SEED_COUNT}"
  fi
  if [[ "${VERIFY_TOPLEVEL_JOBID_COUNT}" -ne 5 ]]; then
    dump_seed_verify_debug "${verify_code}"
    fail "seeded mapping verify failed: expected top-level jobId on 5 docs, got ${VERIFY_TOPLEVEL_JOBID_COUNT}"
  fi
  if [[ "${VERIFY_JOB1_COUNT}" -lt 2 ]]; then
    dump_seed_verify_debug "${verify_code}"
    fail "seeded mapping verify failed: job_demo_001 linked evidence count=${VERIFY_JOB1_COUNT}, expected >=2"
  fi
  if [[ "${VERIFY_JOB2_COUNT}" -lt 2 ]]; then
    dump_seed_verify_debug "${verify_code}"
    fail "seeded mapping verify failed: job_demo_002 linked evidence count=${VERIFY_JOB2_COUNT}, expected >=2"
  fi
  if [[ "${VERIFY_UNKNOWN_COUNT}" -ne 0 ]]; then
    dump_seed_verify_debug "${verify_code}"
    fail "seeded mapping verify failed: unknown/unassigned evidence count=${VERIFY_UNKNOWN_COUNT}, expected 0"
  fi
}

upload_demo_file_via_proxy() {
  local storage_path="$1"
  local content_type="$2"
  local original_name="$3"
  local tmp_file="$4"
  local code
  code="$(
    curl -sS -o /tmp/peakops_seed_upload_proxy.out -w '%{http_code}' \
      -X POST "${FN_BASE}/uploadEvidenceProxyV1" \
      -F "orgId=${ORG_ID}" \
      -F "incidentId=${INCIDENT_ID}" \
      -F "sessionId=${SESSION_ID}" \
      -F "storagePath=${storage_path}" \
      -F "bucket=${BUCKET}" \
      -F "contentType=${content_type}" \
      -F "originalName=${original_name}" \
      -F "file=@${tmp_file};type=${content_type};filename=${original_name}" || true
  )"
  if [[ "${code}" -lt 200 || "${code}" -gt 299 ]]; then
    tail -c 240 /tmp/peakops_seed_upload_proxy.out 2>/dev/null || true
    fail "uploadEvidenceProxyV1 failed (${code}) for ${original_name}"
  fi
  local out_bucket out_path
  local out_ok out_err
  out_ok="$(jq -r '.ok // false' /tmp/peakops_seed_upload_proxy.out 2>/dev/null || echo false)"
  out_err="$(jq -r '.error // ""' /tmp/peakops_seed_upload_proxy.out 2>/dev/null || echo "")"
  if [[ "${out_ok}" != "true" ]]; then
    cat /tmp/peakops_seed_upload_proxy.out 2>/dev/null || true
    fail "uploadEvidenceProxyV1 returned ok!=true for ${original_name} error=${out_err}"
  fi
  out_bucket="$(jq -r '.bucket // ""' /tmp/peakops_seed_upload_proxy.out 2>/dev/null || true)"
  out_path="$(jq -r '.storagePath // ""' /tmp/peakops_seed_upload_proxy.out 2>/dev/null || true)"
  if [[ -z "${out_bucket}" || -z "${out_path}" ]]; then
    cat /tmp/peakops_seed_upload_proxy.out 2>/dev/null || true
    fail "uploadEvidenceProxyV1 missing bucket/storagePath for ${original_name}"
  fi
  if [[ "${out_bucket}" != "${BUCKET}" || "${out_path}" != "${storage_path}" ]]; then
    cat /tmp/peakops_seed_upload_proxy.out 2>/dev/null || true
    fail "uploadEvidenceProxyV1 drift for ${original_name}: expected bucket=${BUCKET} path=${storage_path}, got bucket=${out_bucket} path=${out_path}"
  fi
}

verify_object_readable_and_magic() {
  local evidence_id="$1"
  local storage_path="$2"
  local content_type="$3"
  local expected_magic="$4"
  local min_size="$5"
  local read_code read_url head_code got_magic magic_len read_bytes body_file body_size first16

  read_code="$(
    curl -sS -o /tmp/peakops_seed_read_url.out -w '%{http_code}' \
      -X POST "${FN_BASE}/createEvidenceReadUrlV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"bucket\":\"${BUCKET}\",\"storagePath\":\"${storage_path}\",\"expiresSec\":120}" || true
  )"
  if [[ "${read_code}" -lt 200 || "${read_code}" -gt 299 ]]; then
    cat /tmp/peakops_seed_read_url.out 2>/dev/null || true
    fail_verify "createEvidenceReadUrlV1 failed (${read_code}) evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path}"
  fi
  read_url="$(jq -r '.url // ""' /tmp/peakops_seed_read_url.out)"
  if [[ -z "${read_url}" ]]; then
    cat /tmp/peakops_seed_read_url.out
    fail_verify "createEvidenceReadUrlV1 returned no url evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path}"
  fi

  head_code="$(curl -sS -I -o /dev/null -w '%{http_code}' "${read_url}" || true)"
  if [[ "${head_code}" -lt 200 || "${head_code}" -gt 399 ]]; then
    fail_verify "signed URL HEAD failed (${head_code}) evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path}"
  fi

  body_file="$(mktemp /tmp/peakops_seed_body.XXXXXX)"
  if ! curl -sS -L "${read_url}" -o "${body_file}"; then
    rm -f "${body_file}"
    fail_verify "signed URL GET failed evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path}"
  fi
  body_size="$(wc -c < "${body_file}" | tr -d ' ')"

  if [[ "${body_size}" -lt "${min_size}" ]]; then
    rm -f "${body_file}"
    fail_verify "size check failed evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path} contentType=${content_type} size=${body_size} minSize=${min_size}"
  fi

  magic_len="${#expected_magic}"
  read_bytes=$((magic_len / 2))
  got_magic="$(hex_prefix "${body_file}" "${read_bytes}" | cut -c1-"${magic_len}")"
  first16="$(hex_prefix "${body_file}" 16)"
  if command -v sips >/dev/null 2>&1; then
    if ! sips -g pixelWidth -g pixelHeight "${body_file}" >/tmp/peakops_seed_sips.out 2>&1; then
      cat /tmp/peakops_seed_sips.out 2>/dev/null || true
      rm -f "${body_file}"
      fail_verify "decode check failed evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path} contentType=${content_type} first16=${first16}"
    fi
  fi
  rm -f "${body_file}"
  if [[ "$(lower "${got_magic}")" != "$(lower "${expected_magic}")" ]]; then
    fail_verify "magic mismatch evidenceId=${evidence_id} bucket=${BUCKET} storagePath=${storage_path} expected=${expected_magic} got=${got_magic} first16=${first16} contentType=${content_type} size=${body_size}"
  fi
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
    --arg sessionId "${SESSION_ID}" \
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
say "Seeding org directory docs for assign-org dropdown"
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

incident_fields="$(jq -n \
  --arg orgId "${ORG_ID}" \
  --arg incidentId "${INCIDENT_ID}" \
  --arg nowTs "${NOW_TS}" \
  '{
    orgId: {stringValue: $orgId},
    incidentId: {stringValue: $incidentId},
    title: {stringValue: "Demo Incident (Seeded)"},
    status: {stringValue: "open"},
    notesSummary: {
      mapValue: {
        fields: {
          saved: {booleanValue: true},
          savedAt: {timestampValue: $nowTs},
          text: {stringValue: "Seeded notes summary"}
        }
      }
    },
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}" "${incident_fields}"

say "Seeding demo jobs for ${INCIDENT_ID}"
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
    title: {stringValue: "Replace conductor"},
    status: {stringValue: "in_progress"},
    notes: {stringValue: "Seeded demo job"},
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
    title: {stringValue: "Inspect pole base"},
    status: {stringValue: "open"},
    notes: {stringValue: "Seeded demo job"},
    createdAt: {timestampValue: $nowTs},
    updatedAt: {timestampValue: $nowTs}
  }')"
patch_doc "incidents/${INCIDENT_ID}/jobs/job_demo_002" "${job_002_fields}"
say "[seed-demo] assigned job_demo_002 assignedOrgId=metro-lineworks (job org remains ${ORG_ID})"

say "[seed-demo] assigned job_demo_001 assignedOrgId=northgrid-services (job org remains ${ORG_ID})"

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
  "IMG_4344_2.HEIC"
  "pole_damage_wide.jpg"
  "meter_panel.png"
  "conductor_close.jpg"
  "site_overview.png"
)

CONV_STATUS=(
  "n/a"
  "n/a"
  "n/a"
  "n/a"
  "n/a"
)
SEEDED_PATHS=()

for i in "${!EVIDENCE_IDS[@]}"; do
  eid="${EVIDENCE_IDS[$i]}"
  ct="${CONTENT_TYPES[$i]}"
  oname="${ORIGINAL_NAMES[$i]}"
  cstatus="${CONV_STATUS[$i]}"
  sp="orgs/${ORG_ID}/incidents/${INCIDENT_ID}/uploads/${SESSION_ID}/${RUN_ID}__${oname}"
  SEEDED_PATHS[$i]="${sp}"
  fields="$(mk_evidence_fields "${eid}" "${ct}" "${oname}" "${sp}" "${cstatus}")"
  patch_doc "incidents/${INCIDENT_ID}/evidence_locker/${eid}" "${fields}"
done

if ! lsof -nP -iTCP:"${FN_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Functions emulator is not listening on ${FN_PORT}. Start emulators first: firebase emulators:start --project ${PROJECT_ID} --config firebase.json --only functions,firestore,ui"
fi

say "Backfilling canonical evidence job links"
BACKFILL_CODE=""
BACKFILL_BODY_PREVIEW=""
BACKFILL_ENDPOINT_USED=""
for BACKFILL_ENDPOINT in "backfillEvidenceJobIdV1" "backfillEvidenceJobIDV1"; do
  BACKFILL_CODE="$(
    curl -sS -o /tmp/peakops_seed_backfill_jobs.out -w '%{http_code}' \
      -X POST "${FN_BASE}/${BACKFILL_ENDPOINT}" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"dryRun\":false}" || true
  )"
  BACKFILL_BODY_PREVIEW="$(head -c 400 /tmp/peakops_seed_backfill_jobs.out 2>/dev/null || true)"
  say "${BACKFILL_ENDPOINT} http=${BACKFILL_CODE} body=${BACKFILL_BODY_PREVIEW}"
  if [[ "${BACKFILL_CODE}" -ge 200 && "${BACKFILL_CODE}" -le 299 ]]; then
    BACKFILL_ENDPOINT_USED="${BACKFILL_ENDPOINT}"
    break
  fi
  if [[ "${BACKFILL_CODE}" != "404" ]]; then
    break
  fi
done
if [[ -n "${BACKFILL_ENDPOINT_USED}" ]]; then
  say "backfill endpoint used: ${BACKFILL_ENDPOINT_USED}"
else
  fail "backfill endpoint failed http=${BACKFILL_CODE} body=${BACKFILL_BODY_PREVIEW}"
fi

say "Assigning seeded evidence to seeded jobs"
for pair in \
  "ev_demo_png_001:job_demo_001" \
  "ev_demo_jpg_001:job_demo_001" \
  "ev_demo_png_002:job_demo_002" \
  "ev_demo_jpg_002:job_demo_002" \
  "ev_demo_heic_001:job_demo_002"
do
  seeded_evidence_id="${pair%%:*}"
  target_job_id="${pair##*:}"
  ASSIGN_CODE="$(
    curl -sS -o /tmp/peakops_seed_assign_job.out -w '%{http_code}' \
      -X POST "${FN_BASE}/assignEvidenceToJobV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"evidenceId\":\"${seeded_evidence_id}\",\"jobId\":\"${target_job_id}\"}" || true
  )"
  if [[ "${ASSIGN_CODE}" -lt 200 || "${ASSIGN_CODE}" -gt 299 ]]; then
    cat /tmp/peakops_seed_assign_job.out 2>/dev/null || true
    fail "assignEvidenceToJobV1 failed (${ASSIGN_CODE}) evidenceId=${seeded_evidence_id} jobId=${target_job_id}"
  fi
  if ! jq -e '.ok == true' /tmp/peakops_seed_assign_job.out >/dev/null 2>&1; then
    cat /tmp/peakops_seed_assign_job.out 2>/dev/null || true
    fail "assignEvidenceToJobV1 returned ok!=true evidenceId=${seeded_evidence_id} jobId=${target_job_id}"
  fi
  say "linked ${seeded_evidence_id} -> ${target_job_id}"
done

if [[ "${SEED_MODE}" == "review" ]]; then
  say "SEED_MODE=review: enforcing canonical top-level jobId on all seeded evidence"
  for pair in \
    "ev_demo_png_001:job_demo_001" \
    "ev_demo_jpg_001:job_demo_001" \
    "ev_demo_png_002:job_demo_002" \
    "ev_demo_jpg_002:job_demo_002" \
    "ev_demo_heic_001:job_demo_002"
  do
    seeded_evidence_id="${pair%%:*}"
    target_job_id="${pair##*:}"
    patch_top_level_jobid_only "incidents/${INCIDENT_ID}/evidence_locker/${seeded_evidence_id}" "${target_job_id}"
  done
fi

say "Canonicalizing jobId on all seeded evidence docs (top-level + nested)"
EVID_REST_CODE="$(
  curl -sS -o /tmp/peakops_seed_evidence_docs_rest.json -w '%{http_code}' \
    "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=200" || true
)"
if [[ "${EVID_REST_CODE}" -lt 200 || "${EVID_REST_CODE}" -gt 299 ]]; then
  cat /tmp/peakops_seed_evidence_docs_rest.json 2>/dev/null || true
  fail "evidence_locker rest fetch failed (${EVID_REST_CODE}) for canonicalization"
fi
while IFS=$'\t' read -r doc_id resolved_job; do
  [[ -z "${doc_id}" ]] && continue
  if [[ -z "${resolved_job}" ]]; then
    say "canonicalize skip ${doc_id} (no resolvable jobId)"
    continue
  fi
  patch_jobid_both "incidents/${INCIDENT_ID}/evidence_locker/${doc_id}" "${resolved_job}"
  say "canonicalize jobId ${doc_id} -> ${resolved_job}"
done < <(
  jq -r '
    .documents[]? as $d |
    ($d.name | split("/") | last) as $id |
    (
      $d.fields.jobId.stringValue //
      $d.fields.evidence.mapValue.fields.jobId.stringValue //
      $d.fields["evidence.jobId"].stringValue //
      $d.fields.job.mapValue.fields.jobId.stringValue //
      ""
    ) as $jid |
    [$id, $jid] | @tsv
  ' /tmp/peakops_seed_evidence_docs_rest.json
)

say "Verifying/canonicalizing seeded job assignments before status transitions"
assert_seeded_job_links_clean_or_fix

say "Uploading valid 1x1 PNG/JPG demo objects via uploadEvidenceProxyV1"
say "Uploading demo asset files via uploadEvidenceProxyV1"
SITE_OVERVIEW_FILE="${ASSET_DIR}/site_overview.png"
METER_PANEL_FILE="${ASSET_DIR}/meter_panel.png"
CONDUCTOR_CLOSE_FILE="${ASSET_DIR}/conductor_close.jpg"
POLE_DAMAGE_FILE="${ASSET_DIR}/pole_damage_wide.jpg"
TMP_HEIC=""
trap 'rm -f "${TMP_HEIC}" /tmp/peakops_seed_upload_proxy.out' EXIT

for required_asset in "${SITE_OVERVIEW_FILE}" "${METER_PANEL_FILE}" "${CONDUCTOR_CLOSE_FILE}" "${POLE_DAMAGE_FILE}"; do
  [[ -f "${required_asset}" ]] || fail "missing demo asset file: ${required_asset}"
done

for i in "${!EVIDENCE_IDS[@]}"; do
  ct="${CONTENT_TYPES[$i]}"
  oname="${ORIGINAL_NAMES[$i]}"
  eid="${EVIDENCE_IDS[$i]}"
  [[ "${ct}" == "image/heic" ]] && continue
  sp="${SEEDED_PATHS[$i]}"
  asset_file=""
  case "${oname}" in
    "site_overview.png") asset_file="${SITE_OVERVIEW_FILE}" ;;
    "meter_panel.png") asset_file="${METER_PANEL_FILE}" ;;
    "conductor_close.jpg") asset_file="${CONDUCTOR_CLOSE_FILE}" ;;
    "pole_damage_wide.jpg") asset_file="${POLE_DAMAGE_FILE}" ;;
    *) fail "no demo asset mapping for ${oname}" ;;
  esac
  if [[ "${ct}" == "image/png" ]]; then
    upload_demo_file_via_proxy "${sp}" "${ct}" "${oname}" "${asset_file}"
    verify_object_readable_and_magic "${eid}" "${sp}" "${ct}" "89504e470d0a1a0a" 67
  else
    upload_demo_file_via_proxy "${sp}" "${ct}" "${oname}" "${asset_file}"
    verify_object_readable_and_magic "${eid}" "${sp}" "${ct}" "ffd8ff" 200
  fi
done

say "Verification pass: checking signed-read magic for seeded PNG/JPG docs"
for i in "${!EVIDENCE_IDS[@]}"; do
  ct="${CONTENT_TYPES[$i]}"
  eid="${EVIDENCE_IDS[$i]}"
  sp="${SEEDED_PATHS[$i]}"
  [[ "${ct}" == "image/heic" ]] && continue
  if [[ "${ct}" == "image/png" ]]; then
    verify_object_readable_and_magic "${eid}" "${sp}" "${ct}" "89504e470d0a1a0a" 67
  else
    verify_object_readable_and_magic "${eid}" "${sp}" "${ct}" "ffd8ff" 200
  fi
done

HAVE_HEIC_SAMPLE="0"
if [[ -z "${HEIC_SAMPLE_FILE}" && -f "${ASSET_DIR}/demo_sample.HEIC" ]]; then
  HEIC_SAMPLE_FILE="${ASSET_DIR}/demo_sample.HEIC"
fi
if [[ -n "${HEIC_SAMPLE_FILE}" && -f "${HEIC_SAMPLE_FILE}" ]]; then
  HAVE_HEIC_SAMPLE="1"
elif [[ -n "${HEIC_SAMPLE_FILE}" ]]; then
  warn "HEIC_SAMPLE_FILE set but missing: ${HEIC_SAMPLE_FILE} (continuing with conversionStatus=n/a)"
fi

if [[ "${STORAGE_EMULATOR_UP}" != "1" ]]; then
  say "Storage emulator not running; skipping HEIC upload/conversion"
elif [[ "${HAVE_HEIC_SAMPLE}" == "1" ]]; then
  TMP_HEIC="$(mktemp /tmp/peakops_seed_heic.XXXXXX.HEIC)"
  cp "${HEIC_SAMPLE_FILE}" "${TMP_HEIC}"
  heic_sp="${SEEDED_PATHS[0]}"
  say "Uploading real HEIC sample and queueing conversion job"
  upload_demo_file_via_proxy "${heic_sp}" "image/heic" "IMG_4344_2.HEIC" "${TMP_HEIC}"
  heic_fields="$(mk_evidence_fields "ev_demo_heic_001" "image/heic" "IMG_4344_2.HEIC" "${heic_sp}" "pending")"
  patch_doc "incidents/${INCIDENT_ID}/evidence_locker/ev_demo_heic_001" "${heic_fields}"

  job_fields="$(jq -n \
    --arg orgId "${ORG_ID}" \
    --arg incidentId "${INCIDENT_ID}" \
    --arg evidenceId "ev_demo_heic_001" \
    --arg bucket "${BUCKET}" \
    --arg storagePath "${heic_sp}" \
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
  say "Queued deterministic conversion job: incidents/${INCIDENT_ID}/conversion_jobs/ev_demo_heic_001"

  convert_code="$(
    curl -sS -o /tmp/peakops_seed_convert_heic.out -w '%{http_code}' \
      -X POST "${FN_BASE}/convertEvidenceHeicNowV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"evidenceId\":\"ev_demo_heic_001\",\"storagePath\":\"${heic_sp}\"}" || true
  )"
  if [[ "${convert_code}" -lt 200 || "${convert_code}" -gt 299 ]]; then
    tail -c 320 /tmp/peakops_seed_convert_heic.out 2>/dev/null || true
    fail "convertEvidenceHeicNowV1 returned ${convert_code} for HEIC sample"
  fi
  if ! jq -e '.ok == true' /tmp/peakops_seed_convert_heic.out >/dev/null 2>&1; then
    tail -c 480 /tmp/peakops_seed_convert_heic.out 2>/dev/null || true
    fail "convertEvidenceHeicNowV1 returned ok!=true for HEIC sample"
  fi

  verify_code="$(
    curl -sS -o /tmp/peakops_seed_verify_heic.json -w '%{http_code}' \
      "${FN_BASE}/listEvidenceLocker?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=100" || true
  )"
  if [[ "${verify_code}" -lt 200 || "${verify_code}" -gt 299 ]]; then
    cat /tmp/peakops_seed_verify_heic.json 2>/dev/null || true
    fail "listEvidenceLocker verify failed (${verify_code}) after HEIC conversion run"
  fi
  if ! jq -e '.docs[]? | select(.id=="ev_demo_heic_001") | select(((.file.previewPath // "") | length) > 0 and ((.file.thumbPath // "") | length) > 0)' /tmp/peakops_seed_verify_heic.json >/dev/null 2>&1; then
    cat /tmp/peakops_seed_verify_heic.json
    fail "HEIC sample conversion did not populate previewPath/thumbPath"
  fi
else
  say "No usable HEIC sample provided; HEIC doc is metadata-only with conversionStatus=n/a (deterministic)."
fi

say "Post-upload jobId enforcement (demo hardening, idempotent)"
for pair in \
  "ev_demo_png_001:job_demo_001" \
  "ev_demo_jpg_001:job_demo_001" \
  "ev_demo_png_002:job_demo_002" \
  "ev_demo_jpg_002:job_demo_002" \
  "ev_demo_heic_001:job_demo_002"
do
  seeded_evidence_id="${pair%%:*}"
  target_job_id="${pair##*:}"
  ENFORCE_CODE="$(
    curl -sS -o /tmp/peakops_seed_enforce_jobid.out -w '%{http_code}' \
      -X POST "${FN_BASE}/assignEvidenceToJobV1" \
      -H 'content-type: application/json' \
      -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"evidenceId\":\"${seeded_evidence_id}\",\"jobId\":\"${target_job_id}\"}" || true
  )"
  if [[ "${ENFORCE_CODE}" -lt 200 || "${ENFORCE_CODE}" -gt 299 ]]; then
    cat /tmp/peakops_seed_enforce_jobid.out 2>/dev/null || true
    fail "post-upload assignEvidenceToJobV1 failed (${ENFORCE_CODE}) evidenceId=${seeded_evidence_id} jobId=${target_job_id}"
  fi
  if ! jq -e '.ok == true' /tmp/peakops_seed_enforce_jobid.out >/dev/null 2>&1; then
    cat /tmp/peakops_seed_enforce_jobid.out 2>/dev/null || true
    fail "post-upload assignEvidenceToJobV1 returned ok!=true evidenceId=${seeded_evidence_id} jobId=${target_job_id}"
  fi
done

HEIC_DOC_CODE="$(
  curl -sS -o /tmp/peakops_seed_verify_heic_jobid.json -w '%{http_code}' \
    "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker/ev_demo_heic_001" || true
)"
if [[ "${HEIC_DOC_CODE}" -lt 200 || "${HEIC_DOC_CODE}" -gt 299 ]]; then
  cat /tmp/peakops_seed_verify_heic_jobid.json 2>/dev/null || true
  say "WARN: HEIC jobId verify fetch failed http=${HEIC_DOC_CODE} (continuing)"
else
  HEIC_TOP_JOBID="$(jq -r '.fields.jobId.stringValue // ""' /tmp/peakops_seed_verify_heic_jobid.json 2>/dev/null || echo "")"
  HEIC_NESTED_JOBID="$(jq -r '.fields.evidence.mapValue.fields.jobId.stringValue // ""' /tmp/peakops_seed_verify_heic_jobid.json 2>/dev/null || echo "")"
  say "verified HEIC jobId top='${HEIC_TOP_JOBID}' nested='${HEIC_NESTED_JOBID}'"
fi

say "Re-checking seeded evidence mapping after uploads/conversion"
assert_seeded_job_links_clean_or_fix

if [[ "${SEED_MODE}" == "review" ]]; then
  say "SEED_MODE=review: marking both demo jobs complete only after mapping is clean"
  for complete_job_id in job_demo_001 job_demo_002; do
    COMPLETE_CODE="$(
      curl -sS -o /tmp/peakops_seed_mark_complete.out -w '%{http_code}' \
        -X POST "${FN_BASE}/updateJobStatusV1" \
        -H 'content-type: application/json' \
        -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"jobId\":\"${complete_job_id}\",\"status\":\"complete\",\"updatedBy\":\"seed_demo_incident\"}" || true
    )"
    if [[ "${COMPLETE_CODE}" -lt 200 || "${COMPLETE_CODE}" -gt 299 ]]; then
      cat /tmp/peakops_seed_mark_complete.out 2>/dev/null || true
      fail "updateJobStatusV1 failed (${COMPLETE_CODE}) for ${complete_job_id} -> complete"
    fi
    if ! jq -e '.ok == true' /tmp/peakops_seed_mark_complete.out >/dev/null 2>&1; then
      cat /tmp/peakops_seed_mark_complete.out 2>/dev/null || true
      fail "updateJobStatusV1 returned unexpected body for ${complete_job_id} completion"
    fi
    say "${complete_job_id} marked complete via updateJobStatusV1"
  done
else
  say "SEED_MODE=interactive: leaving job statuses as seeded (job_demo_001=in_progress, job_demo_002=open)"
fi

say "Final verification via Firestore REST"
EVID_CODE="$(
  curl -sS -o /tmp/peakops_seed_verify_evidence_rest.json -w '%{http_code}' \
    "${FS_BASE}/incidents/${INCIDENT_ID}/evidence_locker?pageSize=200" || true
)"
if [[ "${EVID_CODE}" -lt 200 || "${EVID_CODE}" -gt 299 ]]; then
  cat /tmp/peakops_seed_verify_evidence_rest.json 2>/dev/null || true
  fail "evidence verify failed http=${EVID_CODE} incident=${INCIDENT_ID}"
fi

EVID_COUNT="$(jq -r '(.documents // []) | length' /tmp/peakops_seed_verify_evidence_rest.json 2>/dev/null || echo 0)"
say "verify counts incident=1 evidence=${EVID_COUNT}"
if [[ "${EVID_COUNT}" -lt 1 ]]; then
  fail "seed completed but evidence count is ${EVID_COUNT} for incident=${INCIDENT_ID}"
fi

EVID_WITH_JOB_REST="$(jq -r '[.documents[]? | select(((.fields.jobId.stringValue // "") | length) > 0 or ((.fields.evidence.mapValue.fields.jobId.stringValue // "") | length) > 0)] | length' /tmp/peakops_seed_verify_evidence_rest.json 2>/dev/null || echo 0)"
TOP_LEVEL_JOBID_REST="$(jq -r '[.documents[]? | select(((.fields.jobId.stringValue // "") | length) > 0)] | length' /tmp/peakops_seed_verify_evidence_rest.json 2>/dev/null || echo 0)"
UNKNOWN_REST="$(jq -r '[.documents[]? | select((((.fields.jobId.stringValue // .fields.evidence.mapValue.fields.jobId.stringValue // "") | length) == 0)] | length' /tmp/peakops_seed_verify_evidence_rest.json 2>/dev/null || echo 0)"

if [[ "${EVID_WITH_JOB_REST}" -lt 4 ]]; then
  fail "mapping verify failed via Firestore REST: evidence_with_job=${EVID_WITH_JOB_REST}, expected >=4"
fi
if [[ "${SEED_MODE}" == "review" && "${TOP_LEVEL_JOBID_REST}" -ne 5 ]]; then
  fail "SEED_MODE=review requires top-level jobId for all 5 evidence docs; got ${TOP_LEVEL_JOBID_REST}"
fi
if [[ "${UNKNOWN_REST}" -gt 0 ]]; then
  fail "mapping verify failed via Firestore REST: unknown=${UNKNOWN_REST}, expected 0"
fi

JOB2_EVID_REST="$(jq -r '[.documents[]? | select((.fields.jobId.stringValue // .fields.evidence.mapValue.fields.jobId.stringValue // "") == "job_demo_002")] | length' /tmp/peakops_seed_verify_evidence_rest.json 2>/dev/null || echo 0)"
if [[ "${JOB2_EVID_REST}" -lt 2 ]]; then
  fail "mapping verify failed via Firestore REST: job_demo_002 evidence=${JOB2_EVID_REST}, expected >=2"
fi
say "verified Firestore REST mapping: evidence_with_job=${EVID_WITH_JOB_REST}, topLevelJobId=${TOP_LEVEL_JOBID_REST}, unknown=${UNKNOWN_REST}, job_demo_002=${JOB2_EVID_REST}"

JOBS_VERIFY_CODE="$(
  curl -sS -o /tmp/peakops_seed_verify_jobs_rest.json -w '%{http_code}' \
    "${FS_BASE}/incidents/${INCIDENT_ID}/jobs?pageSize=50" || true
)"
if [[ "${JOBS_VERIFY_CODE}" -lt 200 || "${JOBS_VERIFY_CODE}" -gt 299 ]]; then
  cat /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null || true
  fail "jobs verify failed http=${JOBS_VERIFY_CODE} incident=${INCIDENT_ID}"
fi

JOB1_STATUS_REST="$(jq -r '.documents[]? | select((.name // "") | endswith("/job_demo_001")) | .fields.status.stringValue // ""' /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null | head -n1)"
JOB2_STATUS_REST="$(jq -r '.documents[]? | select((.name // "") | endswith("/job_demo_002")) | .fields.status.stringValue // ""' /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null | head -n1)"

if [[ "${SEED_MODE}" == "review" ]]; then
  if [[ "$(lower "${JOB1_STATUS_REST}")" != "complete" ]]; then
    cat /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null || true
    fail "job_demo_001 status verify failed: expected complete, got '${JOB1_STATUS_REST}'"
  fi
  if [[ "$(lower "${JOB2_STATUS_REST}")" != "complete" ]]; then
    cat /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null || true
    fail "job_demo_002 status verify failed: expected complete, got '${JOB2_STATUS_REST}'"
  fi
  say "verified job_demo_001/job_demo_002 status=complete via Firestore REST"
else
  if [[ "$(lower "${JOB1_STATUS_REST}")" != "in_progress" ]]; then
    cat /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null || true
    fail "job_demo_001 status verify failed: expected in_progress, got '${JOB1_STATUS_REST}'"
  fi
  if [[ "$(lower "${JOB2_STATUS_REST}")" != "open" ]]; then
    cat /tmp/peakops_seed_verify_jobs_rest.json 2>/dev/null || true
    fail "job_demo_002 status verify failed: expected open, got '${JOB2_STATUS_REST}'"
  fi
  say "verified job_demo_001=in_progress and job_demo_002=open via Firestore REST"
fi

say "Verifying listJobsV1 post-seed status snapshot"
LIST_JOBS_CODE="$(
  curl -sS -o /tmp/peakops_seed_verify_listjobs.json -w '%{http_code}' \
    "${FN_BASE}/listJobsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=20" || true
)"
if [[ "${LIST_JOBS_CODE}" -lt 200 || "${LIST_JOBS_CODE}" -gt 299 ]]; then
  cat /tmp/peakops_seed_verify_listjobs.json 2>/dev/null || true
  fail "listJobsV1 verify failed http=${LIST_JOBS_CODE}"
fi

LIST_COMPLETE_COUNT="$(jq -r '[.docs[]? | select(((.status // "") | ascii_downcase) == "complete")] | length' /tmp/peakops_seed_verify_listjobs.json 2>/dev/null || echo 0)"
LIST_OPENISH_COUNT="$(jq -r '[.docs[]? | select(((.status // "") | ascii_downcase) == "open" or ((.status // "") | ascii_downcase) == "in_progress" or ((.status // "") | ascii_downcase) == "assigned")] | length' /tmp/peakops_seed_verify_listjobs.json 2>/dev/null || echo 0)"

if [[ "${SEED_MODE}" == "review" ]]; then
  if [[ "${LIST_COMPLETE_COUNT}" -lt 2 ]]; then
    cat /tmp/peakops_seed_verify_listjobs.json 2>/dev/null || true
    fail "listJobsV1 verify failed: expected >=2 complete jobs, got ${LIST_COMPLETE_COUNT}"
  fi
  say "verified listJobsV1 complete_count=${LIST_COMPLETE_COUNT}"
else
  if [[ "${LIST_OPENISH_COUNT}" -lt 2 ]]; then
    cat /tmp/peakops_seed_verify_listjobs.json 2>/dev/null || true
    fail "listJobsV1 verify failed: expected >=2 open/in_progress/assigned jobs, got ${LIST_OPENISH_COUNT}"
  fi
  say "verified listJobsV1 active_count=${LIST_OPENISH_COUNT}"
fi

say "SUCCESS runId=${RUN_ID} sessionId=${SESSION_ID} incident=${INCIDENT_ID} org=${ORG_ID}"
for i in "${!EVIDENCE_IDS[@]}"; do
  say "path evidenceId=${EVIDENCE_IDS[$i]} contentType=${CONTENT_TYPES[$i]} storagePath=${SEEDED_PATHS[$i]}"
done
