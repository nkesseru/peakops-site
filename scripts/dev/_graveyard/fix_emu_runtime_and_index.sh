#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

# (0) clean ports + stray emulators/next
lsof -tiTCP:3000,5001,8080,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs

# (1) Ensure firebase.emu.json includes runtime (THIS FIXES "runtime field is required")
cat > firebase.emu.json <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs22" }
}
JSON
echo "✅ wrote firebase.emu.json (runtime=nodejs22)"

# (2) Ensure functions_emu scaffold exists + deps
mkdir -p functions_emu dist
cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "firebase-functions": "^6.6.0",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "esbuild": "^0.21.5"
  }
}
JSON
echo "✅ wrote functions_emu/package.json"

pushd functions_emu >/dev/null
npm i >/dev/null
popd >/dev/null
echo "✅ npm i (functions_emu)"

# (3) Transpile the ESM handlers -> CJS (emulator-safe)
node - <<'NODE'
const { buildSync } = require("./functions_emu/node_modules/esbuild");
const path = require("path");
const ROOT = process.cwd();
const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_emu", "dist");

const files = [
  ["getContractsV1.mjs",        "getContractsV1.cjs"],
  ["getContractV1.mjs",         "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs", "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs","writeContractPayloadV1.cjs"],
];

for (const [src, out] of files) {
  buildSync({
    entryPoints: [path.join(SRC, src)],
    outfile: path.join(OUT, out),
    platform: "node",
    format: "cjs",
    bundle: true,
    sourcemap: false,
    logLevel: "silent",
  });
}
console.log("✅ transpiled:", files.map(x => x[1]).join(", "));
NODE

# (4) Write CJS index.js with SAFE resolver (default vs named) + hard error if wrong
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

function pickFn(mod, preferredName) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;
  if (preferredName && typeof mod[preferredName] === "function") return mod[preferredName];
  if (typeof mod.default === "function") return mod.default;
  // common pattern: module exports { handler } or { handleX }
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") return mod[k];
  }
  return null;
}

function load(name, preferredName) {
  const mod = require(`./dist/${name}.cjs`);
  const fn = pickFn(mod, preferredName);
  if (!fn) {
    const keys = mod ? Object.keys(mod) : [];
    throw new Error(`Handler for ${name} is not a function. keys=${JSON.stringify(keys)}`);
  }
  return fn;
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));

exports.getContractsV1        = onRequest(load("getContractsV1", "getContractsV1"));
exports.getContractV1         = onRequest(load("getContractV1", "getContractV1"));
exports.getContractPayloadsV1 = onRequest(load("getContractPayloadsV1", "getContractPayloadsV1"));
exports.writeContractPayloadV1= onRequest(load("writeContractPayloadV1", "writeContractPayloadV1"));
JS
echo "✅ wrote functions_emu/index.js"

# (5) Start emulators using firebase.emu.json
firebase emulators:start --only functions,firestore \
  --project peakops-pilot \
  --config firebase.emu.json \
  > .logs/emulators.log 2>&1 &

EMU_PID=$!
FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"

# wait for hello
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

# (6) Start Next
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next OK (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo
echo "✅ SMOKE:"
curl -sS "$FN_BASE/hello" | head -c 120; echo
curl -sS "$FN_BASE/getContractsV1?orgId=org_001&limit=5" | head -c 200; echo

echo
echo "✅ UI:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
