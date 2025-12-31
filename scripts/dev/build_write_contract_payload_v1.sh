#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app

FN_DIR="functions_clean"
IDX="$FN_DIR/index.mjs"
OUT="$FN_DIR/writeContractPayloadV1.mjs"

echo "==> (1) Write $OUT"

cat > "$OUT" <<'MJS'
import crypto from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function stableSort(x) {
  if (x === null || x === undefined) return x;
  if (Array.isArray(x)) return x.map(stableSort);
  if (typeof x === "object") {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = stableSort(x[k]);
    return out;
  }
  return x;
}
function stableStringify(obj) {
  return JSON.stringify(stableSort(obj), null, 2);
}
function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function ok(res, body) { return res.status(200).json({ ok: true, ...body }); }
function bad(res, msg, code="BAD_REQUEST") { return res.status(400).json({ ok:false, error: msg, code }); }

export const writeContractPayloadV1 = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return bad(res, "POST required", "METHOD_NOT_ALLOWED");
    const b = req.body || {};

    const orgId = String(b.orgId || "");
    const contractId = String(b.contractId || "");
    const type = String(b.type || "");
    const versionId = String(b.versionId || "");
    const schemaVersion = String(b.schemaVersion || "");
    const createdBy = String(b.createdBy || "system");
    const payload = b.payload ?? null;

    // payloadDocId is optional (we generate a stable one)
    const payloadDocId = String(b.payloadDocId || `${versionId}_${type.toLowerCase()}`);

    if (!orgId) return bad(res, "Missing orgId");
    if (!contractId) return bad(res, "Missing contractId");
    if (!type) return bad(res, "Missing type");
    if (!versionId) return bad(res, "Missing versionId");
    if (!schemaVersion) return bad(res, "Missing schemaVersion");
    if (payload === null || payload === undefined || typeof payload !== "object") {
      return bad(res, "payload must be an object/map");
    }

    // normalize common types
    const typeNorm = type.toUpperCase(); // DIRS/NORS/OE_417/SAR/BABA
    const vNorm = String(versionId);
    const schemaNorm = String(schemaVersion);

    if (!getApps().length) initializeApp();
    const db = getFirestore();

    const contractRef = db.collection("contracts").doc(contractId);
    const payloadRef = contractRef.collection("payloads").doc(payloadDocId);

    // hash of canonical payload
    const canon = stableStringify(payload);
    const payloadHash = sha256Hex(canon);

    // If you want to preserve prior createdAt, we do merge + createdAt only if missing
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(payloadRef);
      const createdAt = existing.exists ? (existing.data()?.createdAt ?? FieldValue.serverTimestamp()) : FieldValue.serverTimestamp();

      tx.set(payloadRef, {
        orgId,
        contractId,
        type: typeNorm,
        versionId: vNorm,
        schemaVersion: schemaNorm,
        createdBy,
        createdAt,
        updatedAt: FieldValue.serverTimestamp(),
        payload,
        payloadHash,
      }, { merge: true });

      // Update parent contract touch + keep orgId on parent too
      tx.set(contractRef, {
        orgId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return ok(res, { orgId, contractId, payloadDocId, payloadHash });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e), code:"INTERNAL" });
  }
});
MJS

echo "==> (2) Ensure index.mjs exports writeContractPayloadV1"
if ! rg -n "writeContractPayloadV1" "$IDX" >/dev/null 2>&1; then
  # Append a re-export at end of file (safe, simple)
  echo "" >> "$IDX"
  echo "export { writeContractPayloadV1 } from \"./writeContractPayloadV1.mjs\";" >> "$IDX"
  echo "✅ appended export to index.mjs"
else
  echo "✅ index.mjs already references writeContractPayloadV1"
fi

echo "==> (3) Syntax check"
node --check "$OUT" >/dev/null
node -e "import('./$IDX').then(()=>console.log('IMPORT_OK')).catch(e=>{console.error('IMPORT_FAIL');console.error(e);process.exit(1)})"

echo "✅ writeContractPayloadV1 ready"
