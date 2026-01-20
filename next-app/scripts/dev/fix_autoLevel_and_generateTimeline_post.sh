#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"
[[ -d "$ROOT/next-app" ]] || { echo "❌ Run from repo root (contains next-app/)"; exit 1; }

TS="$(date +%Y%m%d_%H%M%S)"
echo "==> TS=$TS"

############################################
# (1) Fix GuidedWorkflowPanel autoLevel
############################################
GWP="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
[[ -f "$GWP" ]] || { echo "❌ missing: $GWP"; exit 1; }

cp "$GWP" "$GWP.bak_$TS"
echo "✅ backup: $GWP.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# Ensure AutoLevel type exists once
if "type AutoLevel" not in s:
    s = s.replace(
        'type StepStatus = "TODO" | "DOING" | "DONE";',
        'type StepStatus = "TODO" | "DOING" | "DONE";\n'
        'type AutoLevel = "OK" | "WARN" | "BLOCK";'
    )

# Remove ALL prior auto state decls (prevents dupes / ghosts at file end)
s = re.sub(r'\n\s*const\s+\[\s*autoLevel\s*,\s*setAutoLevel\s*\]\s*=\s*useState<[^;]+;\s*', '\n', s)
s = re.sub(r'\n\s*const\s+\[\s*autoNotes\s*,\s*setAutoNotes\s*\]\s*=\s*useState<[^;]+;\s*', '\n', s)
s = re.sub(r'\n\s*const\s+\[\s*autoBusy\s*,\s*setAutoBusy\s*\]\s*=\s*useState<[^;]+;\s*', '\n', s)

# Insert canonical auto state right after wf state
m = re.search(r'(const\s+\[\s*wf\s*,\s*setWf\s*\]\s*=\s*useState<Workflow\s*\|\s*null>\(null\);\s*)', s)
if not m:
    raise SystemExit("❌ Could not find wf state anchor (wf/setWf).")

insert = (
  "\n  const [autoLevel, setAutoLevel] = useState<AutoLevel | null>(null);\n"
  "  const [autoNotes, setAutoNotes] = useState<string[]>([]);\n"
  "  const [autoBusy, setAutoBusy] = useState(false);\n"
)
s = s[:m.end()] + insert + s[m.end():]

# Remove any stray top-level useEffect that got appended OUTSIDE the component
s = re.sub(r'\n\s*useEffect\s*\([\s\S]*?\);\s*$', '\n', s, flags=re.M)

p.write_text(s)
print("✅ GuidedWorkflowPanel patched (autoLevel fixed + deduped)")
PY

############################################
# (2) Fix generateTimelineV1 route to accept POST JSON body
############################################
TL="next-app/src/app/api/fn/generateTimelineV1/route.ts"
if [[ ! -f "$TL" ]]; then
  echo "⚠️ missing: $TL (skipping generateTimelineV1 patch)"
else
  cp "$TL" "$TL.bak_$TS"
  echo "✅ backup: $TL.bak_$TS"

  python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/generateTimelineV1/route.ts")
s = p.read_text()

# If already supports body, don't double-inject
if "const body =" in s and "body.orgId" in s and "body.incidentId" in s:
    print("ℹ️ generateTimelineV1 already supports POST body; skipping")
    raise SystemExit(0)

# Insert body parsing at top of POST handler
pat = r'export\s+async\s+function\s+POST\s*\(\s*req\s*:\s*Request\s*\)\s*\{'
m = re.search(pat, s)
if not m:
    raise SystemExit("❌ Could not find `export async function POST(req: Request) {`")

inject = r'''
  const body = await req.json().catch(() => ({}));
  const url = new URL(req.url);

  const orgId = body.orgId || url.searchParams.get("orgId");
  const incidentId = body.incidentId || url.searchParams.get("incidentId");

  if (!orgId || !incidentId) {
    return NextResponse.json({ ok: false, error: "Missing orgId or incidentId" }, { status: 400 });
  }
'''

s = s[:m.end()] + inject + s[m.end():]
p.write_text(s)
print("✅ generateTimelineV1 patched (POST body supported)")
PY
fi

############################################
# (3) Restart Next (port 3000) + smoke
############################################
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> smoke: incidents page"
curl -fsS "$BASE/admin/incidents/inc_TEST?orgId=org_001" >/dev/null && echo "✅ incidents page OK" || {
  echo "❌ incidents page still failing"
  tail -n 120 .logs/next.log || true
}

echo "==> smoke: generateTimelineV1 accepts POST body"
curl -sS -X POST "$BASE/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d '{"orgId":"org_001","incidentId":"inc_TEST","requestedBy":"admin_ui"}' \
| (command -v jq >/dev/null && jq || cat)

echo "✅ done"
