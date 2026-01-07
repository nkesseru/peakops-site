#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Patch functions_clean handlers (define db inside handler)"

# getContractsV1.mjs
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

async function getContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });

    const db = getFirestore();

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

export default onRequest(getContractsV1);
MJS

# getContractV1.mjs
cat > functions_clean/getContractV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

async function getContractV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    if (!orgId || !contractId) return res.status(400).json({ ok: false, error: "Missing orgId/contractId" });

    const db = getFirestore();

    const snap = await db.collection("contracts").doc(contractId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Contract not found" });

    const doc = { id: snap.id, ...snap.data() };
    if (String(doc.orgId || "") !== orgId) return res.status(404).json({ ok: false, error: "Contract not found" });

    return res.json({ ok: true, orgId, contractId, doc });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

export default onRequest(getContractV1);
MJS

# getContractPayloadsV1.mjs
cat > functions_clean/getContractPayloadsV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

async function getContractPayloadsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId || !contractId) return res.status(400).json({ ok: false, error: "Missing orgId/contractId" });

    const db = getFirestore();

    // verify contract belongs to org
    const cSnap = await db.collection("contracts").doc(contractId).get();
    if (!cSnap.exists) return res.status(404).json({ ok: false, error: "Contract not found" });
    const c = cSnap.data() || {};
    if (String(c.orgId || "") !== orgId) return res.status(404).json({ ok: false, error: "Contract not found" });

    const snap = await db.collection("contracts").doc(contractId)
      .collection("payloads")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, contractId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

export default onRequest(getContractPayloadsV1);
MJS

echo "✅ handlers rewritten"

echo
echo "==> (2) Restart stack (your known-good script)"
bash scripts/dev/contracts_stack_up_fixed.sh car_abc123 cust_acme_001 v1

echo
echo "==> (3) Smoke via Next proxy (should be ok:true)"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=org_001&limit=5" | python3 -m json.tool | head -n 60
echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=org_001&contractId=car_abc123&limit=50" | python3 -m json.tool | head -n 80

echo
echo "✅ If both are ok:true, UI should load clean:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
