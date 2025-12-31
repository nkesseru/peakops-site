#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> (0) Env"
set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"

echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"
echo "CONTRACT_ID=$CONTRACT_ID"
echo "CUSTOMER_ID=$CUSTOMER_ID"
echo

echo "==> (1) Ensure dev scripts folder"
mkdir -p scripts/dev

echo "==> (2) Write functions: getContractsV1 + getContractV1 (handlers)"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export const handleGetContractsV1 = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });

    const snap = await db.collection("contracts")
      .where("orgId", "==", orgId)
      .orderBy("contractNumber")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
MJS

cat > functions_clean/getContractV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export const handleGetContractV1 = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });
    if (!contractId) return res.status(400).json({ ok: false, error: "Missing contractId" });

    const ref = db.collection("contracts").doc(contractId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Contract not found" });

    const data = snap.data() || {};
    if (String(data.orgId || "") !== orgId) {
      return res.status(403).json({ ok: false, error: "Org mismatch" });
    }

    return res.json({ ok: true, orgId, contractId, doc: { id: snap.id, ...data } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
MJS

echo "==> (3) Patch functions_clean/index.mjs (imports + exports, safe/clean)"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# remove any bad/old getContractV1/getContractsV1 exports (to avoid 'export inside' / dupes)
lines = s.splitlines(True)
out = []
for ln in lines:
  if "export const getContractV1" in ln: 
    continue
  if "export const getContractsV1" in ln:
    continue
  out.append(ln)
s = "".join(out)

# ensure imports exist near top (after onRequest import is fine)
need_imports = [
  'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n',
  'import { handleGetContractV1 } from "./getContractV1.mjs";\n',
]
for imp in need_imports:
  if imp.strip() not in s:
    # insert after first line that imports onRequest
    needle = 'import { onRequest } from "firebase-functions/v2/https";\n'
    if needle in s:
      s = s.replace(needle, needle + imp, 1)
    else:
      s = imp + s

# add exports right after hello export (stable anchor)
export_block = (
  '\nexport const getContractsV1 = onRequest(handleGetContractsV1);\n'
  'export const getContractV1 = onRequest(handleGetContractV1);\n'
)

if "export const hello = onRequest" in s and "export const getContractsV1" not in s:
  anchor = "export const hello = onRequest"
  idx = s.find(anchor)
  if idx == -1:
    raise SystemExit("Could not find hello export anchor in functions_clean/index.mjs")
  end = s.find("};", idx)
  if end == -1:
    raise SystemExit("Could not find end of hello handler (};)")
  end = end + 3
  s = s[:end] + export_block + s[end:]
else:
  # fallback: append to EOF
  if "export const getContractsV1" not in s:
    s = s.rstrip() + "\n" + export_block

p.write_text(s)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> (4) Ensure functions_clean is ESM (package.json type=module)"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("functions_clean/package.json")
d = json.loads(p.read_text())
d["type"] = "module"
d["main"] = "index.mjs"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ functions_clean/package.json set type=module, main=index.mjs")
PY

echo "==> (5) Syntax check (Node 20)"
node --check functions_clean/index.mjs
echo "✅ node --check ok"
echo

echo "==> (6) Start dev stack (emulators + next)"
# best-effort kill ports
for PORT in 3000 5001 8081 4400 4401 4409 4500 4501 4509 9150; do
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
done
pkill -f "firebase.*emulators" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# pin firebase.json to functions_clean if needed (noop if already)
if grep -q '"source"[[:space:]]*:[[:space:]]*"functions_clean"' firebase.json; then
  echo "✅ firebase.json already pinned to functions_clean"
else
  python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
d = json.loads(p.read_text())
d.setdefault("functions", {})
d["functions"]["source"] = "functions_clean"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ pinned firebase.json functions.source=functions_clean")
PY
fi

# start emulators (functions+firestore)
mkdir -p .logs
( firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 ) &
EMU_PID=$!

# wait for hello
echo "==> wait for functions /hello"
for i in $(seq 1 60); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK"
    break
  fi
  sleep 0.5
  if [ $i -eq 60 ]; then
    echo "❌ functions did not come up. tail .logs/emulators.log:"
    tail -n 80 .logs/emulators.log || true
    exit 1
  fi
done

# start next (from next-app)
echo "==> start Next on 3000"
( pnpm -C next-app dev --port 3000 > .logs/next.log 2>&1 ) &
NEXT_PID=$!

echo "==> wait for Next"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:3000" >/dev/null 2>&1; then
    echo "✅ next OK"
    break
  fi
  sleep 0.5
  if [ $i -eq 60 ]; then
    echo "❌ next did not come up. tail .logs/next.log:"
    tail -n 120 .logs/next.log || true
    exit 1
  fi
done
echo

echo "==> (7) Seed Firestore EMULATOR: contracts/$CONTRACT_ID"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
export GCLOUD_PROJECT="peakops-pilot"

node - <<NODE
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

const orgId = "${ORG_ID}";
const contractId = "${CONTRACT_ID}";
const customerId = "${CUSTOMER_ID}";

await db.collection("contracts").doc(contractId).set({
  orgId,
  contractNumber: "CTR-2025-0001",
  status: "ACTIVE",
  type: "MSA",
  customerId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, { merge: true });

console.log("✅ seeded emulator: contracts/" + contractId);
NODE

echo "==> (8) Smoke: getContractsV1 + getContractV1 (emulator)"
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=50" | python3 -m json.tool | head -n 60
echo
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 60
echo

echo "==> DONE ✅"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 80 .logs/emulators.log"
echo "  tail -n 80 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
