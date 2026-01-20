#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# Normalize any accidental triple quotes from prior automation
s = s.replace("'''", "").replace('"""', "")

# Replace the setStatus() function with auto-advance aware version.
# We look for:
#   function setStatus(key: string, status: StepStatus) { ... }
pat = re.compile(
  r"function\s+setStatus\s*\(\s*key:\s*string\s*,\s*status:\s*StepStatus\s*\)\s*\{[\s\S]*?\n\s*\}",
  re.M
)

replacement = r"""function setStatus(key: string, status: StepStatus) {
    const k = String(key);

    // 1) Update the clicked step
    const next = { ...localStatus, [k]: status };

    // 2) Auto-advance: if user marks a step DONE, set the *next* step to DOING (only if it's still TODO)
    try {
      if (status === "DONE" && steps && steps.length) {
        const idx = steps.findIndex((x) => String(x?.key) === k);
        if (idx >= 0 && idx + 1 < steps.length) {
          const nextKey = String(steps[idx + 1]?.key || "");
          if (nextKey) {
            const current = next[nextKey] || steps[idx + 1]?.status || "TODO";
            if (current === "TODO") {
              next[nextKey] = "DOING";
            }
          }
        }
      }
    } catch {
      // never block UI
    }

    setLocalStatus(next);
    writeLocal(storageKey, next);
  }"""

m = pat.search(s)
if not m:
  raise SystemExit("❌ Could not find setStatus() in GuidedWorkflowPanel.tsx (file structure changed).")

s = s[:m.start()] + replacement + s[m.end():]

# Add a tiny visual cue for DOING step (optional safe polish)
# We'll make the status pill background slightly stronger when DOING.
# Find: <span style={pill(true)}>{st}</span>
# Replace with: <span style={pill(true)}>{st}</span> (but tweak pill() to accept intensity)
# We'll only patch if pill() is currently pill(active: boolean)
pill_pat = re.compile(r"function\s+pill\s*\(\s*active:\s*boolean\s*\)\s*:\s*React\.CSSProperties\s*\{", re.M)
if pill_pat.search(s):
  # Update signature to accept optional level
  s = re.sub(
    r"function\s+pill\s*\(\s*active:\s*boolean\s*\)\s*:\s*React\.CSSProperties\s*\{",
    "function pill(active: boolean, level: \"NORMAL\" | \"DOING\" = \"NORMAL\"): React.CSSProperties {",
    s,
    count=1
  )
  # Update background line to use stronger fill when DOING
  s = s.replace(
    'background: active\n      ? "color-mix(in oklab, CanvasText 10%, transparent)"\n      : "transparent",',
    'background: active\n      ? (level === "DOING"\n          ? "color-mix(in oklab, CanvasText 16%, transparent)"\n          : "color-mix(in oklab, CanvasText 10%, transparent)")\n      : "transparent",'
  )
  # Update render where pill(true) is used for status display
  s = s.replace(
    "<span style={pill(true)}>{st}</span>",
    "<span style={pill(true, st === \"DOING\" ? \"DOING\" : \"NORMAL\")}>{st}</span>"
  )

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: auto-advance + DOING highlight")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke"
curl -fsSI "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 8 || true
echo "✅ done"
