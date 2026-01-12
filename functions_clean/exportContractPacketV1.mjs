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
