#!/usr/bin/env bash
set -euo pipefail

require_bash() {
  if [[ -z "${BASH_VERSION:-}" ]]; then
    echo "[dev-lib] FAIL: run with bash, not zsh. Example: bash scripts/dev/demo_up.sh" >&2
    exit 1
  fi
}

repo_root() {
  local from="${1:-}"
  local root=""
  if command -v git >/dev/null 2>&1; then
    if [[ -n "${from}" ]]; then
      root="$(git -C "${from}" rev-parse --show-toplevel 2>/dev/null || true)"
    else
      root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    fi
  fi
  if [[ -z "${root}" ]]; then
    if [[ -n "${from}" ]]; then
      root="$(cd "${from}/../.." && pwd)"
    else
      root="$(pwd)"
    fi
  fi
  echo "${root}"
}

abs_path() {
  local root="$1"
  local p="$2"
  if [[ "${p}" = /* ]]; then
    echo "${p}"
  else
    echo "${root}/${p}"
  fi
}

say() {
  local tag="${1:-dev-lib}"
  shift || true
  echo "[${tag}] $*"
}

fail() {
  local tag="${1:-dev-lib}"
  shift || true
  echo "[${tag}] FAIL: $*" >&2
  exit 1
}

http_code() {
  local url="$1"
  curl -s -o /dev/null -w '%{http_code}' "${url}" || true
}

wait_port() {
  local port="$1"
  local timeout="${2:-60}"
  local i=0
  while (( i < timeout )); do
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

wait_http_200() {
  local url="$1"
  local timeout="${2:-60}"
  local i=0
  while (( i < timeout )); do
    local code
    code="$(http_code "${url}")"
    if [[ "${code}" == "200" ]]; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

kill_ports() {
  local ports=("$@")
  local p
  for p in "${ports[@]}"; do
    local pids
    pids="$(lsof -nP -iTCP:"${p}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
    if [[ -n "${pids}" ]]; then
      kill -9 ${pids} >/dev/null 2>&1 || true
    fi
  done
}

kill_emulators() {
  pkill -f "firebase emulators" >/dev/null 2>&1 || true
  pkill -f "firebase-tools" >/dev/null 2>&1 || true
  pkill -f "emulators:start" >/dev/null 2>&1 || true
  if command -v jps >/dev/null 2>&1; then
    jps -l 2>/dev/null | awk '/CloudFirestore|firestore/{print $1}' | while read -r pid; do
      [[ -n "${pid}" ]] || continue
      kill -9 "${pid}" >/dev/null 2>&1 || true
    done
  fi
}
