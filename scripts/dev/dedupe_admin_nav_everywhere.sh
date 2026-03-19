#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

REPO="$HOME/peakops/my-app"
NEXT="$REPO/next-app"

FILES=(
  "$NEXT/src/app/admin/contracts/page.tsx"
  "$NEXT/src/app/admin/contracts/[id]/page.tsx"
  "$NEXT/src/app/admin/contracts/[id]/payloads/page.tsx"
  "$NEXT/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
  "$NEXT/src/app/admin/contracts/[id]/packet/page.tsx"
)

python3 - <<'PY'
from pathlib import Path
import re

repo = Path.home()/"peakops/my-app"
files = [
  repo/"next-app/src/app/admin/contracts/page.tsx",
  repo/"next-app/src/app/admin/contracts/[id]/page.tsx",
  repo/"next-app/src/app/admin/contracts/[id]/payloads/page.tsx",
  repo/"next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx",
  repo/"next-app/src/app/admin/contracts/[id]/packet/page.tsx",
]

def ensure_import(s: str) -> str:
  if 'import AdminNav from "../_components/AdminNav";' in s:
    return s
  if 'import AdminNav from "../../_components/AdminNav";' in s:
    return s
  # infer relative path based on file depth
  # contracts/page.tsx -> ../_components/AdminNav
  # contracts/[id]/page.tsx -> ../../_components/AdminNav
  # contracts/[id]/payloads/page.tsx -> ../../../_components/AdminNav
  # contracts/[id]/payloads/[payloadId]/page.tsx -> ../../../../_components/AdminNav
  # contracts/[id]/packet/page.tsx -> ../../../_components/AdminNav
  rel = "../_components/AdminNav"
  if "/contracts/[id]/payloads/[payloadId]/" in str(p):
    rel = "../../../../_components/AdminNav"
  elif "/contracts/[id]/payloads/" in str(p):
    rel = "../../../_components/AdminNav"
  elif "/contracts/[id]/packet/" in str(p):
    rel = "../../../_components/AdminNav"
  elif "/contracts/[id]/" in str(p):
    rel = "../../_components/AdminNav"

  if '"use client";' in s and "AdminNav" not in s:
    s = s.replace('"use client";\n\n', f'"use client";\n\nimport AdminNav from "{rel}";\n')
  return s

def add_org_normalize(s: str) -> str:
  # make sure orgId never ends up undefined, and URL always has orgId
  if "useSearchParams" not in s:
    return s
  if "useRouter" not in s:
    s = s.replace('import { useSearchParams } from "next/navigation";',
                  'import { useRouter, useSearchParams } from "next/navigation";')
  if "const router = useRouter();" not in s:
    # place router after orgId line if we can
    s = re.sub(r'(const orgId\s*=\s*[^;]+;)', r'\1\n  const router = useRouter();', s, count=1)

  if "Normalize URL: always keep orgId in query" in s:
    return s

  # insert normalize effect after router line
  s = re.sub(
    r'(const router = useRouter\(\);\n)',
    r'\1  // Normalize URL: always keep orgId in query (prevents orgId=undefined calls)\n'
    r'  useEffect(() => {\n'
    r'    const cur = sp.get("orgId");\n'
    r'    if (!cur) router.replace(`${location.pathname}?orgId=${encodeURIComponent(orgId)}`);\n'
    r'  }, [orgId]); // eslint-disable-line\n\n',
    s,
    count=1
  )
  return s

def ensure_adminnav_render(s: str) -> str:
  if "<AdminNav" in s:
    return s
  # add AdminNav right after outer wrapper div (first one)
  s = s.replace(
    'return (\n    <div style={{ padding: 24,',
    'return (\n    <div style={{ padding: 24,\n      <AdminNav orgId={orgId} contractId={typeof contractId === "string" ? contractId : undefined} versionId={sp.get("versionId") || undefined} />\n'
  )
  return s

def remove_duplicate_local_nav(s: str) -> str:
  # remove obvious duplicated button rows we previously injected:
  # - duplicate “Contracts / Contract Overview / Payloads / Packet Preview / ⌘K Jump”
  #   (keep AdminNav; delete extra occurrences)
  # heuristic: if page has multiple occurrences of 'Contract Overview' pills, delete the earliest block
  if s.count("Contract Overview") <= 1 and s.count("Packet Preview") <= 1 and s.count("⌘K") <= 1:
    return s

  # remove duplicate blocks that look like the pill row (very specific markers)
  pill_block = re.compile(r'<div[^>]*>\s*\{\s*items\.map\(x\s*=>\s*\([\s\S]*?Packet Preview[\s\S]*?<\/div>\s*\)\s*;\s*}\s*<\/div>\s*;\s*}\s*', re.M)
  # if that doesn't match, do a simpler delete: remove a duplicated inline nav section if present twice
  # Remove second "Contracts / Contract Overview / Payloads / Packet Preview" row by deleting the first occurrence of those four labels as buttons/links when two exist.
  # We'll just collapse consecutive duplicate pill bars:
  # Replace two consecutive occurrences of "Contracts Contract Overview Payloads Packet Preview" markup with one.
  s = re.sub(r'(Contracts[\s\S]*?Contract Overview[\s\S]*?Payloads[\s\S]*?Packet Preview[\s\S]*?)(\1)', r'\1', s, count=1)
  return s

def fix_contracts_list_limit(s: str) -> str:
  # your log shows /api/fn/getContractsV1 ... limit=50 resulting 400
  # set to limit=5 unless explicitly overridden
  s = s.replace('/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=50',
                '/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=5')
  s = s.replace('/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=10',
                '/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=5')
  return s

for p in files:
  if not p.exists():
    continue
  s = p.read_text()
  before = s

  # per-file relative import
  # (set global p for ensure_import inference)
  globals()["p"] = p

  s = ensure_import(s)
  s = fix_contracts_list_limit(s)
  s = add_org_normalize(s)
  s = ensure_adminnav_render(s)
  s = remove_duplicate_local_nav(s)

  if s != before:
    p.write_text(s)
    print("✅ patched:", p)

print("✅ done")
PY

echo "==> Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 ) &
sleep 1

echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
