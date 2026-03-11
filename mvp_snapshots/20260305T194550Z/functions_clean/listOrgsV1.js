const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function applyCors(req, res) {
  const origin = String(req.get?.("origin") || "");
  const allow = origin || "http://127.0.0.1:3001";
  res.set("Access-Control-Allow-Origin", allow);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-peakops-demo");
  res.set("Access-Control-Allow-Credentials", "true");
}

exports.listOrgsV1 = onRequest(async (req, res) => {
  applyCors(req, res);

  if (String(req.method || "").toUpperCase() === "OPTIONS") {
    return res.status(204).send("");
  }
  if (String(req.method || "").toUpperCase() !== "GET") {
    return j(res, 405, { ok: false, error: "GET required" });
  }

  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  // orgId here is "current org" context; we still list all orgs for dev tools dropdowns
  const orgId = String(req.query.orgId || "").trim() || "";

  const db = getFirestore();

  // Prefer org directory docs if you have them; otherwise fall back to orgs/organizations/tenants
  const collections = ["orgs", "organizations", "tenants"];
  const out = [];
  const seen = new Set();

  for (const col of collections) {
    const snap = await db.collection(col).limit(limit).get().catch(() => null);
    if (!snap || snap.empty) continue;

    for (const d of snap.docs) {
      const x = d.data() || {};
      const resolvedOrgId = String(x.orgId || x.id || d.id || "").trim();
      if (!resolvedOrgId || seen.has(resolvedOrgId)) continue;
      seen.add(resolvedOrgId);
      out.push({
        id: d.id,
        orgId: resolvedOrgId,
        name: String(x.name || x.displayName || x.orgName || resolvedOrgId),
        source: col,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  return j(res, 200, { ok: true, orgId, count: out.length, docs: out });
});
