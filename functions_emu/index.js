const { onRequest } = require("firebase-functions/v2/https");

function pick(mod) {
  // allow either default export or named function export
  if (typeof mod === "function") return mod;
  if (mod && typeof mod.default === "function") return mod.default;
  // if module has exactly one function export, use it
  if (mod && typeof mod === "object") {
    const fns = Object.values(mod).filter(v => typeof v === "function");
    if (fns.length === 1) return fns[0];
  }
  return null;
}

function req(name, file) {
  const mod = require(file);
  const fn = pick(mod);
  if (!fn) throw new Error(`could not resolve handler for ${name} from ${file}`);
  return fn;
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));

exports.getContractsV1         = onRequest(req("getContractsV1",         "./dist/getContractsV1.cjs"));
exports.getContractV1          = onRequest(req("getContractV1",          "./dist/getContractV1.cjs"));
exports.getContractPayloadsV1  = onRequest(req("getContractPayloadsV1",  "./dist/getContractPayloadsV1.cjs"));
exports.writeContractPayloadV1 = onRequest(req("writeContractPayloadV1", "./dist/writeContractPayloadV1.cjs"));
exports.exportContractPacketV1 = onRequest(req("exportContractPacketV1", "./dist/exportContractPacketV1.cjs"));

// Phase 2:
exports.getWorkflowV1          = onRequest(req("getWorkflowV1",          "./dist/getWorkflowV1.cjs"));
