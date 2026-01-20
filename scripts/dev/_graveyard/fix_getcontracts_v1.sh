#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Write functions_clean/getContractsV1.mjs (clean handler)"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export async function handleGetContractsV1(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) {
      return res.status(400).json({ ok: false, error: "Missing orgId" });
    }

    // NOTE: This ORDER BY requires a composite index in prod:
    // where(orgId == ...) + orderBy(createdAt desc)
    const snap = await db
      .collection("contracts")
      .where("orgId", "==", orgId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({ ok: true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS

echo "==> (2) Patch functions_clean/index.mjs: add import + export endpoint"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# ensure import exists
imp = 'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n'
if imp not in s:
  # insert after first onRequest import as an anchor
  anchor = 'import { onRequest } from "firebase-functions/v2/https";\n'
  if anchor in s:
    s = s.replace(anchor, anchor + imp)
  else:
    s = imp + s

# ensure export exists (top-level)
export_line = "export const getContractsV1 = onRequest(handleGetContractsV1);\n"
if export_line not in s:
  # put it right after hello export if present, else near top
  anchor = "export const hello = onRequest"
  idx = s.find(anchor)
  if idx != -1:
    end = s.find("});", idx)
    if end != -1:
      end += 3
      s = s[:end] + "\n\n" + export_line + s[end:]
    else:
      s = export_line + s
  else:
    s = export_line + s

p.write_text(s)
print("✅ index.mjs patched")
PY

echo "==> (3) Syntax check"
node --check functions_clean/index.mjs
echo "✅ node --check OK"

echo
echo "==> (4) Deploy"
firebase deploy --only functions:getContractsV1
echo "✅ deployed getContractsV1"
