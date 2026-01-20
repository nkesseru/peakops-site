#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

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

# --- Inject timeline fetch + auto-step logic once ---
if "/*__TIMELINE_AUTO_WIRE_V1__*/" not in s:
    block = r'''
/*__TIMELINE_AUTO_WIRE_V1__*/
type TimelineEvent = {
  id: string;
  type: string;
  title?: string;
  message?: string;
  occurredAt?: string;
};

const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
const [timelineLoaded, setTimelineLoaded] = useState(false);

useEffect(() => {
  if (!orgId || !incidentId) return;
  fetch(`/api/fn/getTimelineEvents?orgId=${orgId}&incidentId=${incidentId}&limit=50`)
    .then(r => r.json())
    .then(j => {
      if (j?.ok && Array.isArray(j.docs)) {
        setTimeline(j.docs);
      }
    })
    .finally(() => setTimelineLoaded(true));
}, [orgId, incidentId]);

// AUTO: if timeline exists, mark step 2 DONE
useEffect(() => {
  if (!timelineLoaded) return;
  if (timeline.length > 0) {
    setStatus("build_timeline", "DONE");
  }
}, [timelineLoaded, timeline.length]);
'''
    # insert after state declarations
    s = re.sub(
        r'(const\s+\[autoLevel,\s*setAutoLevel\][\s\S]+?\n)',
        r'\1\n' + block + '\n',
        s,
        count=1
    )

# --- Replace mock timeline preview ---
s = re.sub(
    r'Timeline Preview \(mock\)[\s\S]+?</div>',
    r'''Timeline Preview
      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
        {!timelineLoaded && <div style={{ opacity: 0.6 }}>Loading timeline…</div>}
        {timelineLoaded && timeline.length === 0 && (
          <div style={{ opacity: 0.6 }}>No timeline events yet.</div>
        )}
        {timeline.map(ev => (
          <div key={ev.id} style={{
            padding: 8,
            borderRadius: 8,
            border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)"
          }}>
            <div style={{ fontWeight: 700 }}>{ev.title || ev.type}</div>
            {ev.message && <div style={{ fontSize: 12, opacity: 0.8 }}>{ev.message}</div>}
            {ev.occurredAt && (
              <div style={{ fontSize: 11, opacity: 0.6 }}>
                {new Date(ev.occurredAt).toLocaleString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>''',
    s,
    flags=re.M
)

p.write_text(s)
print("✅ Wired real timeline into GuidedWorkflowPanel")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 ) &

sleep 2
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
