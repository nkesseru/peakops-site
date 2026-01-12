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

# 1) Remove the bad injected hook block (it triggers "Invalid hook call")
# Matches from /* autoDone_prune */ to the end of that useEffect.
s2, n = re.subn(
    r'\n\s*/\*\s*autoDone_prune\s*\*/[\s\S]*?\n\s*\}\s*,\s*\[\s*timelineReady\s*,\s*filingsReady\s*,\s*exportReady\s*\]\s*\);\s*\n',
    '\n',
    s,
    count=1
)
s = s2
print(f"✅ removed autoDone_prune hook block: {n} removed")
if "const timelineReady" not in s:
    m = re.search(r'^\s*const\s+intakeReady\s*=.*\n', s, flags=re.M)
    if not m:
        raise SystemExit("❌ Could not find intakeReady to anchor readiness booleans.")
    insert = (
        '  const timelineReady = !!(meta?.timelineMeta && Number(meta.timelineMeta?.eventCount || 0) > 0);\n'
        '  const filingsReady  = !!(meta?.filingsMeta && Number(meta.filingsMeta?.count || 0) > 0);\n'
        '  const exportReady   = !!(meta?.packetMeta && (meta.packetMeta?.packetHash || meta.packetMeta?.hash) && Number(meta.packetMeta?.sizeBytes || 0) > 0);\n'
    )
    s = s[:m.end()] + insert + s[m.end():]
    print("✅ inserted readiness booleans")
if "const [autoDone" not in s:
    m = re.search(r'^\s*const\s+\[meta,\s*setMeta\]\s*=\s*useState<.*?>\(\s*null\s*\);\s*\n', s, flags=re.M)
    if not m:
        # fallback: insert after meta declaration even if generic typed
        m = re.search(r'^\s*const\s+\[meta,\s*setMeta\]\s*=\s*useState.*\n', s, flags=re.M)
    if not m:
        raise SystemExit("❌ Could not find meta state to insert autoDone state.")
    s = s[:m.end()] + "  const [autoDone, setAutoDone] = useState<Record<string, boolean>>({});\n" + s[m.end():]
    print("✅ inserted autoDone state")
mark_pat = re.compile(
    r'function\s+mark\(k:\s*string,\s*v:\s*"DONE"\)\s*\{\s*'
    r'if\s*\(next\[k\]\s*!==\s*v\)\s*\{\s*'
    r'next\[k\]\s*=\s*v;\s*'
    r'changed\s*=\s*true;\s*'
    r'\}\s*\}\s*',
    re.M
)
mark_repl = (
    'function mark(k: string, v: "DONE") {\n'
    '      if (next[k] !== v) {\n'
    '        next[k] = v;\n'
    '        changed = true;\n'
    '        setAutoDone((m) => ({ ...m, [k]: true }));\n'
    '      }\n'
    '    }\n'
)
if mark_pat.search(s):
    s = mark_pat.sub(mark_repl, s, count=1)
    print("✅ ensured mark() sets AUTO badge")
adv_anchor = re.search(r'mark\("intake",\s*"DONE"\);\s*', s)
if adv_anchor and "timelineReady" in s:
    inject_block = (
        '      if (timelineReady) mark("timeline", "DONE");\n'
        '      if (filingsReady)  mark("filings", "DONE");\n'
        '      if (exportReady)   mark("export", "DONE");\n'
        '      // prune AUTO badges if backend readiness regresses (rare)\n'
        '      setAutoDone((m) => {\n'
        '        const nextAuto = { ...m };\n'
        '        if (!timelineReady) delete nextAuto["timeline"];\n'
        '        if (!filingsReady)  delete nextAuto["filings"];\n'
        '        if (!exportReady)   delete nextAuto["export"];\n'
        '        return nextAuto;\n'
        '      });\n'
    )
    # only inject if not already present
    if "mark(\"timeline\"" not in s:
        s = re.sub(r'(mark\("intake",\s*"DONE"\);\s*)', r'\1' + inject_block, s, count=1)
        print("✅ injected auto-advance + prune block inside existing effect")
else:
    print("⚠️ did not find mark(intake,DONE) anchor; skipping step 2–4 injection")
needle = '<span style={pill(true)}>{st}</span>'
if needle in s and "AUTO</span>" not in s:
    replacement = (
        '<span style={{ ...pill(true), display: "inline-flex", gap: 8, alignItems: "center" }}>'
        '{st}'
        '{autoDone[String(s.key)] ? ('
        '<span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 900, '
        'border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)", '
        'background: "color-mix(in oklab, lime 18%, transparent)" }}>AUTO</span>'
        ') : null}'
        '</span>'
    )
    s = s.replace(needle, replacement, 1)
    print("✅ added AUTO badge UI")

if s == orig:
    print("⚠️ no changes made (already fixed?)")
else:
    p.write_text(s)
    print("✅ GuidedWorkflowPanel fixed: removed invalid hook + kept auto-advance")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 180 .logs/next.log; exit 1; }

echo "✅ DONE"
