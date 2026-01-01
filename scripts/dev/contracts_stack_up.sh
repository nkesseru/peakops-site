#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app
bash scripts/dev/contracts_stack_up_fixed.sh "${1:-car_abc123}" "${2:-cust_acme_001}" "${3:-v1}"
