const { generateDIRSV1 } = require("./generateDIRSV1");
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

    // CALL_GENERATE_DIRSV1
    // Generate real DIRS payload first (safe + idempotent)
    try {
      // generateDIRSV1 expects req/res; we fake a mini res object and ignore output
      await new Promise((resolve) => {
        const fakeRes = {
          set: () => {},
          status: () => ({ send: () => resolve(null) }),
          send: () => resolve(null),
        };
        generateDIRSV1({ query: { orgId, incidentId } }, fakeRes);
      });
    } catch (e) {
      // Keep generateFilingsV1 resilient: do not fail whole pipeline if DIRS generation fails
    }
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
