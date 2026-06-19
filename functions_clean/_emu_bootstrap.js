const fs = require("fs");
const path = require("path");

function parseEnv(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    // strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

(function bootstrap() {
  try {
    // PEAKOPS_EMU_BOOTSTRAP_GATE_V1
    // env.runtime is a local-dev convenience file that ships with the repo and
    // contains emulator hints like FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199.
    // Firebase Functions bundles the whole functions_clean/ directory when it
    // deploys, so env.runtime lands in the production container too. Previously
    // we loaded it unconditionally, which poisoned process.env in production:
    // the deployed createEvidenceUploadUrlV1 saw FIREBASE_STORAGE_EMULATOR_HOST
    // and returned http://127.0.0.1:9199/... upload URLs to browsers.
    //
    // Only load env.runtime when we are actually running under the Firebase
    // emulator suite. FUNCTIONS_EMULATOR=true is set by the emulator itself and
    // is never set by the deployed Cloud Functions runtime. This is the single
    // canonical signal.
    const isEmulator = String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";
    if (!isEmulator) {
      // Deployed runtime: do not read env.runtime at all.
      return;
    }
    const envPath = path.join(__dirname, "env.runtime"); // NOTE: no leading dot
    if (fs.existsSync(envPath)) {
      parseEnv(fs.readFileSync(envPath, "utf8"));
      console.log("🔥 _emu_bootstrap loaded env.runtime (emulator):", envPath);
    } else {
      console.log("ℹ️ _emu_bootstrap: env.runtime missing (emulator):", envPath);
    }
  } catch (e) {
    console.warn("⚠️ _emu_bootstrap failed (continuing):", String(e?.message || e));
  }
})();
