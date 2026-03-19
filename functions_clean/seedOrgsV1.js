const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function isDevOnlyAllowed() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";
}

exports.seedOrgsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (!isDevOnlyAllowed()) return j(res, 403, { ok: false, error: "dev_only" });
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const db = getFirestore();
    const orgs = [
      { id: "riverbend-electric", name: "Riverbend Electric" },
      { id: "northgrid-services", name: "Northgrid Services" },
      { id: "metro-lineworks", name: "Metro Lineworks" },
    ];

    const batch = db.batch();
    for (const org of orgs) {
      const ref = db.collection("orgs").doc(org.id);
      batch.set(
        ref,
        {
          orgId: org.id,
          name: org.name,
          displayName: org.name,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();

    return j(res, 200, { ok: true, count: orgs.length, orgIds: orgs.map((o) => o.id) });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e), count: 0, orgIds: [] });
  }
});

