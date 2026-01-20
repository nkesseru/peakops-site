#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak

cp "next-app/src/app/admin/contracts/page.tsx" \
  "scripts/dev/_bak/contracts_list_${ts}.tsx" 2>/dev/null || true

cp "next-app/src/app/admin/contracts/[id]/page.tsx" \
  "scripts/dev/_bak/contracts_detail_${ts}.tsx" 2>/dev/null || true

cp "next-app/src/app/admin/contracts/[id]/payloads/page.tsx" \
  "scripts/dev/_bak/contracts_payloads_${ts}.tsx" 2>/dev/null || true

cp "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx" \
  "scripts/dev/_bak/payload_editor_${ts}.tsx" 2>/dev/null || true

cp "next-app/src/app/admin/contracts/[id]/packet/page.tsx" \
  "scripts/dev/_bak/packet_preview_${ts}.tsx" 2>/dev/null || true

echo "✅ snapshotted UI to scripts/dev/_bak/*_${ts}.tsx"
ls -la scripts/dev/_bak | tail -n 12
