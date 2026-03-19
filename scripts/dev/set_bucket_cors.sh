#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/functions_clean/.env"
FIREBASERC_FILE="${REPO_ROOT}/.firebaserc"
CORS_FILE="/tmp/cors-dev.json"

read_project_from_firebaserc() {
  if [[ -f "${FIREBASERC_FILE}" ]] && command -v jq >/dev/null 2>&1; then
    jq -r '.projects.pilot // .projects.Production // .projects.default // empty' "${FIREBASERC_FILE}" 2>/dev/null || true
  fi
}

resolve_bucket() {
  local bucket="${FIREBASE_STORAGE_BUCKET:-}"
  if [[ -n "${bucket}" ]]; then
    echo "${bucket}"
    return 0
  fi

  bucket="${STORAGE_BUCKET:-}"
  if [[ -n "${bucket}" ]]; then
    echo "${bucket}"
    return 0
  fi

  local project="${GCLOUD_PROJECT:-${FIREBASE_PROJECT_ID:-${PROJECT_ID:-}}}"
  if [[ -z "${project}" ]]; then
    project="$(read_project_from_firebaserc)"
  fi
  if [[ -z "${project}" ]]; then
    project="peakops-pilot"
  fi

  echo "${project}.firebasestorage.app"
}

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

BUCKET="$(resolve_bucket)"

cat > "${CORS_FILE}" <<'JSON'
[
  {
    "origin": [
      "http://127.0.0.1:3001",
      "http://localhost:3001"
    ],
    "method": ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
    "responseHeader": ["Content-Type", "x-goog-resumable", "x-goog-meta-*"],
    "maxAgeSeconds": 3600
  }
]
JSON

echo "Bucket: ${BUCKET}"
echo "CORS file: ${CORS_FILE}"

if command -v gcloud >/dev/null 2>&1; then
  echo "Applying CORS with gcloud storage..."
  gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}"
  echo "Done."
else
  cat <<EOF
gcloud CLI not found.
Run these commands manually after installing/authenticating gcloud:

cat > ${CORS_FILE} <<'JSON'
[
  {
    "origin": ["http://127.0.0.1:3001", "http://localhost:3001"],
    "method": ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
    "responseHeader": ["Content-Type", "x-goog-resumable", "x-goog-meta-*"],
    "maxAgeSeconds": 3600
  }
]
JSON
gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}"
EOF
fi

