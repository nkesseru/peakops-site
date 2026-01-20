#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
cp "$FILE" "$FILE.bak_badgesboot_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $FILE.bak_badgesboot_*"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

BOOT = """
  // BOOTSTRAP_BADGES_V1: keep badges sticky by hydrating truth on mount
  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);
"""

if "BOOTSTRAP_BADGES_V1" in s:
    print("ℹ️ bootstrap already present")
else:
    # Insert right after the *first* occurrence of hydrateLock definition callsite area,
    # OR after the state declarations block (best-effort).
    # We’ll anchor on the first time we see: `const [orgId` OR `const orgId`
    anchor = "const orgId"
    idx = s.find(anchor)
    if idx == -1:
        anchor = "const [orgId"
        idx = s.find(anchor)

    if idx == -1:
        # fallback: after "use client" line if present
        uidx = s.find('"use client"')
        if uidx != -1:
            line_end = s.find("\n", uidx)
            s = s[:line_end+1] + BOOT + s[line_end+1:]
        else:
            # last resort: prepend
            s = BOOT + "\n" + s
    else:
        # insert after the line containing orgId declaration
        line_end = s.find("\n", idx)
        s = s[:line_end+1] + BOOT + s[line_end+1:]

    # Ensure useEffect is imported
    if "useEffect" not in s.split("from")[0] and "useEffect" not in s:
        pass

p.write_text(s)
print("✅ injected badge bootstrap")
PY

echo "<0001f9f9> restart Next (clean cache)"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: bundle page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 10 || true

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" >/dev/null 2>&1 || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
