#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

echo "==> (0) backup firebase.json + functions_clean/index.mjs + getWorkflowV1.mjs"
cp -f firebase.json "scripts/dev/_bak/firebase.json.$TS.bak" 2>/dev/null || true
cp -f functions_clean/index.mjs "scripts/dev/_bak/functions_clean.index.mjs.$TS.bak" 2>/dev/null || true
cp -f functions_clean/getWorkflowV1.mjs "scripts/dev/_bak/functions_clean.getWorkflowV1.mjs.$TS.bak" 2>/dev/null || true

echo "==> (1) force firebase.json functions.source = functions_clean"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
j = json.loads(p.read_text()) if p.exists() else {}
j.setdefault("functions", {})
j["functions"]["source"] = "functions_clean"
p.write_text(json.dumps(j, indent=2) + "\n")
print("✅ firebase.json functions.source = functions_clean")
PY

echo "==> (2) write functions_clean/getWorkflowV1.mjs as DEFAULT HANDLER (req,res)"
cat > functions_clean/getWorkflowV1.mjs <<'MJS'
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

export default async function getWorkflowV1Handler(req, res) {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // optional read (doesn't fail if missing)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    const steps = [
      { key: "intake",    title: "Intake",           hint: "Confirm incident exists + has baseline fields.", status: "TODO" },
      { key: "timeline",  title: "Build Timeline",   hint: "Generate timeline events + verify ordering.",     status: "TODO" },
      { key: "filings",   title: "Generate Filings", hint: "Build DIRS/OE-417/NORS/SAR payloads.",           status: "TODO" },
      { key: "export",    title: "Export Packet",    hint: "Create immutable shareable artifact (ZIP + hashes).", status: "TODO" },
    ];

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps },
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/getWorkflowV1.mjs"

echo "==> (3) write functions_clean/index.mjs to export getWorkflowV1 (same pattern as others)"
cat > functions_clean/index.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";

import helloHandler from "./hello.mjs";
import getContractsV1Handler from "./getContractsV1.mjs";
import getContractV1Handler from "./getContractV1.mjs";
import getContractPayloadsV1Handler from "./getContractPayloadsV1.mjs";
import writeContractPayloadV1Handler from "./writeContractPayloadV1.mjs";
import exportContractPacketV1Handler from "./exportContractPacketV1.mjs";
import getWorkflowV1Handler from "./getWorkflowV1.mjs";

export const hello = onRequest({ cors: true }, helloHandler);
export const getContractsV1 = onRequest({ cors: true }, getContractsV1Handler);
export const getContractV1 = onRequest({ cors: true }, getContractV1Handler);
export const getContractPayloadsV1 = onRequest({ cors: true }, getContractPayloadsV1Handler);
export const writeContractPayloadV1 = onRequest({ cors: true }, writeContractPayloadV1Handler);
export const exportContractPacketV1 = onRequest({ cors: true }, exportContractPacketV1Handler);

// ✅ Phase 2
export const getWorkflowV1 = onRequest({ cors: true }, getWorkflowV1Handler);
MJS
echo "✅ wrote functions_clean/index.mjs (includes getWorkflowV1)"

echo "==> (4) HARD restart emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
rm -f .logs/emulators.log || true
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 200); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> (5) confirm emulator registered getWorkflowV1"
if grep -q "getWorkflowV1" .logs/emulators.log; then
  echo "✅ getWorkflowV1 appears in emulator log"
else
  echo "❌ getWorkflowV1 NOT found in emulator log. Showing loaded defs:"
  grep -n "Loaded functions definitions" -n .logs/emulators.log || true
  tail -n 120 .logs/emulators.log || true
  echo "STOP: kill $EMU_PID"
  exit 1
fi

echo "==> (6) smoke direct function (should be 200 + JSON)"
curl -i "$FN_BASE/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -n 30

echo
echo "✅ If you saw HTTP/1.1 200, you're green."
echo "STOP: kill $EMU_PID"
