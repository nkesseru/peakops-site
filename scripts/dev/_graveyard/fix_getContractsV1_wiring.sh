#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Write clean handler: functions_clean/getContractsV1.mjs"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export async function handleGetContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });

    const snap = await db.collection("contracts")
      .where("orgId", "==", orgId)
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS

echo "==> (2) Patch functions_clean/index.mjs (import + export at EOF, remove bad inserts)"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# Remove any previous/duplicate getContracts wiring (bad inserts anywhere)
lines = s.splitlines(True)
out = []
for ln in lines:
    if 'getContractsV1' in ln and ('export const' in ln or 'import' in ln):
        continue
    if 'getContractV1' in ln and ('export const' in ln or 'import' in ln):
        # remove the wrong older wiring if it exists
        continue
    out.append(ln)
s = "".join(out)

# Ensure import exists near the top (after onRequest import)
imp = 'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n'
if imp not in s:
    idx = s.find('import { onRequest }')
    if idx != -1:
        eol = s.find("\n", idx)
        s = s[:eol+1] + imp + s[eol+1:]
    else:
        s = imp + s

# Append export at EOF (guaranteed top-level)
export_line = "\nexport const getContractsV1 = onRequest(handleGetContractsV1);\n"
if "export const getContractsV1" not in s:
    s = s.rstrip() + export_line

p.write_text(s)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> (3) Syntax check"
node --check functions_clean/index.mjs
echo "✅ node --check OK"

echo "==> (4) Deploy"
firebase deploy --only functions:getContractsV1
echo "✅ deployed getContractsV1"
