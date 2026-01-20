#!/usr/bin/env bash
set +H 2>/dev/null || true

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "❌ Run with: bash scripts/dev/boot_stable_incident_stack.sh ..."
  exit 1
fi

set -euo pipefail

# keepalive: don't let a child exit kill the script
set +e


PROJECT_ID="${1:?PROJECT_ID required}"
ORG_ID="${2:?ORG_ID required}"
INCIDENT_ID="${3:?INCIDENT_ID required}"
BASE_URL="${4:-http://127.0.0.1:3000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGDIR="${ROOT_DIR}/.logs"
PIDFILE="${LOGDIR}/pids_keepalive.txt"
mkdir -p "${LOGDIR}"
: > "${PIDFILE}"

echo "==> kill ports (clean slate)"
for PORT in 3000 5001 8080 8081 4000 4400 9150 9099; do
  if lsof -ti tcp:"${PORT}" >/dev/null 2>&1; then
    lsof -ti tcp:"${PORT}" | xargs -r kill -9 >/dev/null 2>&1 || true
  fi
done

echo "==> start emulators"
(
  cd "${ROOT_DIR}"
  firebase emulators:start --project "${PROJECT_ID}" > "${LOGDIR}/emulators.log" 2>&1
) &
EMU_PID=$!
echo "${EMU_PID}" >> "${PIDFILE}"
echo "EMU_PID=${EMU_PID}"

echo "==> wait for /hello"
HELLO_URL="http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello"
for i in {1..120}; do
  if curl -fsS "${HELLO_URL}" >/dev/null 2>&1; then
    echo "✅ emulators ready"
    break
  fi
  if ! kill -0 "${EMU_PID}" >/dev/null 2>&1; then
    echo "❌ emulators died"
    tail -n 200 "${LOGDIR}/emulators.log" || true
    exit 1
  fi
  sleep 1
done

echo "==> start Next"
(
  cd "${ROOT_DIR}/next-app"
  pnpm dev --port 3000 > "${LOGDIR}/next.log" 2>&1
) &
NEXT_PID=$!
echo "${NEXT_PID}" >> "${PIDFILE}"
echo "NEXT_PID=${NEXT_PID}"

echo "==> wait for Next /"
for i in {1..120}; do
  if curl -fsSI "${BASE_URL}" >/dev/null 2>&1; then
    echo "✅ next ready"
    break
  fi
  if ! kill -0 "${NEXT_PID}" >/dev/null 2>&1; then
    echo "❌ next died"
    tail -n 200 "${LOGDIR}/next.log" || true
    exit 1
  fi
  sleep 1
done

echo "==> seed incident baseline (Firestore REST)"
FIRESTORE_REST="http://127.0.0.1:8081"
DOC_PATH="projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}"
NOW_UTC="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

curl -sS -X PATCH \
  "${FIRESTORE_REST}/v1/${DOC_PATH}?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime&updateMask.fieldPaths=createdAt&updateMask.fieldPaths=updatedAt" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\":     {\"stringValue\": \"${ORG_ID}\"},
      \"title\":     {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"${NOW_UTC}\"},
      \"createdAt\": {\"timestampValue\": \"${NOW_UTC}\"},
      \"updatedAt\": {\"timestampValue\": \"${NOW_UTC}\"}
    }
  }" >/dev/null

echo "✅ incident seeded: incidents/${INCIDENT_ID}"

echo "==> seed timeline (POST /api/fn/generateTimelineV1)"
curl -sS -X POST "${BASE_URL}/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"requestedBy\":\"stable_keepalive\"}"
echo ""

echo "==> verify timeline reads (GET /api/fn/getTimelineEvents)"
curl -sS "${BASE_URL}/api/fn/getTimelineEvents?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&limit=50"
echo ""
echo "==> seed filings (POST /api/fn/generateFilingsV1)"
curl -sS -X POST "${BASE_URL}/api/fn/generateFilingsV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"requestedBy\":\"stable_keepalive\"}"
echo ""

echo "==> verify bundle (GET /api/fn/getIncidentBundleV1)"
curl -sS "${BASE_URL}/api/fn/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"
echo ""
echo
echo "✅ STACK UP (KEEPALIVE)"
echo "OPEN: ${BASE_URL}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "LOGS: tail -n 200 ${LOGDIR}/emulators.log"
echo "      tail -n 200 ${LOGDIR}/next.log"
echo "STOP: kill ${EMU_PID} ${NEXT_PID}"

wait
