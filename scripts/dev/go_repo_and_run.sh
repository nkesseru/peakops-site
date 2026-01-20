#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

SCRIPT="${1:-}"
shift || true

if [[ -z "$SCRIPT" ]]; then
  echo "usage: scripts/dev/go_repo_and_run.sh <script_path> [args...]"
  exit 2
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "❌ script not found: $SCRIPT"
  exit 1
fi

chmod +x "$SCRIPT" 2>/dev/null || true
echo "▶ running from repo root: $ROOT"
bash "$SCRIPT" "$@"
