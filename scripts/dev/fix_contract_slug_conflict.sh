#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> showing admin/contracts routes"
ls -la next-app/src/app/admin/contracts || true
echo
find next-app/src/app/admin/contracts -maxdepth 2 -type d -name "\[*\]" -print || true
echo

# If a [contractId] route exists, migrate it to [id] and remove the old folder
if [ -d "next-app/src/app/admin/contracts/[contractId]" ]; then
  echo "==> Found [contractId]. Migrating to [id]..."

  mkdir -p "next-app/src/app/admin/contracts/[id]"
  # move files if [id] is empty or missing files
  if [ -f "next-app/src/app/admin/contracts/[contractId]/page.tsx" ] && [ ! -f "next-app/src/app/admin/contracts/[id]/page.tsx" ]; then
    mv "next-app/src/app/admin/contracts/[contractId]/page.tsx" "next-app/src/app/admin/contracts/[id]/page.tsx"
  fi

  # remove old folder (will error if not empty; so remove safely)
  rm -rf "next-app/src/app/admin/contracts/[contractId]"
  echo "✅ removed: next-app/src/app/admin/contracts/[contractId]"
fi

# Also kill any compiled duplicate route artifacts if needed
rm -rf next-app/.next 2>/dev/null || true

echo "==> quick sanity grep for contractId slug usage"
rg -n "useParams<\\{\\s*contractId" next-app/src/app/admin/contracts -S || true
rg -n "\\[contractId\\]" next-app/src/app -S || true

echo
echo "✅ Done. Restart Next now:"
echo "lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true"
echo "pnpm -C next-app dev --port 3000"
