#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()
orig = s

if "setMeta" not in s or "intakeReady" not in s:
    raise SystemExit("❌ Expected meta + intakeReady already present. Run phase2_auto_advance_workflow.sh first.")

if "const timelineReady" not in s:
    # Find intakeReady line
    m = re.search(r'const\s+intakeReady\s*=.*?\n', s)
    if not m:
        raise SystemExit("❌ Could not find intakeReady line to anchor readiness booleans.")
    insert = (
        '  const timelineReady = !!(meta?.timelineMeta && Number(meta.timelineMeta?.eventCount || 0) > 0);\n'
        '  const filingsReady  = !!(meta?.filingsMeta && Number(meta.filingsMeta?.count || 0) > 0);\n'
        '  const exportReady   = !!(meta?.packetMeta && (meta.packetMeta?.packetHash || meta.packetMeta?.hash) && Number(meta.packetMeta?.sizeBytes || 0) > 0);\n'
    )
    s = s[:m.end()] + insert + s[m.end():]
if 'mark("timeline", "DONE")' not in s:
    # Find the first mark("intake","DONE") occurrence inside the effect block and inject immediately after it.
    pat = re.compile(r'(mark\("intake",\s*"DONE"\);\s*)')
    if not pat.search(s):
        raise SystemExit('❌ Could not find mark("intake","DONE"); to anchor step auto-advance injections.')
    s = pat.sub(
        r'\1'
        r'      if (timelineReady) mark("timeline", "DONE");\n'
        r'      if (filingsReady)  mark("filings", "DONE");\n'
        r'      if (exportReady)   mark("export", "DONE");\n',
        s,
        count=1
    )
if "useEffect" in s and "timelineReady" in s and "], [meta" in s:
    # common pattern: }, [meta, localStatus, storageKey ...])
    # We'll append if not present
    s = re.sub(
        r'\]\s*\);\s*$',
        '] );',
        s
    )
if "/* autoDone_prune */" not in s:
    prune_block = (
        "\n  /* autoDone_prune */\n"
        "  useEffect(() => {\n"
        "    // If backend meta regresses (rare), remove AUTO badges so UI reflects reality.\n"
        "    // We do NOT force status backwards; we only clear the AUTO badge markers.\n"
        "    setAutoDone((m) => {\n"
        "      const next = { ...m };\n"
        "      if (!timelineReady) delete next[\"timeline\"]; \n"
        "      if (!filingsReady)  delete next[\"filings\"]; \n"
        "      if (!exportReady)   delete next[\"export\"]; \n"
        "      return next;\n"
        "    });\n"
        "  }, [timelineReady, filingsReady, exportReady]);\n"
    )
    # Insert prune block right after readiness booleans
    m = re.search(r'const\s+exportReady.*?\n', s)
    if m:
        s = s[:m.end()] + prune_block + s[m.end():]

if s == orig:
    print("⚠️ No changes made (already patched?)")
else:
    p.write_text(s)
    print("✅ patched GuidedWorkflowPanel: auto-advance steps 2–4 (timeline/filings/export)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 160 .logs/next.log; exit 1; }

echo "✅ DONE"
