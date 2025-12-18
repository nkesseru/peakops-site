import { onRequest } from "firebase-functions/v2/https";

export const hello = onRequest((req, res) => {
  res.json({ ok: true, msg: "functions emulator is loading index.mjs" });
});
