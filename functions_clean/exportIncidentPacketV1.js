const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
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
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    const force = String(req.query.force || "").trim() === "1";
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incidentRef = db.collection("incidents").doc(incidentId);

    const incidentSnap = await incidentRef.get();

// IMMUTABILITY_GUARD_C2
const incidentData = incidentSnap.exists ? (incidentSnap.data() || {}) : {};

if (incidentData.immutable === true && !force) {
  return res.status(409).json({
    ok: false,
    error: "IMMUTABLE: Incident is finalized"
  });
}

    // --- IMMUTABLE EXPORT (write-once) ---
    const existingMeta = incidentSnap.exists ? (incidentSnap.data()?.packetMeta || null) : null;
    if (!force && existingMeta && (existingMeta.packetHash || existingMeta.exportedAt || existingMeta.sizeBytes)) {
      return send(res, 200, {
        ok: true,
        orgId,
        incidentId,
        immutable: true,
        packetMeta: existingMeta,
      });
    }

    if (!incidentSnap.exists) return send(res, 404, { ok: false, error: "Incident not found" });

    // Canonical collections
    const filingsSnap = await incidentRef.collection("filings").get();
    const filings = filingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const tlSnap = await incidentRef.collection("timeline_events").get();
    const timelineEvents = tlSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const exportedAt = new Date().toISOString();
    const nowTs = Timestamp.now();

    // Meta hash is derived from deterministic JSON (MVP). ZIP hash can come later.
    const packet = { orgId, incidentId, exportedAt, incident, filings, timelineEvents };
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
          filingsCount: filings.length,
          timelineCount: timelineEvents.length,
          source: "exportIncidentPacketV1",
        },
        updatedAt: nowTs,
      },
      { merge: true }
    );

    // Emit canonical timeline event
    const evId = `t3_packet_${Date.now()}`;
    await incidentRef.collection("timeline_events").doc(evId).set(
      {
        id: evId,
        orgId,
        incidentId,
        type: "PACKET_EXPORTED",
        title: "Packet exported",
        message: "Packet metadata saved (hash + size).",
        occurredAt: exportedAt,
        requestedBy: String(req.query.requestedBy || "system"),
        createdAt: nowTs,
        updatedAt: nowTs,
        source: "exportIncidentPacketV1",
      },
      { merge: true }
    );

    return send(res, 200, { ok: true, orgId, incidentId, packetMeta: { exportedAt, packetHash, sizeBytes } });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
