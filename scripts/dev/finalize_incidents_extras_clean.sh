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

# 1) Remove bad imports for these components (any relative variants)
s = re.sub(r'^\s*import\s+FilingMetaStub\s+from\s+["\'][^"\']+FilingMetaStub["\']\s*;\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*import\s+TimelinePreviewMock\s+from\s+["\'][^"\']+TimelinePreviewMock["\']\s*;\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*import\s+BackendBadge\s+from\s+["\'][^"\']+BackendBadge["\']\s*;\s*\n', '', s, flags=re.M)

# 2) Ensure correct imports exist (after React import)
m = re.search(r'^\s*import\s+React[^\n]*\n', s, flags=re.M)
if not m:
  raise SystemExit("❌ Could not find React import line")

insert = (
  'import FilingMetaStub from "../../_components/FilingMetaStub";\n'
  'import TimelinePreviewMock from "../../_components/TimelinePreviewMock";\n'
  'import BackendBadge from "../../_components/BackendBadge";\n'
)
if insert.strip() not in s:
  s = s[:m.end()] + insert + s[m.end():]

# 3) Remove visible marker text strings if present
s = s.replace("/*__PHASE2_EXTRAS_START__*/", "")
s = s.replace("/*__PHASE2_EXTRAS_END__*/", "")
s = s.replace("/*__BACKEND_BADGE__*/", "")

# 4) Dedupe TimelinePreviewMock occurrences (keep first)
matches = list(re.finditer(r'<TimelinePreviewMock\s*/>', s))
if len(matches) > 1:
  for mm in reversed(matches[1:]):
    s = s[:mm.start()] + "" + s[mm.end():]

# 5) Dedupe Packet State stub panels (keep first)
pat = re.compile(r'(<Panel\s+title=\\"Packet State \(stub\)\\"[\s\S]*?</Panel>)', re.M)
blocks = pat.findall(s)
if len(blocks) > 1:
  keep = blocks[0]
  s2 = pat.sub("", s)
  # reinsert keep at first location of original keep
  first_pos = s.find(keep)
  if first_pos == -1:
    s = keep + "\n" + s2
  else:
    s = s2[:first_pos] + keep + "\n" + s2[first_pos:]
else:
  s = s

p.write_text(s)
print("✅ incidents extras cleaned (imports fixed, markers removed, deduped)")
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
