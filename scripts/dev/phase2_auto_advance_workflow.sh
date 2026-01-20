#!/usr/bin/env bash
set +H 2>/dev/null || true
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

if "const [meta," not in s:
    # insert after wf state
    s = re.sub(
        r'(const\s+\[wf,\s*setWf\]\s*=\s*useState<Workflow\s*\|\s*null>\(null\);\s*\n)',
        r'\1\n  const [meta, setMeta] = useState<any>(null);\n',
        s,
        count=1
    )
if "setMeta(" not in s:
    # Insert after: const j = parsed.value;
    s = re.sub(
        r'(const\s+j\s*=\s*parsed\.value;\s*\n)',
        r'\1      const incidentMeta = j?.incident || null;\n      setMeta(incidentMeta);\n',
        s,
        count=1
    )
    # If that didn't match, try a fallback after `const j = parsed.value;` without spaces exactness
    if "setMeta(" not in s:
        s = re.sub(
            r'(const\s+j\s*=\s*parsed\.value;\s*)',
            r'\1\n      const incidentMeta = j?.incident || null;\n      setMeta(incidentMeta);\n',
            s,
            count=1
        )

if "Auto-advance steps based on meta" not in s:
    marker = "const donePct"
    idx = s.find(marker)
    if idx == -1:
        raise SystemExit("❌ Could not find insertion point (const donePct).")

    auto = r'''
  // Auto-advance steps based on backend-derived meta (while keeping tech override via localStorage)
  useEffect(() => {
    if (!meta) return;

    const next = { ...localStatus };
    let changed = false;

    const timelineReady =
      !!(meta?.timelineMeta && (meta.timelineMeta.eventCount > 0 || meta.timelineMeta.generatedAt));
    const filingsReady = !!(meta?.filingsMeta && (meta.filingsMeta.count > 0 || (meta.filingsMeta.schemas && meta.filingsMeta.schemas.length)));
    const exportReady = !!(meta?.packetMeta && (meta.packetMeta.packetHash || meta.packetMeta.hash));

    // optional baseline heuristic (safe): if incident exists + has id, treat intake as done
    const intakeReady = !!(meta?.id);

    function mark(k: string, v: "DONE") {
      if (next[k] !== v) {
        next[k] = v;
        changed = true;
      }
    }

    // Only promote to DONE (never auto-demote)
    if (intakeReady) mark("intake", "DONE");
    if (timelineReady) mark("timeline", "DONE");
    if (filingsReady) mark("filings", "DONE");
    if (exportReady) mark("export", "DONE");

    if (changed) {
      setLocalStatus(next);
      writeLocal(storageKey, next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);
'''
    s = s[:idx] + auto + "\n  " + s[idx:]

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: meta + auto-advance effect")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 120 .logs/next.log; exit 1; }

echo "✅ DONE"
