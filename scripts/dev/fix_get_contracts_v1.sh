#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> (0) Ensure functions_clean/package.json is ESM"
mkdir -p functions_clean
if [ ! -f functions_clean/package.json ]; then
  cat > functions_clean/package.json <<'JSON'
{
  "name": "functions-clean",
  "private": true,
  "type": "module",
  "main": "index.mjs",
  "engines": { "node": "20" },
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0",
    "jszip": "^3.10.1"
  }
}
JSON
else
  python3 - <<'PY'
import json
from pathlib import Path
p=Path("functions_clean/package.json")
d=json.loads(p.read_text())
d["type"]="module"
d["main"]="index.mjs"
d.setdefault("engines",{})["node"]="20"
p.write_text(json.dumps(d, indent=2)+"\n")
print("✅ patched functions_clean/package.json")
PY
fi

echo "==> (1) Write functions_clean/getContractsV1.mjs (clean handler)"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * GET /getContractsV1?orgId=org_001&limit=50
 */
export async function handleGetContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });

    if (!getApps().length) initializeApp();
    const db = getFirestore();

    const snap = await db
      .collection("contracts")
      .where("orgId", "==", orgId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/getContractsV1.mjs"

echo "==> (2) Patch functions_clean/index.mjs: import + export endpoint"
python3 - <<'PY'
from pathlib import Path
p=Path("functions_clean/index.mjs")
s=p.read_text()
bad = [
  'import { getContractsV1 } from "./getContractsV1.mjs";',
  'export { getContractsV1 } from "./getContractsV1.mjs";',
  'export const getContractsV1 = onRequest(getContractsV1);',
  'export const getContractsV1 = onRequest(handleGetContractsV1);',
]
lines=[ln for ln in s.splitlines(True) if ln.strip() not in bad]
s="".join(lines)

imp='import { handleGetContractsV1 } from "./getContractsV1.mjs";\n'
if imp not in s:
  out=[]
  inserted=False
  for ln in s.splitlines(True):
    if (not inserted) and (not ln.startswith("import ")):
      out.append(imp); inserted=True
    out.append(ln)
  s="".join(out)

export_line="export const getContractsV1 = onRequest(handleGetContractsV1);\n"
if export_line not in s:
  anchor="export const hello = onRequest"
  idx=s.find(anchor)
  if idx==-1: raise SystemExit("❌ Could not find hello export anchor in index.mjs")
  end=s.find("});", idx)
  if end==-1: raise SystemExit("❌ Could not find end of hello handler in index.mjs")
  end=end+3
  s=s[:end] + "\n\n" + export_line + s[end:]

p.write_text(s)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> (3) Local syntax checks"
node --check functions_clean/getContractsV1.mjs
node --check functions_clean/index.mjs
echo "✅ node --check OK"

echo "==> (4) Deploy function"
firebase deploy --only functions:getContractsV1
echo "✅ deployed getContractsV1"
