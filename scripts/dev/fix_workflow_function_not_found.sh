#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p .logs scripts/dev/_bak

echo "==> (0) backup firebase.json + functions_clean/index.mjs"
cp firebase.json "scripts/dev/_bak/firebase.json.$TS.bak" 2>/dev/null || true
cp functions_clean/index.mjs "scripts/dev/_bak/functions_clean.index.mjs.$TS.bak" 2>/dev/null || true

echo "==> (1) force firebase.json functions.source = functions_clean"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("firebase.json")
cfg = json.loads(p.read_text())

cfg.setdefault("functions", {})
cfg["functions"]["source"] = "functions_clean"

p.write_text(json.dumps(cfg, indent=2) + "\n")
print("✅ firebase.json -> functions.source = functions_clean")
PY

echo "==> (2) write a CLEAN functions_clean/index.mjs (no collisions)"
cat > functions_clean/index.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";

// Existing handlers you already have (keep these names)
import helloHandler from "./hello.mjs";
import getContractsV1Handler from "./getContractsV1.mjs";
import getContractV1Handler from "./getContractV1.mjs";
import getContractPayloadsV1Handler from "./getContractPayloadsV1.mjs";
import writeContractPayloadV1Handler from "./writeContractPayloadV1.mjs";
import exportContractPacketV1Handler from "./exportContractPacketV1.mjs";

// NEW: workflow handler (default export from getWorkflowV1.mjs)
import getWorkflowV1Handler from "./getWorkflowV1.mjs";

// Export Cloud Functions (exact names become endpoints)
export const hello = onRequest({ cors: true }, helloHandler);
export const getContractsV1 = onRequest({ cors: true }, getContractsV1Handler);
export const getContractV1 = onRequest({ cors: true }, getContractV1Handler);
export const getContractPayloadsV1 = onRequest({ cors: true }, getContractPayloadsV1Handler);
export const writeContractPayloadV1 = onRequest({ cors: true }, writeContractPayloadV1Handler);
export const exportContractPacketV1 = onRequest({ cors: true }, exportContractPacketV1Handler);

// ✅ This is the one that is currently missing in your emulator
export const getWorkflowV1 = onRequest({ cors: true }, getWorkflowV1Handler);
MJS
echo "✅ wrote functions_clean/index.mjs (clean exports)"

echo "==> (3) sanity: ensure functions_clean/getWorkflowV1.mjs exists"
test -f functions_clean/getWorkflowV1.mjs || { echo "❌ missing functions_clean/getWorkflowV1.mjs"; exit 1; }
echo "✅ getWorkflowV1.mjs present"

echo "==> (4) restart emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
rm -f .logs/emulators.log || true
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ emulators did not come up"
  tail -n 120 .logs/emulators.log || true
  exit 1
}

echo "==> (5) verify getWorkflowV1 exists now"
echo "--- direct hello ---"
curl -i "$FN_BASE/hello" | head -n 8
echo
echo "--- direct getWorkflowV1 ---"
curl -i "$FN_BASE/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -n 20
echo
echo "✅ If the second call is NOT 404, you're fixed."

echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "STOP:"
echo "  kill $EMU_PID"
