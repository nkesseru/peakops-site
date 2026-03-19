#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # zsh history expansion off (safe)

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TAG="a1-one-true-stack-stable"
FILE='next-app/src/app/admin/incidents/[id]/bundle/page.tsx'

echo "==> Restore $FILE from tag: $TAG"
# Make a local safety backup of whatever is currently on disk
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/bundle_page_pre_restore_$(date +%Y%m%d_%H%M%S).tsx" 2>/dev/null || true

# Restore from tag (most reliable)
git show "${TAG}:${FILE}" > "$FILE"

echo "✅ restored from tag"
echo

echo "==> Restart Next (clean cache)"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
pkill -f "next dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
rm -f .logs/next.log
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> Smoke: bundle page should be 200"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 8 || true
echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
