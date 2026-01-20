#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()
s = s.replace("/*__PHASE2_EXTRAS_START__*/", "")
s = s.replace("/*__PHASE2_EXTRAS_END__*/", "")
s = s.replace("__PHASE2_EXTRAS_START__", "")
s = s.replace("__PHASE2_EXTRAS_END__", "")
matches = list(re.finditer(r"<TimelinePreviewMock\s*/>", s))
if len(matches) > 1:
  # remove from second onward (walk backwards so indexes stay valid)
  for m in reversed(matches[1:]):
    s = s[:m.start()] + "" + s[m.end():]
pat = re.compile(r"(<Panel\s+title=\x22Packet State \(stub\)\x22>[\s\S]*?</Panel>)", re.M)
blocks = pat.findall(s)
if len(blocks) > 1:
  # keep first, remove others
  keep = blocks[0]
  # remove all occurrences then re-insert keep once at the first occurrence position
  first_pos = s.find(keep)
  s2 = pat.sub("", s)
  s = s2[:first_pos] + keep + "\n" + s2[first_pos:]

p.write_text(s)
print("✅ cleaned: removed rendered markers + deduped TimelinePreviewMock + Packet State stubs")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}

echo "✅ done"
