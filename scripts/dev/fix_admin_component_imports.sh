#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

ROOT="next-app/src/app/admin"
ADMIN_DIR="next-app/src/app/admin/_components"

if [ ! -f "$ADMIN_DIR/AdminNav.tsx" ]; then
  echo "❌ missing: $ADMIN_DIR/AdminNav.tsx"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
import os, re

root = Path("next-app/src/app/admin")
admin_components = root / "_components"

def rel(from_dir: Path, to_path: Path) -> str:
    rp = os.path.relpath(to_path, from_dir).replace("\\", "/")
    if not rp.startswith("."):
        rp = "./" + rp
    # strip .tsx/.ts
    rp = re.sub(r"\.(tsx|ts)$", "", rp)
    return rp

targets = []
for p in root.rglob("*.ts*"):
    if p.name.endswith((".ts", ".tsx")):
        s = p.read_text(errors="ignore")
        if "import AdminNav" in s or "import PrettyJson" in s:
            targets.append(p)

changed = 0
for p in targets:
    s = p.read_text()
    from_dir = p.parent

    admin_nav_path = rel(from_dir, admin_components / "AdminNav.tsx")
    pretty_json_path = rel(from_dir, admin_components / "PrettyJson.tsx")

    s2 = s

    # AdminNav
    s2 = re.sub(
        r'^\s*import\s+AdminNav\s+from\s+["\'][^"\']+["\']\s*;\s*$',
        f'import AdminNav from "{admin_nav_path}";',
        s2,
        flags=re.M
    )

    # PrettyJson (only if component exists)
    if (admin_components / "PrettyJson.tsx").exists():
        s2 = re.sub(
            r'^\s*import\s+PrettyJson\s+from\s+["\'][^"\']+["\']\s*;\s*$',
            f'import PrettyJson from "{pretty_json_path}";',
            s2,
            flags=re.M
        )

    if s2 != s:
        p.write_text(s2)
        changed += 1
        print(f"✅ patched imports: {p}")

print(f"\n✅ done. files changed: {changed}")
PY

echo
echo "==> restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke contract detail"
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123?orgId=org_001" >/dev/null \
  && echo "✅ contract page loads" \
  || { echo "❌ still failing"; tail -n 120 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
