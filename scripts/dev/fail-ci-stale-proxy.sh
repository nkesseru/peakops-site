#!/usr/bin/env bash
set -euo pipefail
SEARCH_DIR="next-app"
PATTERN="/api/storageProxy"

echo "[ci-gate] Checking for deprecated storageProxy usages in '$SEARCH_DIR'..."
if rg -n "$PATTERN" "$SEARCH_DIR"; then
  echo
  echo "❌ [ci-gate] FAIL: Found deprecated '$PATTERN' usages."
  echo "Use minted :9199 download URLs via createEvidenceReadUrlV1 instead."
  exit 1
else
  echo "✅ [ci-gate] OK: No deprecated proxy paths found."
fi
