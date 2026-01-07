#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Ensure functions_clean has esbuild (use npm to avoid pnpm workspace issues)"
cd functions_clean
if [ ! -d node_modules/esbuild ]; then
  npm i -D esbuild >/dev/null
fi

echo "==> (2) Create build script to compile ESM index.mjs -> CJS index.js (bundle)"
cat > build.cjs <<'JS'
const esbuild = require("esbuild");

esbuild.buildSync({
  entryPoints: ["index.mjs"],
  outfile: "index.js",
  platform: "node",
  format: "cjs",
  target: ["node20"],
  bundle: true,
  sourcemap: false,
  logLevel: "info",
});
JS

echo "==> (3) Patch functions_clean/package.json to use CJS entry for emulator"
node - <<'NODE'
const fs = require("fs");
const p = "package.json";
const j = JSON.parse(fs.readFileSync(p,"utf8"));

j.main = "index.js";
// emulator loader uses require(); make it unambiguous CJS
if (j.type) delete j.type;

fs.writeFileSync(p, JSON.stringify(j,null,2) + "\n");
console.log("✅ package.json set to CJS entry: main=index.js (type removed)");
NODE

echo "==> (4) Build bundle + sanity check"
node build.cjs
node -c index.js
echo "✅ CJS bundle OK: functions_clean/index.js"

echo
echo "NEXT STEP: restart emulators"
echo "  cd ~/peakops/my-app && firebase emulators:start --only functions,firestore --project peakops-pilot"
