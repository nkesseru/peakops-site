#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PATTERN='BEGIN PRIVATE KEY|"private_key"|\"private_key\"'

echo "[secret-scan] scanning repo for private key markers..."
HITS="$(rg -n --hidden -a \
  --glob '!node_modules/**' \
  --glob '!.git/**' \
  --glob '!archive/local-only/**' \
  --glob '!.githooks/pre-commit' \
  --glob '!scripts/dev/secret_scan.sh' \
  --glob '!scripts/migrations/2025-09-03-init.js' \
  "${PATTERN}" . || true)"

if [[ -n "$HITS" ]]; then
  echo "[secret-scan] FOUND potential secrets:"
  echo "$HITS"
  exit 2
fi

echo "[secret-scan] clean"
