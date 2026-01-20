#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

PROJECT_ID="$PROJECT_ID" ORG_ID="$ORG_ID" \
bash scripts/dev/mega_contracts_stack_seed_emulator.sh "$CONTRACT_ID" "$CUSTOMER_ID" "$VERSION_ID"
