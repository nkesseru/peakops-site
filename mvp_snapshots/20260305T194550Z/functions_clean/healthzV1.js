const { onRequest } = require("firebase-functions/v2/https");

exports.healthzV1 = onRequest({ cors: true }, (req, res) => {
  res.status(200).json({
    ok: true,
    service: "functions",
    status: "healthy",
    ts: Date.now()
  });
});
