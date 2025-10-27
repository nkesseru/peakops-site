#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/sign_post.sh <endpoint> '<json-payload>'
# Example:
#   ./scripts/sign_post.sh https://ingestemail-2omfo6m6ea-uc.a.run.app \
#   '{"ingestionId":"cli-test-auto","source":"email","vendor":"CLI","customerId":"cust_dev","serviceDate":"2025-09-23","status":"closed"}'

ENDPOINT="${1:-https://ingestemail-2omfo6m6ea-uc.a.run.app}"
PAYLOAD="${2:-{"ingestionId":"cli-test-auto","source":"email","vendor":"CLI","customerId":"cust_dev","serviceDate":"2025-09-23","status":"closed"}}"

# Pull the current secret from Firebase Secret Manager
SECRET="$(firebase functions:secrets:access ZAPIER_SIGNING_SECRET 2>/dev/null | tail -n1)"

# HMAC over the EXACT bytes we will POST
SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)"

# Use --data-binary so curl doesn’t add a newline or reformat the body
curl -s -i -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  -H "X-Signature: $SIG" \
  --data-binary "$PAYLOAD"

echo
