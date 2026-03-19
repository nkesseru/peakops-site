#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # disable zsh history expansion if invoked via zsh

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
mkdir -p .logs
cp "$FILE" "$FILE.bak_bootstrap_order_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $FILE.bak_bootstrap_order_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Remove any previously injected BOOTSTRAP_BADGES blocks (regardless of version)
#    We remove from the comment line through the end of that useEffect block.
s2 = re.sub(
    r"\n\s*//\s*BOOTSTRAP_BADGES[^\n]*\n\s*useEffect\(\(\)\s*=>\s*\{\n(?:.|\n)*?\n\s*\},\s*\[[^\]]*\]\s*\);\n",
    "\n",
    s,
    flags=re.M
)

# 2) Insert a clean bootstrap AFTER incidentId is declared (prevents TDZ)
#    Anchor on: const incidentId = String(params?.id || "inc_TEST");
m = re.search(r"^\s*const\s+incidentId\s*=\s*String\([^\n]*\);\s*$", s2, flags=re.M)
if not m:
    # fallback: anchor on params id usage
    m = re.search(r"^\s*const\s+incidentId\s*=.*params\?\.id.*;\s*$", s2, flags=re.M)

if not m:
    raise SystemExit("❌ Could not find incidentId declaration line to anchor bootstrap insertion.")

BOOT = """
  // BOOTSTRAP_BADGES_V6: hydrate lock + zip verification + packet meta AFTER ids exist
  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);
"""

insert_at = m.end()
s3 = s2[:insert_at] + "\n" + BOOT + s2[insert_at:]

# tidy excessive blank lines
s3 = re.sub(r"\n{4,}", "\n\n\n", s3)

p.write_text(s3)
print("✅ fixed bundle bootstrap order (no TDZ)")
PY

echo "🧹 restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
pkill -f "next dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
rm -f .logs/next.log
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: bundle page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 10 || true
echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
