#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FILES=(
  "functions_clean/getContractsV1.mjs"
  "functions_clean/getContractV1.mjs"
  "functions_clean/getContractPayloadsV1.mjs"
)

python3 - <<'PY'
from pathlib import Path
import re

files = [
  "functions_clean/getContractsV1.mjs",
  "functions_clean/getContractV1.mjs",
  "functions_clean/getContractPayloadsV1.mjs",
]

def ensure_imports(s: str) -> str:
  # ensure firebase-admin/app imports
  if "from \"firebase-admin/app\"" not in s and "from 'firebase-admin/app'" not in s:
    s = 'import { initializeApp, getApps } from "firebase-admin/app";\n' + s
  else:
    # ensure initializeApp/getApps are present if import exists
    s = re.sub(r'import\s*\{\s*([^}]+)\s*\}\s*from\s*["\']firebase-admin/app["\'];',
               lambda m: f'import {{ {", ".join(sorted(set([x.strip() for x in (m.group(1).split(","))] + ["initializeApp","getApps"])))} }} from "firebase-admin/app";',
               s, count=1)

  # ensure getFirestore import
  if "from \"firebase-admin/firestore\"" not in s and "from 'firebase-admin/firestore'" not in s:
    s = 'import { getFirestore } from "firebase-admin/firestore";\n' + s
  else:
    # ensure getFirestore is included
    s = re.sub(r'import\s*\{\s*([^}]+)\s*\}\s*from\s*["\']firebase-admin/firestore["\'];',
               lambda m: f'import {{ {", ".join(sorted(set([x.strip() for x in (m.group(1).split(","))] + ["getFirestore"])))} }} from "firebase-admin/firestore";',
               s, count=1)

  return s

def ensure_init(s: str) -> str:
  if "if (!getApps().length) initializeApp()" not in s and "if (!getApps().length) initializeApp();" not in s:
    # place after imports block (after last import line)
    lines = s.splitlines(True)
    last_import = 0
    for i,l in enumerate(lines):
      if l.strip().startswith("import "):
        last_import = i
    insert_at = last_import + 1
    lines.insert(insert_at, "\nif (!getApps().length) initializeApp();\n")
    return "".join(lines)
  return s

def ensure_db_inside_handler(s: str) -> str:
  # If file already defines db anywhere, leave it.
  if re.search(r'\bconst\s+db\s*=\s*getFirestore\(\)\s*;', s):
    return s

  # Otherwise, inject inside the first onRequest handler block right after orgId validation
  # Find pattern: if (!orgId) { ... return; }
  m = re.search(r'(if\s*\(\s*!\s*orgId\s*\)\s*\{[^}]*\}\s*)', s, flags=re.S)
  if not m:
    # fallback: inject near top of handler after `try {`
    m2 = re.search(r'(try\s*\{)', s)
    if not m2:
      return s
    idx = m2.end()
    return s[:idx] + "\n    const db = getFirestore();\n" + s[idx:]

  idx = m.end()
  return s[:idx] + "\n\n    const db = getFirestore();\n" + s[idx:]

for fp in files:
  p = Path(fp)
  if not p.exists():
    print(f"❌ missing {fp}")
    continue
  s = p.read_text()

  s2 = ensure_imports(s)
  s2 = ensure_init(s2)
  s2 = ensure_db_inside_handler(s2)

  if s2 != s:
    p.write_text(s2)
    print(f"✅ patched {fp}")
  else:
    print(f"ℹ️  no change {fp}")
PY

echo "✅ done patching contract handlers"
