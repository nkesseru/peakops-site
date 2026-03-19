#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/contracts/[id]/packet/page.tsx"
if [ ! -f "$FILE" ]; then
  echo "❌ missing: $FILE"
  exit 1
fi

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx")
s = p.read_text()

# 1) Fix escaped quotes INSIDE setErr(...) lines (this is what causes unterminated string)
lines = s.splitlines(True)
out = []
changed = False
for ln in lines:
    if "setErr(" in ln:
        ln2 = ln.replace('\\"', '"').replace('\\\"', '"')
        if ln2 != ln:
            changed = True
        out.append(ln2)
    else:
        out.append(ln)

s2 = "".join(out)

# Extra safety: if we accidentally end up with setErr("");; etc, normalize
s2_new = re.sub(r'setErr\(\s*""\s*\)', 'setErr("")', s2)
if s2_new != s2:
    changed = True
s2 = s2_new

# 2) If useRouter() is used, ensure it's imported from next/navigation
if "useRouter(" in s2 and "from \"next/navigation\"" in s2:
    # find the import line
    def repl(m):
        imp = m.group(0)
        if "useRouter" in imp:
            return imp
        # insert useRouter into the import set
        inside = m.group(1)
        parts = [x.strip() for x in inside.split(",") if x.strip()]
        parts.append("useRouter")
        # de-dupe while preserving order
        seen = set()
        dedup = []
        for x in parts:
            if x not in seen:
                seen.add(x)
                dedup.append(x)
        return f'import {{ {", ".join(dedup)} }} from "next/navigation";'
    s3 = re.sub(r'import\s*\{\s*([^}]+)\s*\}\s*from\s*"next/navigation";', repl, s2, count=1)
    if s3 != s2:
        changed = True
    s2 = s3

if not changed:
    print("ℹ️ No changes needed (file already clean).")
else:
    p.write_text(s2)
    print("✅ patched packet/page.tsx (fixed escaped quotes + ensured useRouter import)")
PY

echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> smoke Packet Preview (should return 200)"
curl -fsS -I "http://127.0.0.1:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1" | head -n 5 || true

echo
echo "✅ done"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
