#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE='next-app/src/app/admin/incidents/[id]/bundle/page.tsx'
BK="scripts/dev/_bak"
mkdir -p "$BK"
cp "$FILE" "$BK/bundle_page_pre_B1_$(date +%Y%m%d_%H%M%S).tsx"
echo "✅ backup: $BK/bundle_page_pre_B1_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Remove any literal "\n" artifacts that can break TS parsing (defensive)
s = s.replace("\\n", "")

# 2) Ensure orgId/incidentId declarations exist near top of component BEFORE any useEffect uses them.
# We'll locate: export default function BundlePage() { ... and insert/normalize directly after params/sp.
m_func = re.search(r"export\s+default\s+function\s+BundlePage\s*\(\)\s*\{\s*", s)
if not m_func:
    raise SystemExit("❌ Could not find BundlePage() function")

# Find existing orgId/incidentId lines (if any)
m_org = re.search(r"^\s*const\s+orgId\s*=\s*String\(", s, flags=re.M)
m_inc = re.search(r"^\s*const\s+incidentId\s*=\s*String\(", s, flags=re.M)

# We'll build a canonical "ids block" right after params/sp definitions if they exist, otherwise right after function open.
CANON_IDS = """
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = String(sp.get("orgId") || "org_001");
  const incidentId = String(params?.id || "inc_TEST");
  const contractId = String(sp.get("contractId") || "");
"""

# Try to anchor after params/sp lines if present
m_params = re.search(r"^\s*const\s+params\s*=\s*useParams\(\)[^;]*;\s*$", s, flags=re.M)
m_sp = re.search(r"^\s*const\s+sp\s*=\s*useSearchParams\(\)[^;]*;\s*$", s, flags=re.M)

if m_params and m_sp and m_sp.start() > m_params.start():
    # Remove any existing orgId/incidentId/contractId consts to prevent duplicates
    s = re.sub(r"^\s*const\s+orgId\s*=.*\n", "", s, flags=re.M)
    s = re.sub(r"^\s*const\s+incidentId\s*=.*\n", "", s, flags=re.M)
    s = re.sub(r"^\s*const\s+contractId\s*=.*\n", "", s, flags=re.M)

    # Also normalize params/sp lines (remove them so we can re-insert clean)
    s = re.sub(r"^\s*const\s+params\s*=.*\n", "", s, flags=re.M)
    s = re.sub(r"^\s*const\s+sp\s*=.*\n", "", s, flags=re.M)

    # Insert canonical block right after function open
    idx = m_func.end()
    s = s[:idx] + CANON_IDS + s[idx:]
else:
    # Same approach: ensure no duplicates, insert after function open
    s = re.sub(r"^\s*const\s+orgId\s*=.*\n", "", s, flags=re.M)
    s = re.sub(r"^\s*const\s+incidentId\s*=.*\n", "", s, flags=re.M)
    s = re.sub(r"^\s*const\s+contractId\s*=.*\n", "", s, flags=re.M)
    idx = m_func.end()
    s = s[:idx] + CANON_IDS + s[idx:]

# 3) Remove duplicate bootstrap effects that call loadPacketMeta/hydrateZipVerification/hydrateLock
# Keep only ONE later.
effect_pat = re.compile(r"useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\);\s*", re.M)
effects = list(effect_pat.finditer(s))
keep = []
for e in effects:
    block = e.group(0)
    if "loadPacketMeta" in block and ("hydrateZipVerification" in block or "hydrateLock" in block):
        keep.append(e)

# If multiple such effects, remove them all (we'll insert one canonical)
if len(keep) >= 1:
    for e in reversed(keep):
        s = s[:e.start()] + s[e.end():]

# 4) Insert ONE authoritative bootstrap effect AFTER state setters & helpers exist?
# In this file, loadPacketMeta/hydrateZipVerification/hydrateLock are functions below. It's fine to reference them
# as long as orgId/incidentId exist. We'll place this after the state declarations for clarity.
# Find the first occurrence of: const [toasts, setToasts] = useState...
m_state = re.search(r"^\s*const\s+\[\s*toasts\s*,\s*setToasts\s*\]\s*=\s*useState", s, flags=re.M)
if not m_state:
    # fallback: after ids block insertion (contractId line)
    m_state = re.search(r"^\s*const\s+contractId\s*=.*\n", s, flags=re.M)

CANON_EFFECT = """
  // BOOTSTRAP_BADGES_BULLETPROOF: one source of truth on mount/id change
  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);
"""

if m_state:
    insert_at = m_state.end()
    s = s[:insert_at] + "\n" + CANON_EFFECT + s[insert_at:]
else:
    # extreme fallback: after ids block
    m_ids_end = re.search(r"const\s+contractId\s*=.*\n", s)
    if m_ids_end:
        s = s[:m_ids_end.end()] + "\n" + CANON_EFFECT + s[m_ids_end.end():]
    else:
        raise SystemExit("❌ Could not find a safe insertion point for bootstrap effect")

# 5) Cleanup silly blank runs
s = re.sub(r"\n{4,}", "\n\n\n", s)

p.write_text(s)
print("✅ bundle/page.tsx: bulletproof ids + single bootstrap effect")
PY

echo "==> Restart Next (clean cache)"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
pkill -f "next dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
rm -f .logs/next.log
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> Smoke: bundle page 200?"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 12 || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
