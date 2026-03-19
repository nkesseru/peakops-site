#!/usr/bin/env bash
set -euo pipefail

# zsh safety (no glob explosions on [id])
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ Missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_immutable_sticky_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_immutable_sticky_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Do NOT allow packetMeta fetch to overwrite immutable=false.
# Replace any "setImmutable(!!j.immutable)" with "if (j.immutable) setImmutable(true)"
n1 = 0
def repl(m):
    global n1
    n1 += 1
    return "if (j.immutable) setImmutable(true);"

s2 = re.sub(r"setImmutable\(\s*!!\s*j\.immutable\s*\)\s*;", repl, s)

# Also catch "setImmutable(!!j.immutable)" without semicolon (just in case)
s2, n2 = re.subn(r"setImmutable\(\s*!!\s*j\.immutable\s*\)", "j.immutable && setImmutable(true)", s2)

# 2) Make sure hydrateLock promotes immutable when true (and does NOT force false elsewhere)
# If hydrateLock exists but uses !!j.immutable, keep it (it’s fine).
# We only ensure it calls setImmutable(true) when immutable true.
if "async function hydrateLock" in s2:
    # If hydrateLock sets immutable directly, make it monotonic: only set true.
    # Replace: setImmutable(!!j.immutable) with: if (j.immutable) setImmutable(true)
    s2, n3 = re.subn(
        r"setImmutable\(\s*!!\s*j\.immutable\s*\)\s*;",
        "if (j.immutable) setImmutable(true);",
        s2
    )
else:
    print("⚠️ hydrateLock() not found. Not creating it automatically (risk).")

# 3) Ensure bootstrap effect calls hydrateLock (monotonic) on mount/id change.
# Look for your BOOTSTRAP_BADGES block or useEffect and ensure hydrateLock is called.
if "BOOTSTRAP_BADGES" in s2:
    # best-effort: ensure "void hydrateLock();" exists near the bootstrap effect
    if re.search(r"BOOTSTRAP_BADGES[\s\S]{0,800}hydrateLock\(\)", s2) is None:
        s2 = s2.replace("BOOTSTRAP_BADGES", "BOOTSTRAP_BADGES\n  // NOTE: ensure hydrateLock() runs so Immutable stays sticky\n")
        # try to inject after a known call
        s2, n4 = re.subn(r"(void\s+hydrateZipVerification\(\)\s*;)", r"\1\n  void hydrateLock();", s2, count=1)
        if n4 == 0:
            print("⚠️ Could not auto-inject hydrateLock() into bootstrap useEffect. Please confirm manually.")
else:
    print("⚠️ BOOTSTRAP_BADGES marker not found; skipping bootstrap injection.")

p.write_text(s2)
print(f"✅ patched page.tsx: immutable is now monotonic (only ever flips TRUE). replacements: setImmutable->if(j.immutable): {n1}, extra: {n2}")
PY

echo "🧹 clearing Next cache"
rm -rf next-app/.next 2>/dev/null || true
mkdir -p .logs

echo "🚀 restarting Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> sanity: lock endpoint"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentLockV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 60 || true

echo
echo "✅ Open:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" 2>/dev/null || true

echo
echo "NEXT:"
echo "  1) Hard refresh (Cmd+Shift+R)"
echo "  2) Immutable badge should stay ON"
echo "LOG:"
echo "  tail -n 120 .logs/next.log"
