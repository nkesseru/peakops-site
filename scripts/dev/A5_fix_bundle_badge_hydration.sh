#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"

echo "==> Fixing bundle badge hydration (bulletproof pass)"
echo "==> File: $FILE"

if [[ ! -f "$FILE" ]]; then
  echo "❌ File not found"
  exit 1
fi

cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup created"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Remove duplicated hydrateZipVerification lines
s = re.sub(
    r'\n\s*void hydrateZipVerification\(\);\s*\n\s*void hydrateZipVerification\(\);\s*',
    '\n    void hydrateZipVerification();\n',
    s,
    flags=re.MULTILINE
)

# 2) Remove ANY extra bootstrap badge effects (keep one)
effects = list(re.finditer(
    r'useEffect\(\(\)\s*=>\s*\{[^}]*loadPacketMeta\(\);[^}]*\}\s*,\s*\[[^\]]*\]\s*\);',
    s,
    flags=re.DOTALL
))

if len(effects) > 1:
    # keep first, remove rest
    keep = effects[0].span()
    out = s[:keep[1]]
    for e in effects[1:]:
        out += s[e.end():]
    s = out

# 3) Normalize single authoritative effect
CANONICAL_EFFECT = '''
  // BOOTSTRAP_BADGES_FINAL (authoritative)
  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateIncidentLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);
'''

# Replace existing bootstrap with canonical one
s = re.sub(
    r'useEffect\(\(\)\s*=>\s*\{[^}]*loadPacketMeta\(\);[^}]*\}\s*,\s*\[[^\]]*\]\s*\);',
    CANONICAL_EFFECT.strip(),
    s,
    count=1,
    flags=re.DOTALL
)

# 4) Clean excessive blank lines
s = re.sub(r'\n{4,}', '\n\n\n', s)

p.write_text(s)
print("✅ bundle/page.tsx badge hydration fixed")
PY

echo "🎯 Done. Restart Next to apply."
