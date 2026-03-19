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
    const envPath = path.join(__dirname, "env.runtime"); // NOTE: no leading dot
    if (fs.existsSync(envPath)) {
      parseEnv(fs.readFileSync(envPath, "utf8"));
      console.log("🔥 _emu_bootstrap loaded env.runtime:", envPath);
    } else {
      console.log("ℹ️ _emu_bootstrap: env.runtime missing:", envPath);
    }
  } catch (e) {
    console.warn("⚠️ _emu_bootstrap failed (continuing):", String(e?.message || e));
  }
})();
