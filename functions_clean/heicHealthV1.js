const { onRequest } = require("firebase-functions/v2/https");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

async function commandExists(cmd) {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

exports.heicHealthV1 = onRequest({ cors: true }, async (_req, res) => {
  let sharpVersion = "";
  try {
    // eslint-disable-next-line global-require
    const sharpPkg = require("sharp/package.json");
    sharpVersion = String(sharpPkg?.version || "");
  } catch {
    sharpVersion = "";
  }

  const heifConvert = await commandExists("heif-convert");
  const sips = process.platform === "darwin" ? await commandExists("sips") : false;
  const allowSipsFallback = String(process.env.ALLOW_SIPS_FALLBACK || "") === "1";
  const prod = process.env.NODE_ENV === "production";
  const emulator = process.env.FUNCTIONS_EMULATOR === "true";

  res.status(200).json({
    ok: true,
    env: {
      nodeEnv: String(process.env.NODE_ENV || ""),
      functionsEmulator: emulator,
      allowSipsFallback,
      gcloudProject: String(process.env.GCLOUD_PROJECT || ""),
    },
    runtime: {
      platform: process.platform,
      sharpVersion,
      heifConvert,
      sips,
      fallbackMode: !prod && allowSipsFallback && sips ? "sips_allowed" : (heifConvert ? "heif-convert" : "sharp_only"),
    },
  });
});

