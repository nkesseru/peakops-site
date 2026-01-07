#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Ensure AdminNav component exists + is safe (no missing-org errors)"
mkdir -p next-app/src/app/admin/_components

cat > next-app/src/app/admin/_components/AdminNav.tsx <<'TSX'
"use client";

import { useMemo } from "react";

type Props = {
  orgId: string;
  contractId?: string | null;
  versionId?: string | null;
  active?: "contracts" | "contract" | "payloads" | "packet" | "editor" | string;
};

function btnStyle(active: boolean) {
  return {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    textDecoration: "none",
    fontWeight: 800 as const,
    fontSize: 12,
    lineHeight: "16px",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    opacity: 0.95
  };
}

export default function AdminNav({ orgId, contractId, versionId, active }: Props) {
  const qs = useMemo(() => {
    const o = encodeURIComponent(orgId || "org_001");
    const v = encodeURIComponent(versionId || "v1");
    return { o, v };
  }, [orgId, versionId]);

  const hasContract = !!contractId;
  const cid = contractId ? encodeURIComponent(contractId) : "";

  return (
    <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", marginBottom: 12 }}>
      <a href={`/admin/contracts?orgId=${qs.o}`} style={btnStyle(active === "contracts")}>Contracts</a>

      {hasContract && (
        <>
          <a href={`/admin/contracts/${cid}?orgId=${qs.o}`} style={btnStyle(active === "contract")}>Contract Overview</a>
          <a href={`/admin/contracts/${cid}/payloads?orgId=${qs.o}`} style={btnStyle(active === "payloads")}>Payloads</a>
          <a href={`/admin/contracts/${cid}/packet?orgId=${qs.o}&versionId=${qs.v}`} style={btnStyle(active === "packet")}>Packet Preview</a>
        </>
      )}

      {/* Command palette trigger lives in your existing UI; keep this as a simple hint button */}
      <span style={{ opacity: 0.65, fontSize: 12, marginLeft: 6 }}>⌘K</span>
    </div>
  );
}
TSX

echo "✅ AdminNav written"

echo
echo "==> (2) Harden functions_clean contract handlers (orgId/orgid + contractId/contractid/id)"
patch_fn () {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "⚠ missing $file (skipping)"
    return 0
  fi
  python3 - <<PY
from pathlib import Path
p = Path("$file")
s = p.read_text()

# Replace the common orgId parse patterns to accept orgid too
s = s.replace("const orgId = String(req.query.orgId || \"\").trim();",
              "const orgId = String((req.query.orgId ?? req.query.orgid ?? \"\")).trim();")
s = s.replace("const orgId = String(req.query.orgId || \"\").trim();",
              "const orgId = String((req.query.orgId ?? req.query.orgid ?? \"\")).trim();")

# Replace contractId parse patterns to accept contractid/id too
s = s.replace("const contractId = String(req.query.contractId || \"\").trim();",
              "const contractId = String((req.query.contractId ?? req.query.contractid ?? req.query.id ?? \"\")).trim();")

# Also accept body variants if used
s = s.replace("const orgId = body.orgId;", "const orgId = body.orgId ?? body.orgid;")
s = s.replace("const contractId = body.contractId;", "const contractId = body.contractId ?? body.contractid ?? body.id;")

p.write_text(s)
print("✅ patched", p)
PY
}

patch_fn "functions_clean/getContractsV1.mjs"
patch_fn "functions_clean/getContractV1.mjs"
patch_fn "functions_clean/getContractPayloadsV1.mjs"

echo
echo "==> (3) De-dupe AdminNav inserts + fix imports in admin pages"

# Targets
FILES=(
  "next-app/src/app/admin/contracts/page.tsx"
  "next-app/src/app/admin/contracts/[id]/page.tsx"
  "next-app/src/app/admin/contracts/[id]/payloads/page.tsx"
  "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx"
)

python3 - <<'PY'
from pathlib import Path
import re

files = [
  "next-app/src/app/admin/contracts/page.tsx",
  "next-app/src/app/admin/contracts/[id]/page.tsx",
  "next-app/src/app/admin/contracts/[id]/payloads/page.tsx",
  "next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx",
  "next-app/src/app/admin/contracts/[id]/packet/page.tsx",
]

def ensure_import(s: str, rel: str) -> str:
  # remove any AdminNav imports
  s = re.sub(r"^\s*import\s+AdminNav\s+from\s+['\"][^'\"]*AdminNav['\"];\s*\n", "", s, flags=re.M)
  # add one correct import after "use client" line if present, else top
  lines = s.splitlines(True)
  ins = 0
  for i, ln in enumerate(lines[:20]):
    if "use client" in ln:
      ins = i + 1
      break
  lines.insert(ins, f"import AdminNav from '{rel}';\n")
  return "".join(lines)

def dedupe_adminnav(s: str) -> str:
  # remove multiple <AdminNav ... /> occurrences, keep only the first
  matches = list(re.finditer(r"<AdminNav[\s\S]*?\/>\s*", s))
  if len(matches) <= 1:
    return s
  # keep first, delete the rest
  out = []
  last = 0
  out.append(s[:matches[0].end()])
  last = matches[0].end()
  for m in matches[1:]:
    out.append(s[last:m.start()])
    last = m.end()
  out.append(s[last:])
  return "".join(out)

def ensure_single_nav_block(s: str, contract_scoped: bool) -> str:
  # if no AdminNav exists, insert near top of return block (after header/top bar)
  if "<AdminNav" in s:
    return s

  # crude insert: after first <div style=... padding: 24 ...> or first <div ... padding
  m = re.search(r"return\s*\(\s*<div[^>]*>\s*", s)
  if not m:
    return s

  nav = ""
  if contract_scoped:
    nav = "<AdminNav orgId={orgId} contractId={contractId} versionId={versionId} active=\"contract\" />\n"
  else:
    nav = "<AdminNav orgId={orgId} active=\"contracts\" />\n"

  insert_at = m.end()
  return s[:insert_at] + "\n" + nav + s[insert_at:]

for fp in files:
  p = Path(fp)
  if not p.exists():
    print("⚠ missing", fp)
    continue
  s = p.read_text()

  # choose correct relative path
  if fp.endswith("admin/contracts/page.tsx"):
    s = ensure_import(s, "../_components/AdminNav")
    contract_scoped = False
  elif "/packet/" in fp:
    s = ensure_import(s, "../../../_components/AdminNav")
    contract_scoped = True
  elif "/payloads/[payloadId]/" in fp:
    s = ensure_import(s, "../../../../_components/AdminNav")
    contract_scoped = True
  elif "/payloads/" in fp:
    s = ensure_import(s, "../../../_components/AdminNav")
    contract_scoped = True
  else:
    s = ensure_import(s, "../../_components/AdminNav")
    contract_scoped = True

  s = dedupe_adminnav(s)
  s = ensure_single_nav_block(s, contract_scoped)

  p.write_text(s)
  print("✅ nav/import patched", fp)

PY

echo
echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1
echo "✅ Next restarted"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
