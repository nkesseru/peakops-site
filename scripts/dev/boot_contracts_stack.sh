#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

# Always run from repo root
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

echo "==> Boot contracts stack (emu runner)"
echo "    contract=$CONTRACT_ID customer=$CUSTOMER_ID version=$VERSION_ID"
echo

# Prefer the stable wrapper if present
if [[ -x scripts/dev/contracts_stack_up.sh ]]; then
  exec bash scripts/dev/contracts_stack_up.sh "$CONTRACT_ID" "$CUSTOMER_ID" "$VERSION_ID"
fi

# Otherwise fall back to the fixed script (if present)
if [[ -x scripts/dev/contracts_stack_up_fixed.sh ]]; then
  exec bash scripts/dev/contracts_stack_up_fixed.sh "$CONTRACT_ID" "$CUSTOMER_ID" "$VERSION_ID"
fi

echo "❌ Could not find scripts/dev/contracts_stack_up.sh or contracts_stack_up_fixed.sh"
echo "   Run: ls -la scripts/dev | rg 'contracts_stack_up'"
exit 1
