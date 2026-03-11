const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function isDevOnlyAllowed() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";
}

function parseFirebaseConfigProjectId() {
  try {
    const raw = String(process.env.FIREBASE_CONFIG || "").trim();
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return String(parsed?.projectId || "").trim();
  } catch {
    return "";
  }
}

exports.debugOrgsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (!isDevOnlyAllowed()) return j(res, 403, { ok: false, error: "dev_only" });
    if (req.method !== "GET" && req.method !== "POST") {
      return j(res, 405, { ok: false, error: "GET or POST required" });
    }

    const db = getFirestore();
    const snap = await db.collection("orgs").limit(20).get();
    const ids = snap.docs.map((d) => d.id);
    return j(res, 200, {
      ok: true,
      projectId:
        String(process.env.GCLOUD_PROJECT || "").trim() ||
        parseFirebaseConfigProjectId() ||
        String(admin.app().options?.projectId || "").trim() ||
        null,
      firebaseConfigProjectId: parseFirebaseConfigProjectId() || null,
      adminProjectId: String(admin.app().options?.projectId || "").trim() || null,
      firestoreEmulatorHost: String(process.env.FIRESTORE_EMULATOR_HOST || "").trim() || null,
      functionsEmulator: String(process.env.FUNCTIONS_EMULATOR || "").trim() || null,
      functionsBaseHint: `${req.protocol}://${req.get("host")}`,
      orgsCount: ids.length,
      orgIds: ids,
    });
  } catch (e) {
    return j(res, 400, { ok: false, error: String(e?.message || e), orgsCount: 0, orgIds: [] });
  }
});

