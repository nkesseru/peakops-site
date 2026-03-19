#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE (run from ~/peakops/my-app)"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_attention_${ts}"
echo "✅ backup -> $FILE.bak_attention_${ts}"

python3 - <<'PY'
import re
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Where we want the derived vars to live: right before the Attention section.
anchor = re.search(r'^\s*//\s*---\s*Attention items\b.*$', s, flags=re.M)
if not anchor:
    raise SystemExit("Could not find '// --- Attention items' anchor")

insert_at = anchor.start()

# Try to find the existing derived-vars block (it usually looks like this).
block_re = re.compile(
    r'^\s*const\s+incident\s*=\s*bundle\?\.(incident)\s*\?\?\s*null;\s*\n'
    r'^\s*const\s+filings\s*=\s*useMemo\([\s\S]*?\);\s*\n'
    r'^\s*const\s+logs\s*=\s*bundle\?\.(logs)\s*\?\?\s*null;\s*\n'
    r'^\s*const\s+filingsMeta\s*=\s*incident\?\.(filingsMeta)\s*\?\?\s*null;\s*\n'
    r'^\s*const\s+timelineMeta\s*=\s*bundle\?\.(timelineMeta)\s*\?\?\s*null;\s*\n',
    flags=re.M
)

m = block_re.search(s)

# If we found it, remove it (so we don't duplicate) and re-insert at the right place.
if m:
    block = m.group(0)
    s = s[:m.start()] + s[m.end():]
else:
    # If it doesn't exist (or was mangled), recreate it safely.
    block = (
        "  const incident = bundle?.incident ?? null;\n"
        "  const filings = useMemo(() => (bundle?.filings ?? []), [bundle]);\n"
        "  const logs = bundle?.logs ?? null;\n"
        "  const filingsMeta = incident?.filingsMeta ?? null;\n"
        "  const timelineMeta = bundle?.timelineMeta ?? null;\n\n"
    )

# Insert right before attention items
s = s[:insert_at] + block + s[insert_at:]

p.write_text(s)
print("✅ moved/created derived vars block above Attention items")
PY

echo "==> quick sanity: 'incident' should exist before attentionItems"
rg -n "const incident =|// --- Attention items|const attentionItems" "$FILE" | head -n 40 || true

echo "==> restart Next on :3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
cd next-app
pnpm dev --port 3000
