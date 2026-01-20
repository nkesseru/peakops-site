#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
LOGDIR=".logs"
mkdir -p "$LOGDIR"

if [[ ! -f "$PAGE" ]]; then
  echo "❌ missing file: $PAGE"
  exit 1
fi

cp "$PAGE" "$PAGE.bak_fix_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_fix_*"

python3 - <<'PY'
from pathlib import Path
import re
p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# --- 1) Normalize/remove duplicate busy declarations ---
# Match lines like:
# const [busy, setBusy] = useState(false);
# const [busy, setBusy] = React.useState<string>("");
busy_pat = re.compile(
    r'^[ \t]*const[ \t]+\[[ \t]*busy[ \t]*,[ \t]*setBusy[ \t]*\][ \t]*=[ \t]*(?:React\.)?useState(?:<[^>]*>)?\([^\)]*\)[ \t]*;[ \t]*$',
    re.MULTILINE
)
busy_matches = list(busy_pat.finditer(s))
if len(busy_matches) > 1:
    # keep first, remove the rest (bottom-up)
    for m in reversed(busy_matches[1:]):
        start, end = m.start(), m.end()
        if end < len(s) and s[end:end+1] == "\n":
            end += 1
        s = s[:start] + s[end:]
    print(f"✅ removed {len(busy_matches)-1} duplicate busy declarations")
else:
    print(f"✅ busy declarations OK (count={len(busy_matches)})")

# --- 2) Ensure immutable state exists ---
# If immutable is referenced but not declared, add:
# const [immutable, setImmutable] = React.useState<boolean>(false);
has_setImmutable = ("setImmutable" in s)
has_immutable_state = re.search(r'const\s+\[\s*immutable\s*,\s*setImmutable\s*\]\s*=', s) is not None

if not has_immutable_state:
    # Insert after orgId/incidentId declarations if present, else after first few useState lines.
    insert_point = None

    # Prefer after incidentId line
    m = re.search(r'^\s*const\s+incidentId\s*=.*?;\s*$', s, re.MULTILINE)
    if m:
        insert_point = m.end()
    else:
        # fallback: after orgId line
        m = re.search(r'^\s*const\s+orgId\s*=.*?;\s*$', s, re.MULTILINE)
        if m:
            insert_point = m.end()
        else:
            # fallback: after first useState line
            m = re.search(r'^\s*const\s+\[.*?\]\s*=\s*(?:React\.)?useState', s, re.MULTILINE)
            insert_point = m.end() if m else 0

    ins = "\n  const [immutable, setImmutable] = React.useState<boolean>(false);\n"
    s = s[:insert_point] + ins + s[insert_point:]
    print("✅ inserted immutable state")
else:
    print("✅ immutable state already present")

# --- 3) Ensure hydrateLock() exists (idempotent) ---
if "async function hydrateLock()" not in s:
    # Put helper right after orgId/incidentId block (best-effort)
    m = re.search(r'^\s*const\s+incidentId\s*=.*?;\s*$', s, re.MULTILINE)
    anchor = m.end() if m else 0
    helper = r'''
  async function hydrateLock() {
    try {
      const u = `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(u, { method: "GET" });
      const j = await r.json().catch(() => null);
      if (j?.ok && typeof j.immutable === "boolean") setImmutable(!!j.immutable);
    } catch {
      // swallow
    }
  }

'''
    s = s[:anchor] + helper + s[anchor:]
    print("✅ added hydrateLock()")
else:
    print("✅ hydrateLock() already present")

# --- 4) Ensure a useEffect calls hydrateLock on mount/id change ---
if "hydrateLock();" not in s and "void hydrateLock();" not in s:
    # Try to inject into first existing useEffect body
    m = re.search(r'(React\.)?useEffect\s*\(\s*\(\s*\)\s*=>\s*\{', s)
    if m:
        ins_at = m.end()
        s = s[:ins_at] + "\n    void hydrateLock();\n" + s[ins_at:]
        print("✅ injected hydrateLock() call into existing useEffect")
    else:
        # Create a new useEffect after immutable state declaration
        m2 = re.search(r'const\s+\[\s*immutable\s*,\s*setImmutable\s*\].*?;\s*', s)
        if not m2:
            raise SystemExit("❌ could not find immutable state to anchor useEffect")
        usefx = r'''
  React.useEffect(() => {
    void hydrateLock();
  }, [orgId, incidentId]);

'''
        s = s[:m2.end()] + usefx + s[m2.end():]
        print("✅ created useEffect for hydrateLock()")
else:
    print("✅ hydrateLock() call already present")

p.write_text(s)
print("✅ wrote page.tsx updates")
PY

echo "🧹 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: incident page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 5 || true

echo
echo "✅ open incident page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
