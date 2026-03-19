#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # zsh: disable history expansion

ROOT="next-app/src/app/admin/contracts"
if [ ! -d "$ROOT" ]; then
  echo "❌ missing: $ROOT"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
import re

root = Path("next-app/src/app/admin/contracts")
files = list(root.rglob("*.tsx")) + list(root.rglob("*.ts"))

patched = 0
for p in files:
    s = p.read_text()

    if "useRouter(" not in s:
        continue

    # Must have a next/navigation import line
    nav_import = re.search(r"^import\s+\{([^}]+)\}\s+from\s+[\"']next/navigation[\"'];\s*$", s, re.M)
    if nav_import:
        inside = nav_import.group(1)
        names = [x.strip() for x in inside.split(",") if x.strip()]
        if "useRouter" not in names:
            names.append("useRouter")
            new_inside = ", ".join(names)
            s2 = s[:nav_import.start(1)] + new_inside + s[nav_import.end(1):]
            p.write_text(s2)
            patched += 1
            print("✅ added useRouter import:", p)
        continue

    # No next/navigation import: insert one after "use client" (or at top)
    ins = 0
    m_uc = re.search(r"^['\"]use client['\"];?\s*$", s, re.M)
    if m_uc:
        ins = m_uc.end()
        insert = "\n\nimport { useRouter } from \"next/navigation\";\n"
    else:
        insert = "import { useRouter } from \"next/navigation\";\n"

    s2 = s[:ins] + insert + s[ins:]
    p.write_text(s2)
    patched += 1
    print("✅ inserted next/navigation import:", p)

print(f"✅ done. patched_files={patched}")
PY

echo "==> Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 ) &
sleep 1

echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
