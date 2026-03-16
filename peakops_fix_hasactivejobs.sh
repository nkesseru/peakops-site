#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== locating selectableFieldJobs block =="

LINE=$(grep -n "selectableFieldJobs" "$FILE" | head -n 1 | cut -d: -f1)

if [[ -z "$LINE" ]]; then
  echo "❌ selectableFieldJobs block not found"
  exit 1
fi

INSERT_LINE=$((LINE+3))

echo "== inserting hasActiveFieldJobs definition =="

awk -v n="$INSERT_LINE" '
NR==n { print "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;" }
{ print }
' "$FILE" > "$FILE.tmp"

mv "$FILE.tmp" "$FILE"

echo "== clearing Next cache =="
rm -rf ~/peakops/my-app/next-app/.next

echo "✅ Patch applied."
echo ""
echo "Now run:"
echo "cd ~/peakops/my-app && pnpm dev"
