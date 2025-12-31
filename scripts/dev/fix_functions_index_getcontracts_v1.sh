#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()
hello_anchor = "export const hello = onRequest((req, res) => {"
i = s.find(hello_anchor)
if i != -1:
    # find next export after hello line
    j = s.find("\nexport const", i + len(hello_anchor))
    if j != -1:
        hello_block = s[i:j]
        if "});" not in hello_block:
            s = s[:j] + "\n});\n" + s[j:]
imp = 'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n'
if imp not in s:
    # stick it after onRequest import
    k = s.find('import { onRequest }')
    if k != -1:
        line_end = s.find("\n", k)
        s = s[:line_end+1] + imp + s[line_end+1:]
    else:
        s = imp + s
export_line = "export const getContractsV1 = onRequest(handleGetContractsV1);\n"
if export_line not in s:
    # put it right after hello export (now guaranteed closed)
    h = s.find("export const hello = onRequest")
    if h != -1:
        after = s.find("});", h)
        if after != -1:
            after += 3
            s = s[:after] + "\n\n" + export_line + s[after:]
        else:
            s = s + "\n" + export_line
    else:
        s = s + "\n" + export_line
s = s.replace("export const getContractV1 = onRequest(getContractV1Handler);\n", "")

p.write_text(s)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> node syntax check"
node --check functions_clean/index.mjs
echo "✅ node --check OK"

echo "==> deploy"
firebase deploy --only functions:getContractsV1
echo "✅ deployed getContractsV1"
