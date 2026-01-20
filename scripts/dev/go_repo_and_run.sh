#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "❌ Not inside a git repo. cd into the repo first."
  exit 1
fi
cd "$ROOT"

SCRIPT="${1:-}"
shift || true
if [[ -z "${SCRIPT}" || ! -f "${SCRIPT}" ]]; then
  echo "❌ Script not found: ${SCRIPT}"
  exit 1
fi

chmod +x "${SCRIPT}" 2>/dev/null || true
echo "▶ running (bash) from repo root: $ROOT"
bash "${SCRIPT}" "$@"
