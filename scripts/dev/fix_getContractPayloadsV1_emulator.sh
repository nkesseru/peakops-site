#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"

echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo

mkdir -p functions_clean

echo "==> (1) Write handler: functions_clean/getContractPayloadsV1.mjs"
cat > functions_clean/getContractPayloadsV1.mjs <<'MJS'
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export async function handleGetContractPayloadsV1(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });
    if (!contractId) return res.status(400).json({ ok: false, error: "Missing contractId" });

    // NOTE: subcollection name is case-sensitive. You created "payloads" (lowercase).
    const ref = db.collection("contracts").doc(contractId).collection("payloads");

    // If you later add ordering fields consistently, you can orderBy updatedAt.
    // For now we just fetch up to limit; Firestore returns in doc-id order.
    const snap = await ref.limit(limit).get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, contractId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/getContractPayloadsV1.mjs"
echo

echo "==> (2) Wire into functions_clean/index.mjs (import + export)"
python3 - <<'PY'
from pathlib import Path

p = Path("functions_clean/index.mjs")
s = p.read_text()

imp = 'import { handleGetContractPayloadsV1 } from "./getContractPayloadsV1.mjs";\n'
if imp not in s:
    # insert right after the onRequest import line (or at top fallback)
    k = s.find("import { onRequest }")
    if k != -1:
        eol = s.find("\n", k)
        s = s[:eol+1] + imp + s[eol+1:]
    else:
        s = imp + s

export_line = "export const getContractPayloadsV1 = onRequest(handleGetContractPayloadsV1);\n"
if export_line not in s:
    # safest: append at EOF so we never land inside another function
    s = s.rstrip() + "\n\n" + export_line

p.write_text(s)
print("✅ patched functions_clean/index.mjs")
PY
echo

echo "==> (3) Restart emulators + Next (clean ports)"
bash scripts/dev/dev-down.sh 2>/dev/null || true
bash scripts/dev/dev-up.sh
echo

echo "==> (4) Smoke: direct function"
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 120 || true
echo

echo "==> (5) Smoke: Next API proxy"
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 120 || true
echo

echo "✅ UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads/v1_dirs?orgId=$ORG_ID"
