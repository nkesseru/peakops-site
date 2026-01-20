#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
ENV_FILE="next-app/.env.local"
LOGDIR=".logs"
mkdir -p "$LOGDIR"

test -f "$PAGE" || { echo "❌ missing $PAGE"; exit 1; }

echo "==> (1) Ensure next-app/.env.local has emulator vars"
mkdir -p next-app
touch "$ENV_FILE"

upsert_env () {
  local key="$1"
  local val="$2"
  if rg -n "^${key}=" "$ENV_FILE" >/dev/null 2>&1; then
    perl -0777 -i -pe "s/^${key}=.*\$/${key}=${val}/m" "$ENV_FILE"
  else
    printf "\n%s=%s\n" "$key" "$val" >> "$ENV_FILE"
  fi
}

upsert_env "FIRESTORE_EMULATOR_HOST" "127.0.0.1:8080"
upsert_env "FIREBASE_FUNCTIONS_EMULATOR_HOST" "127.0.0.1:5001"
upsert_env "FIREBASE_PROJECT_ID" "peakops-pilot"
# optional helper var if you ever want it
upsert_env "FIRESTORE_EMULATOR_REST" "http://127.0.0.1:8080"

echo "✅ wrote $ENV_FILE (tail)"
tail -n 10 "$ENV_FILE" || true

echo
echo "==> (2) Backup + patch bundle page (sticky immutable + bootstrap)"
cp "$PAGE" "$PAGE.bak_sticky_badges_v4_$(date +%Y%m%d_%H%M%S)"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# --- A) Prevent clobbering immutable when packetMeta response doesn't include immutable ---
# Replace: setImmutable(!!j.immutable);
# With: only set if boolean
pattern = r"setImmutable\(\!\!j\.immutable\);\s*"
repl = "if (typeof (j as any).immutable === \"boolean\") setImmutable(!!(j as any).immutable);\n"
s2, n1 = re.subn(pattern, repl, s)
if n1 == 0:
  # sometimes spacing differs
  pattern2 = r"setImmutable\(\!\!\s*j\.immutable\);\s*"
  s2, n1b = re.subn(pattern2, repl, s)
  n1 += n1b

s = s2

# --- B) Ensure hydrateLock exists (safe insert if missing) ---
if "async function hydrateLock()" not in s:
  insert_after = s.find("async function hydrateZipVerification()")
  if insert_after == -1:
    raise SystemExit("❌ could not find hydrateZipVerification() to anchor hydrateLock() insertion")

  hydrate_lock = r'''
  async function hydrateLock() {
    try {
      const u =
        `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(u, { method: "GET" });
      const j = await r.json().catch(() => null);
      if (j?.ok && typeof j.immutable === "boolean") setImmutable(!!j.immutable);
    } catch {
      // swallow
    }
  }

'''
  s = s[:insert_after] + hydrate_lock + s[insert_after:]

# --- C) Ensure bootstrap useEffect calls all hydrators on mount/id change ---
# We want:
# useEffect(() => {
#   void loadPacketMeta();
#   void hydrateZipVerification();
#   void hydrateLock();
# }, [orgId, incidentId]);
#
# We'll insert it once near the top of the component after state declarations.

if "BOOTSTRAP_BADGES" not in s:
  # try to inject after the last state block near zipVerified/manifest
  anchor = "const [manifestItems, setManifestItems]"
  idx = s.find(anchor)
  if idx == -1:
    # fallback: after zipVerified state
    anchor = "const [zipVerified, setZipVerified]"
    idx = s.find(anchor)
    if idx == -1:
      raise SystemExit("❌ could not find state anchor for bootstrap injection")

  # insert after the line containing anchor
  line_end = s.find("\n", idx)
  if line_end == -1:
    raise SystemExit("❌ unexpected file formatting near state anchor")

  bootstrap = r'''

  // BOOTSTRAP_BADGES: hydrate meta + zip verification + immutable lock on every mount / id change
  useEffect(() => {
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

'''
  s = s[:line_end+1] + bootstrap + s[line_end+1:]

p.write_text(s)
print(f"✅ patched page.tsx: immutable-clobber fix ({n1} replacements) + hydrateLock + bootstrap")
PY

echo
echo "==> (3) Restart Next cleanly"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo
echo "==> (4) Sanity checks"
curl -sS "http://127.0.0.1:3000/api/fn/getIncidentLockV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80 || true
echo
curl -sS "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 120 || true

echo
echo "✅ Open:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" 2>/dev/null || true

echo
echo "NEXT:"
echo "  1) Hard refresh (Cmd+Shift+R)"
echo "  2) Immutable + ZIP Verified badges should stay ON"
echo "LOG:"
echo "  tail -n 200 $LOGDIR/next.log"
