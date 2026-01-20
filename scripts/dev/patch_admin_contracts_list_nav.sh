#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

REPO="$HOME/peakops/my-app"
FILE="$REPO/next-app/src/app/admin/contracts/page.tsx"

python3 - <<'PY'
from pathlib import Path
p = Path(Path.home()/"peakops/my-app/next-app/src/app/admin/contracts/page.tsx")
s = p.read_text()
if "from \"../_components/AdminNav\"" not in s and "from '../_components/AdminNav'" not in s:
    s = s.replace('"use client";\n\n', '"use client";\n\nimport AdminNav from "../_components/AdminNav";\n')
needle = 'const orgId = sp.get("orgId") || "org_001";'
if needle in s and "sp.get(\"orgId\")" in s and "router.replace" not in s:
    # add router import
    if 'useRouter' not in s:
        s = s.replace('import { useSearchParams } from "next/navigation";',
                      'import { useRouter, useSearchParams } from "next/navigation";')
    # add router + redirect effect
    s = s.replace(needle, needle + '\n  const router = useRouter();\n')
    # insert useEffect to normalize URL (right after orgId/router)
    insert_after = needle + '\n  const router = useRouter();\n'
    if "Normalize URL" not in s:
        s = s.replace(insert_after, insert_after + """
  // Normalize URL: always keep orgId in query (prevents orgId=undefined calls)
  useEffect(() => {
    const cur = sp.get("orgId");
    if (!cur) router.replace(`/admin/contracts?orgId=${encodeURIComponent(orgId)}`);
  }, [orgId]); // eslint-disable-line
""")
if "<AdminNav" not in s:
    s = s.replace('return (\n    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>',
                  'return (\n    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>\n      <AdminNav orgId={orgId} />')

p.write_text(s)
print("✅ patched admin contracts list: AdminNav + orgId URL normalize")
PY

echo "✅ done"
