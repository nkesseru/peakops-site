#!/usr/bin/env bash
set -euo pipefail
# Prevent zsh history expansion issues when someone runs this via zsh
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
VERSION_ID="${4:-v1}"

cd "$(dirname "$0")/../.."  # repo root

echo "==> Canonical boot: using boot_dev_stack_v2.sh (single source of truth)"
echo "==> project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID version=$VERSION_ID"
echo

bash scripts/dev/boot_dev_stack_v2.sh "$PROJECT_ID" "$ORG_ID" "$CONTRACT_ID" "$VERSION_ID"
