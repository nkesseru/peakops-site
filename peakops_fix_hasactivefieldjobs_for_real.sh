#!/usr/bin/env bash
set -euo pipefail

FILE="$HOME/peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
test -f "$FILE"

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_hasactivefieldjobs_$TS"

python3 <<'PY'
from pathlib import Path

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")
orig = s

bad_line = "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n"
s = s.replace(bad_line, "")

anchor = "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n"
if anchor not in s:
    marker = "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n"
    insert_after = """  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n"""
    if insert_after.strip() in s:
        pass

# insert in component scope right after selectableFieldJobs useMemo block
scope_marker = """  const selectableFieldJobs = useMemo(
    () => (jobs || []).filter((j: any) => isFieldSelectableJob(j?.status)),
    [jobs]
  );
"""
if scope_marker in s and "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n" not in s:
    s = s.replace(
        scope_marker,
        scope_marker + "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n",
        1,
    )

# if it still didn't land, fail loudly
if "  const hasActiveFieldJobs = selectableFieldJobs.length > 0;\n" not in s:
    raise SystemExit("FAILED: could not insert hasActiveFieldJobs in component scope")

p.write_text(s, encoding="utf-8")
print("patched IncidentClient.tsx")
PY

echo
echo "== verify =="
sed -n '970,1015p' "$FILE"
echo "-----"
sed -n '2598,2615p' "$FILE"
echo "-----"
sed -n '2996,3006p' "$FILE"

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  kill -9 $PIDS
  echo "Killed: $PIDS"
else
  echo "No 3001 listener"
fi

echo
echo "== clear next cache =="
rm -rf "$HOME/peakops/my-app/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
