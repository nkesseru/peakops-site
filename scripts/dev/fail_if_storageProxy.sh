#!/usr/bin/env bash
set -euo pipefail
if rg -n "/api/storageProxy|storageProxy" next-app | rg -v "app/api/storageProxy/route\.ts"; then
  echo "❌ Found deprecated storageProxy usage. Remove it. (Only allowed file: next-app/app/api/storageProxy/route.ts)"
  exit 1
fi
echo "✅ No deprecated storageProxy usage found."
