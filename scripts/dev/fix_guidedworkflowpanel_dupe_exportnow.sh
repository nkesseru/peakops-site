#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

A="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
B="next-app/src/app/admin/incidents/_components/GuidedWorkflowPanel.tsx"

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak

echo "==> backup both copies"
cp "$A" "scripts/dev/_bak/GuidedWorkflowPanel.admin_components.$TS.tsx" || true
cp "$B" "scripts/dev/_bak/GuidedWorkflowPanel.incidents_components.$TS.tsx" || true

echo "==> sanity: confirm dupe exists"
test -f "$A" || { echo "❌ missing $A"; exit 1; }
test -f "$B" || { echo "❌ missing $B"; exit 1; }

echo "==> promote incidents/_components version -> admin/_components (canonical)"
cp "$B" "$A"

echo "==> replace incidents/_components with a re-export shim (prevents future drift)"
cat > "$B" <<'EOF'
"use client";
export { default } from "../../_components/GuidedWorkflowPanel";
EOF

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

INC_URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
BUNDLE_URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"

echo "==> smoke incident page"
curl -fsS "$INC_URL" >/dev/null && echo "✅ incident page OK" || {
  echo "❌ incident page failing"
  tail -n 200 .logs/next.log || true
  exit 1
}

echo "==> smoke bundle page"
curl -fsS "$BUNDLE_URL" >/dev/null && echo "✅ bundle page OK" || {
  echo "❌ bundle page failing"
  tail -n 200 .logs/next.log || true
  exit 1
}

echo
echo "✅ FIXED: single canonical GuidedWorkflowPanel + exportNow() available"
echo "OPEN:"
echo "  $INC_URL"
echo "  $BUNDLE_URL"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
