#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
[[ -f "$FILE" ]] || { echo "❌ File not found"; exit 1; }

echo
echo "== backup =="
cp "$FILE" "$FILE.bak.$(date +%Y%m%d_%H%M%S)"

python3 <<'PY'
from pathlib import Path

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
lines = s.splitlines()

targets = [
    "const hasActiveFieldJobs = Array.isArray(jobs) && jobs.some((j: any) => isFieldSelectableJob(j?.status));",
    "const hasActiveFieldJobs = selectableFieldJobs.length > 0;",
    "const showJobsDebugPanel = false;",
    "const rawJobsDebug: any[] = [];",
    "const normalizedJobStatuses: any[] = [];",
]

seen = {t: 0 for t in targets}
out = []

for line in lines:
    stripped = line.strip()
    if stripped in seen:
        seen[stripped] += 1
        if seen[stripped] > 1:
            print(f"Removing duplicate: {stripped}")
            continue
    out.append(line)

p.write_text("\n".join(out) + "\n", encoding="utf-8")
print("✅ Deduped duplicate const declarations")
PY

echo
echo "== verify =="
rg -n "const hasActiveFieldJobs|const showJobsDebugPanel|const rawJobsDebug|const normalizedJobStatuses" "$FILE" || true

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
