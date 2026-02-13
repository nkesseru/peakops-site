const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { handleListEvidenceLockerRequest } = require("./evidenceLockerApi.mjs");

if (!admin.apps.length) admin.initializeApp();

// Thin wrapper so Next can call /api/fn/listEvidenceLocker
exports.listEvidenceLocker = onRequest({ cors: true }, async (req, res) => {
  return handleListEvidenceLockerRequest(req, res);
});
