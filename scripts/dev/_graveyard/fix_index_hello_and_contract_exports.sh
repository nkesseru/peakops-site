#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="functions_clean/index.mjs"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup created"

python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text().splitlines(True)

out = []
i = 0
n = len(s)
while i < n:
    line = s[i]
    out.append(line)

    if "export const hello" in line and "onRequest" in line:
        # scan forward until we hit next "export const" (not hello)
        j = i + 1
        while j < n and not (s[j].lstrip().startswith("export const") and "hello" not in s[j]):
            # if we find a proper close already, do nothing
            j += 1

        # check if between i..j we already have a close line like "});"
        block_text = "".join(s[i:j])
        has_close = "});" in block_text or "})" in block_text
        if not has_close:
            # before the next export const, insert closing for hello
            # (best-effort: insert right after the res.json line if present, else before next export const)
            inserted = False
            k = i + 1
            while k < j:
                if "res.json" in s[k]:
                    out.append("});\n")
                    inserted = True
                    break
                k += 1
            if not inserted:
                out.append("});\n")

    i += 1

s2 = "".join(out)
need_imports = [
  'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n',
  'import { handleGetContractV1 } from "./getContractV1.mjs";\n',
]
anchor = 'import { onRequest } from "firebase-functions/v2/https";\n'
if anchor in s2:
    idx = s2.find(anchor) + len(anchor)
    block = ""
    for imp in need_imports:
        if imp.strip() not in s2:
            block += imp
    if block:
        s2 = s2[:idx] + block + s2[idx:]
else:
    # fallback: prepend imports
    block = "".join([imp for imp in need_imports if imp.strip() not in s2])
    s2 = block + s2
bad = [
  "export const getContractV1 = onRequest(getContractV1Handler);",
  "export const getContractV1 = onRequest(getContractV1);",
  "export const getContractsV1 = onRequest(getContractsV1);",
]
for bl in bad:
    s2 = s2.replace(bl + "\n", "")
    s2 = s2.replace("\n" + bl, "\n")
want1 = "export const getContractsV1 = onRequest(handleGetContractsV1);"
want2 = "export const getContractV1  = onRequest(handleGetContractV1);".replace("handleGetContractV1", "handleGetContractV1")

if want1 not in s2 or "export const getContractV1" not in s2:
    # insert after hello export line (after its close)
    anchor2 = "export const hello = onRequest"
    a = s2.find(anchor2)
    if a == -1:
        raise SystemExit("❌ could not find hello export anchor")
    # find end of hello handler: first occurrence of '});' AFTER anchor
    end = s2.find("});", a)
    if end == -1:
        raise SystemExit("❌ could not find end of hello handler (});)")
    end += len("});")
    insert = "\n" + want1 + "\n" + 'export const getContractV1  = onRequest(handleGetContractV1);\n'
    s2 = s2[:end] + insert + s2[end:]

Path("functions_clean/index.mjs").write_text(s2)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> ESM import sanity (should be OK)"
node -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM import OK')).catch(e=>{console.error('❌ ESM import failed'); console.error(e); process.exit(1);})"

echo "==> Deploy"
firebase deploy --only functions:getContractsV1,functions:getContractV1
echo "✅ deployed getContractsV1 + getContractV1"
