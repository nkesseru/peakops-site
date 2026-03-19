#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "${FILE}.bak_${TS}"
echo "✅ backup: ${FILE}.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# -----------------------------------------------------------------------------
# 1) REMOVE the stray module-scope history effect (the one crashing: histKey undefined)
#    Specifically targets the exact pattern from your error:
#    useEffect(() => { if (typeof window !== "undefined") setHist(readHist(histKey)); }, [histKey]);
# -----------------------------------------------------------------------------
s2 = re.sub(
    r'^\s*useEffect\(\(\)\s*=>\s*\{\s*if\s*\(typeof\s+window\s*!==\s*"undefined"\)\s*setHist\(readHist\(histKey\)\);\s*\},\s*\[\s*histKey\s*\]\s*\);\s*$\n?',
    '',
    s,
    flags=re.M
)
s = s2

# Also remove any other module-scope useEffect that references histKey (safer net)
s = re.sub(r'^\s*useEffect\([^\n]*\[\s*histKey\s*\][\s\S]*?\);\s*$\n?', '', s, flags=re.M)

# -----------------------------------------------------------------------------
# 2) Ensure history helpers exist once
# -----------------------------------------------------------------------------
if "/*__GWP_HISTORY_HELPERS_V2__*/" not in s:
    helpers = r'''
/*__GWP_HISTORY_HELPERS_V2__*/
type StepStatus = "TODO" | "DOING" | "DONE";
type WfHistItem = {
  ts: string;
  stepKey: string;
  from?: StepStatus;
  to: StepStatus;
  mode: "AUTO" | "MANUAL";
};

function readHist(key: string): WfHistItem[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(key) || "[]";
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as WfHistItem[]) : [];
  } catch {
    return [];
  }
}

function writeHist(key: string, items: WfHistItem[]) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(items.slice(-200)));
  } catch {
    // ignore
  }
}
'''
    m = re.search(r'^\s*"use client";\s*$', s, flags=re.M)
    if m:
        s = s[:m.end()] + "\n" + helpers + "\n" + s[m.end():]
    else:
        s = helpers + "\n" + s

# -----------------------------------------------------------------------------
# 3) Inject histKey + hist state INSIDE component (only once)
# -----------------------------------------------------------------------------
if "/*__GWP_HISTORY_STATE_V2__*/" not in s:
    # Find component body start
    fn = re.search(r'export\s+default\s+function\s+GuidedWorkflowPanel\s*\([^)]*\)\s*\{', s)
    if not fn:
        raise SystemExit("❌ Could not find GuidedWorkflowPanel()")

    # Prefer anchor right after orgId + incidentId declarations
    chunk = s[fn.end():]
    anchor = re.search(r'(const\s+orgId\s*=.*?\n.*?const\s+incidentId\s*=.*?\n)', chunk, flags=re.S)
    if not anchor:
        # fallback: after incidentId only
        anchor = re.search(r'(const\s+incidentId\s*=.*?\n)', chunk, flags=re.S)
    if not anchor:
        raise SystemExit("❌ Could not find orgId/incidentId inside component for history injection")

    inject_at = fn.end() + anchor.end()

    inject = r'''
  /*__GWP_HISTORY_STATE_V2__*/
  const histKey = `gwp_hist:${orgId}:${incidentId}`;
  const [hist, setHist] = useState<WfHistItem[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setHist(readHist(histKey));
  }, [histKey]);

  function pushHist(item: WfHistItem) {
    setHist((prev) => {
      const next = [...prev, item].slice(-200);
      writeHist(histKey, next);
      return next;
    });
  }
'''
    s = s[:inject_at] + "\n" + inject + "\n" + s[inject_at:]

# -----------------------------------------------------------------------------
# 4) Deduplicate accidental extra "histKey" declarations (keep first)
# -----------------------------------------------------------------------------
lines = s.splitlines(True)
hist_decl = [i for i,l in enumerate(lines) if re.search(r'^\s*const\s+histKey\s*=', l)]
if len(hist_decl) > 1:
    for i in reversed(hist_decl[1:]):
        del lines[i]
    s = "".join(lines)

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: removed module-scope histKey effect + injected in-component history state")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ still failing"; tail -n 220 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "✅ done"
