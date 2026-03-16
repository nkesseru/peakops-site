#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

echo "== sanity =="
echo "$FILE"
[[ -f "$FILE" ]] || { echo "❌ IncidentClient.tsx not found"; exit 1; }

echo
echo "== kill 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${PIDS:-}" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== backup =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_fieldjob_guard_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text(encoding="utf-8")

orig = s

# 1) Remove ALL existing hasActiveFieldJobs declarations anywhere.
s = re.sub(r'^[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;\n?', '', s, flags=re.M)

# 2) Detect whether selectableFieldJobs already exists.
has_selectable = re.search(r'const selectableFieldJobs\s*=\s*useMemo\(', s) is not None

if not has_selectable:
    # Insert selectableFieldJobs right after evidenceCount/lastActivity area if possible,
    # otherwise right before normalizedJobStatuses.
    block = '''
  const selectableFieldJobs = useMemo(
    () => (jobs || []).filter((j: any) => isFieldSelectableJob(j?.status)),
    [jobs]
  );
  const hasActiveFieldJobs = selectableFieldJobs.length > 0;
'''.lstrip("\n")

    anchor_patterns = [
        r'(const lastActivity = useMemo\([^\n]*\n(?:.*\n){0,4}?\);)',
        r'(const rawJobsDebug = useMemo\([^\n]*\n(?:.*\n){0,20}?\);)',
        r'(const normalizedJobStatuses = useMemo\()',
    ]

    inserted = False

    # Best case: insert after lastActivity useMemo
    m = re.search(anchor_patterns[0], s, flags=re.M)
    if m:
        insert_at = m.end()
        s = s[:insert_at] + "\n" + block + s[insert_at:]
        inserted = True

    # Fallback: insert before normalizedJobStatuses
    if not inserted:
        m = re.search(anchor_patterns[2], s, flags=re.M)
        if m:
            insert_at = m.start()
            s = s[:insert_at] + block + "\n" + s[insert_at:]
            inserted = True

    if not inserted:
        print("❌ Could not find insertion anchor for selectableFieldJobs")
        sys.exit(1)

else:
    # 3) selectableFieldJobs exists; place hasActiveFieldJobs immediately after it.
    m = re.search(
        r'(const selectableFieldJobs\s*=\s*useMemo\([\s\S]*?\n\s*\);)',
        s,
        flags=re.M
    )
    if not m:
        print("❌ selectableFieldJobs appears to exist but block could not be parsed")
        sys.exit(1)

    selectable_block = m.group(1)
    replacement = selectable_block + '\n  const hasActiveFieldJobs = selectableFieldJobs.length > 0;'
    s = s[:m.start()] + replacement + s[m.end():]

# 4) Safety cleanup: remove any rogue inline declaration accidentally left inside JSX debug panel.
s = re.sub(
    r'\n[ \t]*const hasActiveFieldJobs = selectableFieldJobs\.length > 0;(?=\n[ \t]*<pre className=)',
    '',
    s,
    flags=re.M
)

if s == orig:
    print("ℹ️ No textual changes were needed")
else:
    p.write_text(s, encoding="utf-8")
    print("✅ Restored selectableFieldJobs/hasActiveFieldJobs cleanly")
PY

echo
echo "== verify =="
rg -n "const selectableFieldJobs|const hasActiveFieldJobs" "$FILE" || true

echo
echo "== spot check around declarations =="
sed -n '940,1015p' "$FILE" || true

echo
echo "== spot check debug block =="
sed -n '2598,2615p' "$FILE" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next" || true

echo
echo "✅ Done."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open inc_demo"
echo "  2) Confirm page loads"
echo "  3) Open Timeline"
echo "  4) Click Jump"
