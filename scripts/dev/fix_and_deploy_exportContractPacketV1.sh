#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

echo "==> (1) Ensure functions_clean has Functions Framework (pnpm requirement)"
cd functions_clean

# must be in deps (not optional)
pnpm add @google-cloud/functions-framework

# sanity: show it exists in deps
node -e "const p=require('./package.json'); console.log('functions-framework dep:', !!(p.dependencies && p.dependencies['@google-cloud/functions-framework']))"

cd ..

echo "==> (2) Deploy only exportContractPacketV1"
firebase deploy --only functions:exportContractPacketV1

echo "✅ deploy done"
