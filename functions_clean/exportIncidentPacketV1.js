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
