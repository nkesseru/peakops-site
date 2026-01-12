#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

echo "==> backup files"
ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "functions_clean/index.js" "scripts/dev/_bak/functions_clean.index.js.$ts.bak" 2>/dev/null || true

cat > functions_clean/generateFilingsV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
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

    // Seed 4 payload stubs (minimal, safe)
    const payloads = [
      { id: "dirs_v1", schemaVersion: "dirs.v1", type: "DIRS" },
      { id: "nors_v1", schemaVersion: "nors.v1", type: "NORS" },
      { id: "oe_417_v1", schemaVersion: "oe_417.v1", type: "OE_417" },
      { id: "sar_v1", schemaVersion: "sar.v1", type: "SAR" },
    ];

    const now = new Date().toISOString();

    const batch = db.batch();
    const incidentRef = db.collection("incidents").doc(incidentId);

    // Write payload docs under incidents/{incidentId}/payloads/{id}
    for (const p of payloads) {
      const ref = incidentRef.collection("payloads").doc(p.id);
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
          createdBy: "generateFilingsV1",
        },
        { merge: true }
      );
    }

    // Write filingsMeta on incident
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

    // Add timeline event (incidents/{incidentId}/timeline/{eventId})
    const evRef = incidentRef.collection("timeline").doc(`t_filings_${Date.now()}`);
    batch.set(evRef, {
      id: evRef.id,
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
cat > functions_clean/exportIncidentPacketV1.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

exports.exportIncidentPacketV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incidentRef = db.collection("incidents").doc(incidentId);
    const snap = await incidentRef.get();
    const incident = snap.exists ? { id: snap.id, ...snap.data() } : null;

    // Load payloads
    const payloadSnap = await incidentRef.collection("payloads").get();
    const payloads = payloadSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Load timeline (optional)
    const timelineSnap = await incidentRef.collection("timeline").orderBy("occurredAt").limit(500).get().catch(() => null);
    const timeline = timelineSnap ? timelineSnap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];

    const packet = {
      orgId,
      incidentId,
      exportedAt: new Date().toISOString(),
      incident,
      payloads,
      timeline,
    };

    const packetJson = JSON.stringify(packet);
    const packetHash = sha256(packetJson);
    const sizeBytes = Buffer.byteLength(packetJson, "utf8");

    // Store packetMeta
    await incidentRef.set(
      {
        orgId,
        packetMeta: {
          exportedAt: packet.exportedAt,
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

    // timeline event
    await incidentRef.collection("timeline").doc(`t_export_${Date.now()}`).set({
      id: `t_export_${Date.now()}`,
      orgId,
      incidentId,
      type: "PACKET_EXPORTED",
      title: "Packet exported",
      message: "Packet metadata saved (hash + size).",
      occurredAt: packet.exportedAt,
      createdAt: packet.exportedAt,
      updatedAt: packet.exportedAt,
      source: "exportIncidentPacketV1",
    });

    // For now: return JSON (no zip yet) — stable + safe
    return send(res, 200, { ok: true, orgId, incidentId, packetMeta: { packetHash, sizeBytes } });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/exportIncidentPacketV1.js"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/index.js";
let s = fs.readFileSync(p, "utf8");

// Add requires + exports if missing
if (!s.includes("generateFilingsV1")) {
  s += "\nexports.generateFilingsV1 = require('./generateFilingsV1').generateFilingsV1;\n";
}
if (!s.includes("exportIncidentPacketV1")) {
  s += "\nexports.exportIncidentPacketV1 = require('./exportIncidentPacketV1').exportIncidentPacketV1;\n";
}
fs.writeFileSync(p, s);
console.log("✅ functions_clean/index.js exports ensured");
NODE

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
echo "==> restart stack"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
sleep 2
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"

echo "==> smoke direct functions"
curl -fsS "$FN_BASE/hello" | head -c 120; echo
curl -fsS "$FN_BASE/getWorkflowV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 120; echo
curl -fsS "$FN_BASE/getTimelineEventsV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" | head -c 120; echo
curl -fsS "$FN_BASE/generateFilingsV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 180; echo
curl -fsS "$FN_BASE/exportIncidentPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 180; echo

echo
echo "✅ OPEN:"
echo "http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "STOP:"
echo "kill $EMU_PID"
