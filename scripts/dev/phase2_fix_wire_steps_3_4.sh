#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

echo "==> backups"
ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs
cp firebase.json "scripts/dev/_bak/firebase.json.$ts.bak" 2>/dev/null || true
cp functions_clean/index.js "scripts/dev/_bak/functions_clean.index.js.$ts.bak" 2>/dev/null || true

echo "==> force firebase.json functions.source=functions_clean"
node - <<'NODE'
const fs = require("fs");
const p = "firebase.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.functions = j.functions || {};
j.functions.source = "functions_clean";
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log("✅ firebase.json updated (functions.source=functions_clean)");
NODE

echo "==> ensure functions_clean is CommonJS"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/package.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.type = "commonjs";
j.main = "index.js";
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log("✅ functions_clean/package.json set to commonjs (main=index.js)");
NODE

echo "==> write functions_clean/generateFilingsV1.js"
cat > functions_clean/generateFilingsV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.generateFilingsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incidentRef = db.collection("incidents").doc(incidentId);
    const now = new Date().toISOString();

    // Minimal placeholder payload docs (safe + deterministic)
    const payloads = [
      { id: "v1_dirs", type: "DIRS", schemaVersion: "dirs.v1" },
      { id: "v1_oe_417", type: "OE_417", schemaVersion: "oe_417.v1" },
      { id: "v1_nors", type: "NORS", schemaVersion: "nors.v1" },
      { id: "v1_sar", type: "SAR", schemaVersion: "sar.v1" },
    ];

    const batch = db.batch();

    // write filings payload placeholders under: incidents/{incidentId}/filings/{payloadId}
    for (const p of payloads) {
      const ref = incidentRef.collection("filings").doc(p.id);
      batch.set(
        ref,
        {
          id: p.id,
          orgId,
          incidentId,
          type: p.type,
          schemaVersion: p.schemaVersion,
          payload: { _placeholder: "INIT" },
          createdAt: now,
          updatedAt: now,
          source: "generateFilingsV1",
        },
        { merge: true }
      );
    }

    // filingsMeta on incident
    batch.set(
      incidentRef,
      {
        orgId,
        filingsMeta: {
          generatedAt: now,
          count: payloads.length,
          schemas: payloads.map((x) => x.schemaVersion),
          source: "generateFilingsV1",
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // timeline event
    const evId = `t_filings_${Date.now()}`;
    const evRef = incidentRef.collection("timeline").doc(evId);
    batch.set(evRef, {
      id: evId,
      orgId,
      incidentId,
      type: "FILINGS_GENERATED",
      title: "Filings generated",
      message: "DIRS / OE-417 / NORS / SAR payloads created.",
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
      source: "generateFilingsV1",
    });

    await batch.commit();

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      filingsMeta: { generatedAt: now, count: payloads.length },
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/generateFilingsV1.js"

echo "==> write functions_clean/exportIncidentPacketV1.js"
cat > functions_clean/exportIncidentPacketV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}
function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

exports.exportIncidentPacketV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incidentRef = db.collection("incidents").doc(incidentId);

    const incidentSnap = await incidentRef.get();
    const incident = incidentSnap.exists ? { id: incidentSnap.id, ...incidentSnap.data() } : null;

    const filingsSnap = await incidentRef.collection("filings").get();
    const payloads = filingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const timelineSnap = await incidentRef.collection("timeline").get();
    const timeline = timelineSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const exportedAt = new Date().toISOString();
    const packet = { orgId, incidentId, exportedAt, incident, payloads, timeline };

    const packetJson = JSON.stringify(packet);
    const packetHash = sha256(packetJson);
    const sizeBytes = Buffer.byteLength(packetJson, "utf8");

    await incidentRef.set(
      {
        orgId,
        packetMeta: {
          exportedAt,
          packetHash,
          sizeBytes,
          payloadCount: payloads.length,
          timelineCount: timeline.length,
          source: "exportIncidentPacketV1",
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const evId = `t_export_${Date.now()}`;
    await incidentRef.collection("timeline").doc(evId).set({
      id: evId,
      orgId,
      incidentId,
      type: "PACKET_EXPORTED",
      title: "Packet exported",
      message: "Packet metadata saved (hash + size).",
      occurredAt: exportedAt,
      createdAt: exportedAt,
      updatedAt: exportedAt,
      source: "exportIncidentPacketV1",
    });

    // Safe MVP: return meta only (no ZIP yet)
    return send(res, 200, { ok: true, orgId, incidentId, packetMeta: { packetHash, sizeBytes } });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/exportIncidentPacketV1.js"

echo "==> ensure functions_clean/index.js exports both (and doesn't break existing)"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/index.js";
let s = fs.readFileSync(p, "utf8");

function ensure(line, key) {
  if (!s.includes(key)) s += "\n" + line + "\n";
}

ensure("exports.generateFilingsV1 = require('./generateFilingsV1').generateFilingsV1;", "generateFilingsV1");
ensure("exports.exportIncidentPacketV1 = require('./exportIncidentPacketV1').exportIncidentPacketV1;", "exportIncidentPacketV1");

fs.writeFileSync(p, s);
console.log("✅ functions_clean/index.js exports ensured");
NODE

echo "==> write Next routes (proxy -> emulator functions)"
mkdir -p next-app/src/app/api/fn/generateFilingsV1
cat > next-app/src/app/api/fn/generateFilingsV1/route.ts <<'TS'
import { proxyGET } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return proxyGET(req, "generateFilingsV1");
}
TS

mkdir -p next-app/src/app/api/fn/exportIncidentPacketV1
cat > next-app/src/app/api/fn/exportIncidentPacketV1/route.ts <<'TS'
import { proxyGET } from "../_lib/fnProxy";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return proxyGET(req, "exportIncidentPacketV1");
}
TS
echo "✅ wrote Next routes"

echo "==> hard restart stack (ports + emulators + next)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
sleep 2

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"

echo "==> verify emulator loaded functions (look for http function initialized lines)"
grep -n "http function initialized" .logs/emulators.log | tail -n 30 || true

echo "==> smoke direct functions (these should NOT 404)"
curl -fsS "$FN_BASE/hello" | head -c 120; echo
curl -fsS "$FN_BASE/generateFilingsV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo
curl -fsS "$FN_BASE/exportIncidentPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo

echo "==> smoke via Next proxy (what UI calls)"
curl -fsS "http://127.0.0.1:3000/api/fn/generateFilingsV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo
curl -fsS "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo

echo
echo "✅ OPEN:"
echo "http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "STOP:"
echo "kill $EMU_PID"
