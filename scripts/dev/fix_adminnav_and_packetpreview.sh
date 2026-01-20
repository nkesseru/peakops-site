#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

FILES=(
  "next-app/src/app/admin/contracts/page.tsx"
  "next-app/src/app/admin/contracts/[id]/page.tsx"
  "next-app/src/app/admin/contracts/[id]/payloads/page.tsx"
  "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx"
)

python3 - <<'PY'
from pathlib import Path

# Correct AdminNav import per file depth
ADMINNAV_IMPORT = {
  "next-app/src/app/admin/contracts/page.tsx": "import AdminNav from '../_components/AdminNav';\n",
  "next-app/src/app/admin/contracts/[id]/page.tsx": "import AdminNav from '../../_components/AdminNav';\n",
  "next-app/src/app/admin/contracts/[id]/payloads/page.tsx": "import AdminNav from '../../../_components/AdminNav';\n",
  "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx": "import AdminNav from '../../../../_components/AdminNav';\n",
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx": "import AdminNav from '../../../_components/AdminNav';\n",
}

def ensure_adminnav_import(s: str, desired_line: str) -> str:
  # Remove any existing AdminNav import line
  lines = [ln for ln in s.splitlines(True) if "import AdminNav" not in ln]
  s2 = "".join(lines)

  # Insert after "use client" if present, else after first import block start
  insert_at = 0
  if s2.lstrip().startswith('"use client"') or s2.lstrip().startswith("'use client'"):
    # place after the use client line + following newline
    idx = s2.find("\n")
    insert_at = idx + 1 if idx != -1 else 0
  else:
    insert_at = 0

  return s2[:insert_at] + desired_line + s2[insert_at:]

def ensure_useRouter_import_in_packet(s: str) -> str:
  # Only applies if file imports from next/navigation
  # Ensure useRouter is included in that import list.
  import_marker = "from \"next/navigation\""
  if import_marker not in s:
    import_marker = "from 'next/navigation'"
    if import_marker not in s:
      return s

  # Find the import line(s) for next/navigation
  lines = s.splitlines(True)
  out = []
  for ln in lines:
    if "from \"next/navigation\"" in ln or "from 'next/navigation'" in ln:
      if "useRouter" in ln:
        out.append(ln)
      else:
        # add useRouter into the braces
        if "{" in ln and "}" in ln:
          inside = ln.split("{",1)[1].split("}",1)[0].strip()
          parts = [p.strip() for p in inside.split(",") if p.strip()]
          parts.append("useRouter")
          # de-dupe while preserving order
          seen=set(); parts2=[]
          for p in parts:
            if p not in seen:
              seen.add(p); parts2.append(p)
          new_inside = ", ".join(parts2)
          ln = ln.split("{",1)[0] + "{ " + new_inside + " } " + ln.split("}",1)[1]
        out.append(ln)
    else:
      out.append(ln)
  return "".join(out)

def fix_packet_preview_stray_brace(s: str) -> str:
  # Your log shows: const cur = sp.get("orgId"); {
  s = s.replace('const cur = sp.get("orgId"); {', 'const cur = sp.get("orgId");')
  s = s.replace("const cur = sp.get('orgId'); {", "const cur = sp.get('orgId');")
  return s

def fix_contracts_list_limit(s: str) -> str:
  # Revert any limit=5 hardcode to 50 to avoid 400s
  s = s.replace("&limit=5", "&limit=50")
  s = s.replace("&limit=10", "&limit=50")
  return s

for fp, import_line in ADMINNAV_IMPORT.items():
  p = Path(fp)
  if not p.exists():
    continue
  before = p.read_text()
  s = before
  s = ensure_adminnav_import(s, import_line)

  if fp.endswith("/packet/page.tsx"):
    s = ensure_useRouter_import_in_packet(s)
    s = fix_packet_preview_stray_brace(s)

  if fp.endswith("/admin/contracts/page.tsx"):
    s = fix_contracts_list_limit(s)

  if s != before:
    p.write_text(s)
    print("✅ patched:", fp)

print("✅ done")
PY

echo "==> Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 ) &
sleep 1

echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
