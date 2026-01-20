#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"
cd "$ROOT"

echo "==> (0) Ensure logs dir"
mkdir -p .logs

echo "==> (1) Write functions_clean/exportContractPacketV1.mjs (ESM source)"
cat > functions_clean/exportContractPacketV1.mjs <<'MJS'
import crypto from "crypto";
import JSZip from "jszip";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function tsISO(x) {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x._seconds === "number") {
    return new Date(x._seconds * 1000).toISOString();
  }
  if (x instanceof Timestamp) return x.toDate().toISOString();
  return String(x);
}

export default async function exportContractPacketV1(req, res) {
  try {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method not allowed" });

    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    const versionId = String(req.query.versionId || "v1").trim(); // default v1
    const limit = Number(req.query.limit || 200);

    if (!orgId || !contractId) return res.status(400).json({ ok:false, error:"Missing orgId/contractId" });

    // contract
    const cRef = db.collection("contracts").doc(contractId);
    const cSnap = await cRef.get();
    if (!cSnap.exists) return res.status(404).json({ ok:false, error:"Contract not found" });

    const contract = { id: contractId, ...cSnap.data() };

    // payloads (ALL by default; optionally you can filter by versionId later)
    const pSnap = await cRef.collection("payloads").limit(limit).get();
    const payloadDocs = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Build zip
    const zip = new JSZip();
    const manifest = {
      kind: "contract_packet",
      orgId,
      contractId,
      versionId,
      generatedAt: new Date().toISOString(),
      counts: {
        payloads: payloadDocs.length
      }
    };

    // folders
    zip.folder("contract")?.file("contract.json", JSON.stringify({
      ...contract,
      createdAt: tsISO(contract.createdAt),
      updatedAt: tsISO(contract.updatedAt),
    }, null, 2));

    const payloadFolder = zip.folder("payloads");
    for (const p of payloadDocs) {
      payloadFolder?.file(`${p.id}.json`, JSON.stringify({
        ...p,
        createdAt: tsISO(p.createdAt),
        updatedAt: tsISO(p.updatedAt),
      }, null, 2));
    }

    zip.file("manifest.json", JSON.stringify(manifest, null, 2));

    // hashes
    const filesForHash = [];
    filesForHash.push(["contract/contract.json", await zip.file("contract/contract.json").async("nodebuffer")]);
    for (const p of payloadDocs) {
      const path = `payloads/${p.id}.json`;
      filesForHash.push([path, await zip.file(path).async("nodebuffer")]);
    }
    filesForHash.push(["manifest.json", await zip.file("manifest.json").async("nodebuffer")]);

    const hashes = {};
    for (const [path, buf] of filesForHash) hashes[path] = sha256Hex(buf);
    zip.file("hashes.json", JSON.stringify(hashes, null, 2));

    // packet hash = sha256 of hashes.json bytes
    const hashesBuf = await zip.file("hashes.json").async("nodebuffer");
    const packetHash = sha256Hex(hashesBuf);
    zip.file("packet_hash.txt", packetHash + "\n");

    const outBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    const b64 = outBuf.toString("base64");

    const safeTs = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `peakops_contractpacket_${contractId}_${orgId}_${safeTs}_${packetHash.slice(0,8)}.zip`;

    return res.json({
      ok: true,
      orgId,
      contractId,
      versionId,
      count: payloadDocs.length,
      packetHash,
      sizeBytes: outBuf.length,
      filename,
      zipBase64: b64
    });
  } catch (e) {
    console.error("exportContractPacketV1 error:", e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
MJS

echo "==> (2) Ensure deps in functions_clean (jszip + esbuild)"
pushd functions_clean >/dev/null
# install deps if missing
pnpm add jszip >/dev/null 2>&1 || pnpm add jszip
pnpm add -D esbuild >/dev/null 2>&1 || pnpm add -D esbuild
popd >/dev/null

echo "==> (3) Bundle ESM handlers -> functions_clean/dist/*.cjs (deploy-safe)"
mkdir -p functions_clean/dist
node - <<'NODE'
const path = require("path");
const { buildSync } = require("./functions_clean/node_modules/esbuild");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_clean", "dist");

const files = [
  ["getContractsV1.mjs", "getContractsV1.cjs"],
  ["getContractV1.mjs", "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs", "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs", "writeContractPayloadV1.cjs"],
  ["exportContractPacketV1.mjs", "exportContractPacketV1.cjs"],
];

for (const [src, out] of files) {
  buildSync({
    entryPoints: [path.join(SRC, src)],
    outfile: path.join(OUT, out),
    platform: "node",
    format: "cjs",
    bundle: true,
    sourcemap: false,
    logLevel: "warning",
  });
}
console.log("✅ bundled:", files.map(x=>x[1]).join(", "));
NODE

echo "==> (4) Write functions_clean/index.js (CJS entrypoint for deploy)"
cat > functions_clean/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

function pick(mod) {
  // allow: module.exports = fn OR exports.default = fn OR named export
  if (!mod) return null;
  if (typeof mod === "function") return mod;
  if (typeof mod.default === "function") return mod.default;
  // first function export
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") return mod[k];
  }
  return null;
}

const getContractsV1 = pick(require("./dist/getContractsV1.cjs"));
const getContractV1 = pick(require("./dist/getContractV1.cjs"));
const getContractPayloadsV1 = pick(require("./dist/getContractPayloadsV1.cjs"));
const writeContractPayloadV1 = pick(require("./dist/writeContractPayloadV1.cjs"));
const exportContractPacketV1 = pick(require("./dist/exportContractPacketV1.cjs"));

if (!getContractsV1 || !getContractV1 || !getContractPayloadsV1 || !writeContractPayloadV1 || !exportContractPacketV1) {
  throw new Error("functions_clean index.js: could not resolve one or more handlers");
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_clean" }));
exports.getContractsV1 = onRequest(getContractsV1);
exports.getContractV1 = onRequest(getContractV1);
exports.getContractPayloadsV1 = onRequest(getContractPayloadsV1);
exports.writeContractPayloadV1 = onRequest(writeContractPayloadV1);
exports.exportContractPacketV1 = onRequest(exportContractPacketV1);
JS

echo "==> (5) Patch functions_clean/package.json for CJS deploy (main=index.js; no type=module)"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/package.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));

delete j.type;                 // critical: make it CJS so require() works
j.main = "index.js";
j.engines = j.engines || {};
j.engines.node = ">=20";

fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("✅ patched functions_clean/package.json");
NODE

echo "==> (6) Ensure firebase.json points to functions_clean + runtime nodejs20"
node - <<'NODE'
const fs = require("fs");
const p = "firebase.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));

j.functions = j.functions || {};
j.functions.source = "functions_clean";
j.functions.runtime = "nodejs20";

fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("✅ patched firebase.json (functions.source=functions_clean, runtime=nodejs20)");
NODE

echo "==> (7) Quick sanity: node can require functions_clean/index.js"
node -e "require('./functions_clean/index.js'); console.log('✅ require(index.js) OK')"

echo "==> (8) Deploy ONLY exportContractPacketV1"
firebase deploy --only functions:exportContractPacketV1
echo "✅ deploy OK"
