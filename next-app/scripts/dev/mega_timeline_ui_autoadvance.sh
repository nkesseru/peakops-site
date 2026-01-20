#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"
FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"

if [[ ! -f "$FILE" ]]; then
  echo "❌ Missing $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# ------------------------------------------------------------
# (1) Add helper if missing: call generateTimelineV1
# ------------------------------------------------------------
if "async function generateTimeline" not in s:
    helper = '''
async function generateTimeline(orgId: string, incidentId: string) {
  const r = await fetch("/api/fn/generateTimelineV1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId, incidentId, requestedBy: "ui" }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok: false, error: t }; }
}
'''
    s = s.replace("export default function GuidedWorkflowPanel", helper + "\nexport default function GuidedWorkflowPanel")

# ------------------------------------------------------------
# (2) Add timeline UI state
# ------------------------------------------------------------
if "const [timelineBusy" not in s:
    s = s.replace(
        "const [autoNotes, setAutoNotes] = useState<string[]>([]);",
        "const [autoNotes, setAutoNotes] = useState<string[]>([]);\n"
        "  const [timelineBusy, setTimelineBusy] = useState(false);\n"
        "  const [timelineMsg, setTimelineMsg] = useState<string | null>(null);"
    )

# ------------------------------------------------------------
# (3) Insert Generate Timeline button + handler
# ------------------------------------------------------------
if "onGenerateTimeline" not in s:
    handler = '''
  async function onGenerateTimeline() {
    try {
      setTimelineBusy(true);
      setTimelineMsg(null);
      const r = await generateTimeline(orgId, incidentId);
      if (!r?.ok) throw new Error(r?.error || "Generate failed");
      setTimelineMsg(`✅ Timeline generated (${r.count || 0} events)`);
      await load(); // reload workflow + timeline
    } catch (e: any) {
      setTimelineMsg(`❌ ${String(e?.message || e)}`);
    } finally {
      setTimelineBusy(false);
    }
  }
'''
    s = s.replace("const donePct = percentDone(steps);", handler + "\n  const donePct = percentDone(steps);")

# ------------------------------------------------------------
# (4) Inject button into header
# ------------------------------------------------------------
if "Generate Timeline" not in s:
    s = s.replace(
        '<button onClick={load} disabled={busy} style={pill(false)}>',
        '<button onClick={load} disabled={busy} style={pill(false)}>'
        '\n        <button onClick={onGenerateTimeline} disabled={timelineBusy} '
        'style={pill(false)}>'
        '{timelineBusy ? "Generating…" : "Generate Timeline"}'
        '</button>'
    )

# ------------------------------------------------------------
# (5) Status banner
# ------------------------------------------------------------
if "timelineMsg &&" not in s:
    banner = '''
      {timelineMsg && (
        <div style={{
          marginTop: 8,
          padding: "8px 12px",
          borderRadius: 8,
          fontSize: 13,
          background: timelineMsg.startsWith("✅")
            ? "color-mix(in oklab, green 15%, transparent)"
            : "color-mix(in oklab, crimson 15%, transparent)",
        }}>
          {timelineMsg}
        </div>
      )}
'''
    s = s.replace("{err && (", banner + "\n      {err && (")

p.write_text(s)
print("✅ Timeline UI + auto-advance wired")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > .logs/next.log 2>&1 ) &
sleep 2

echo "==> DONE"
echo "Open:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
