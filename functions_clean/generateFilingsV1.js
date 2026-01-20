const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function readJson(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (req.rawBody) return JSON.parse(req.rawBody.toString("utf8") || "{}");
  } catch {}
  return {};
}

exports.generateFilingsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const payload = readJson(req);
    const orgId = String(payload.orgId || req.query.orgId || "").trim();
    const incidentId = String(payload.incidentId || req.query.incidentId || "").trim();
    const requestedBy = String(payload.requestedBy || req.query.requestedBy || "unknown").trim();
    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    const incidentRef = db.collection("incidents").doc(incidentId);
    const snap = await incidentRef.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const nowIso = new Date().toISOString();
    const nowTs = Timestamp.now();

    const filings = [
      { id:"dirs_draft",  type:"DIRS",  status:"DRAFT", title:"DIRS draft",   updatedAt: nowIso },
      { id:"oe417_draft", type:"OE_417", status:"DRAFT", title:"OE-417 draft", updatedAt: nowIso },
    ];

    const batch = db.batch();
    const col = incidentRef.collection("filings");
    for (const f of filings) {
      batch.set(col.doc(f.id), {
        ...f, orgId, incidentId, requestedBy,
        createdAt: nowTs,
        updatedAtTs: nowTs,
      }, { merge:true });
    }

    batch.set(incidentRef.collection("timeline_events").doc("t2_filings"), {
      id:"t2_filings",
      type:"FILINGS_GENERATED",
      title:"Filings generated",
      message:"Stub filings generated.",
      occurredAt: nowIso,
      orgId, incidentId, requestedBy,
      createdAt: nowTs,
      updatedAt: nowTs,
    }, { merge:true });

    await batch.commit();
    return res.status(200).json({ ok:true, orgId, incidentId, requestedBy, count: filings.length, docs: filings });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});
