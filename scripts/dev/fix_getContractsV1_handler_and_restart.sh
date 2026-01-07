#!/usr/bin/env bash
set -euo pipefail

echo "==> (1) Rewrite functions_clean/getContractsV1.mjs as TRUE list endpoint (no contractId)"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

export default async function getContractsV1(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) {
      return res.status(400).json({ ok: false, error: "Missing orgId" });
    }

    const db = getFirestore();

    // List contracts for org (simple + stable)
    let q = db.collection("contracts").where("orgId", "==", orgId).limit(limit);

    // Optional ordering (only if index exists); fall back if not
    try { q = q.orderBy("updatedAt", "desc"); } catch {}

    const snap = await q.get();

    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/getContractsV1.mjs"

echo "==> (2) Ensure functions_clean/index.mjs imports + exports getContractsV1 correctly"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

imp = 'import getContractsV1Handler from "./getContractsV1.mjs";\n'
exp = 'export const getContractsV1 = onRequest(getContractsV1Handler);\n'

# add import near top (after onRequest import)
if imp not in s:
    lines = s.splitlines(True)
    # insert after first onRequest import line
    ins = 0
    for i,l in enumerate(lines[:40]):
        if "from \"firebase-functions/v2/https\"" in l and "onRequest" in l:
            ins = i+1
            break
    lines.insert(ins, imp)
    s = "".join(lines)

# add export near hello export (or end)
if exp not in s:
    anchor = "export const hello = onRequest"
    if anchor in s:
        idx = s.find(anchor)
        # insert right after hello handler block end (first ');' after anchor)
        end = s.find(");", idx)
        if end != -1:
            end = end + 2
            s = s[:end] + "\n\n" + exp + s[end:]
        else:
            s += "\n" + exp
    else:
        s += "\n" + exp

p.write_text(s)
print("✅ patched functions_clean/index.mjs (getContractsV1 import+export)")
PY

echo "==> (3) Restart emulators clean (functions+firestore)"
lsof -tiTCP:5001,8080,8081,4400,4409,9150,4500,3000 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

echo "==> (4) Start Next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo
echo "==> (5) Smoke"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=org_001&limit=5" | python3 -m json.tool | head -n 60

echo
echo "✅ OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
