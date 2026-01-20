#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
SCRIPT="$1"; shift || true
if [[ ! -f "$SCRIPT" ]]; then
  echo "❌ script not found: $SCRIPT"
  exit 1
fi
chmod +x "$SCRIPT" || true
echo "▶ running from repo root: $ROOT"
bash "$SCRIPT" "$@"
