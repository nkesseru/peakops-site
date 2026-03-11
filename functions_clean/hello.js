const { onRequest } = require("firebase-functions/v2/https");

exports.hello = onRequest({ cors: true }, async (req, res) => {
  res.status(200).json({
    ok: true,
    message: "hello",
    service: "functions_clean",
  });
});
