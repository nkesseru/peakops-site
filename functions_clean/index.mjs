import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { nowIso, requireStr, optionalStr, pick } from "./api.mjs";
import { sha256OfObject } from "./audit.mjs";

if (!getApps().length) initializeApp();

export const hello = onRequest((req, res) => {
  res.json({ ok: true, msg: "hello from functions_clean" });
});

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const draftsByType = (body.draftsByType && typeof body.draftsByType === "object") ? body.draftsByType : null;

    if (!incidentId || !orgId) {
      return res.status(400).json({ ok: false, error: "Missing incidentId/orgId", gotKeys: Object.keys(body) });
    }
    if (!draftsByType) {
      return res.status(400).json({ ok: false, error: "Missing draftsByType", gotKeys: Object.keys(body) });
    }

    const filingTypes = Object.keys(draftsByType);
    if (filingTypes.length === 0) {
      return res.status(400).json({ ok: false, error: "draftsByType is empty" });
    }

    const compliance = body.compliance ?? null;
    const generatorVersion = body.generatorVersion ?? "v1";

    // Hash compliance once (shared across all filing docs)
    const complianceHash = compliance ? sha256OfObject(compliance).hash : null;

    const db = getFirestore();
    const now = new Date().toISOString();
    const batch = db.batch();

    for (const type of filingTypes) {
      const draft = draftsByType[type] ?? {};
      const payload = draft.payload ?? {};
      const payloadHash = sha256OfObject(payload).hash;

      const ref = db.collection("incidents").doc(incidentId).collection("filings").doc(type);

      batch.set(ref, {
        id: type,
        orgId,
        incidentId,
        type,

        status: "DRAFT",

        payload,
        payloadHash: payloadHash ? { algo: "SHA256", value: payloadHash } : null,

        complianceSnapshot: compliance,
        complianceHash: complianceHash ? { algo: "SHA256", value: complianceHash } : null,

        generatedAt: draft.generatedAt ?? now,
        generatorVersion,

        createdAt: now,
        updatedAt: now,
        createdBy: "system",
      }, { merge: true });
    }

    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "filing.package.persisted",
      message: "Persisted filing drafts + hashes (Step 2.8)",
      context: {
        filingTypes,
        generatorVersion,
        complianceOk: compliance?.ok ?? null,
        complianceHash,
      },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();
    return res.json({ ok: true, persisted: filingTypes, systemLogId: logRef.id, complianceHash });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

import { generateTimelineLevel1 } from "./timeline.mjs";

export const generateTimelineAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const incidentId = body.incidentId;
    const orgId = body.orgId;

    if (!incidentId || !orgId) {
      return res.status(400).json({ ok: false, error: "Missing incidentId/orgId", gotKeys: Object.keys(body) });
    }

    const db = getFirestore();
    const now = new Date().toISOString();

    // 1) Load incident
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return res.status(404).json({ ok: false, error: "Incident not found" });

    const inc = incSnap.data() || {};
    const incident = {
      id: incidentId,
      orgId,
      title: inc.title || "(untitled)",
      startTime: inc.startTime || inc.createdAt || now,
      detectedTime: inc.detectedTime || null,
      resolvedTime: inc.resolvedTime || null,
    };

    // 2) Load filings subcollection
    const filingsSnap = await incRef.collection("filings").get();
    const filings = filingsSnap.docs.map(d => {
      const x = d.data() || {};
      return {
        id: d.id,
        type: x.type || d.id,
        status: x.status || "UNKNOWN",
        generatedAt: x.generatedAt || null,
        createdAt: x.createdAt || null,
        updatedAt: x.updatedAt || null,
      };
    });

    // 3) Load system logs for this incident (limit to recent 200)
    const logsSnap = await db.collection("system_logs")
      .where("incidentId", "==", incidentId)
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const systemLogs = logsSnap.docs.map(d => {
      const x = d.data() || {};
      return {
        id: d.id,
        event: x.event || "",
        message: x.message || "",
        createdAt: x.createdAt || now,
      };
    }).reverse(); 

    const [userSnap, filingSnap] = await Promise.all([
      db.collection("user_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
      db.collection("filing_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
    ]);

    const userLogs = userSnap.docs.map(d => ({ id: d.id, ...((d.data())||{}) })).reverse();
    const filingLogs = filingSnap.docs.map(d => ({ id: d.id, ...((d.data())||{}) })).reverse();
// oldest -> newest

    // 4) Generate timeline + hash
    const { events, timelineHash, generatedAt } = generateTimelineLevel1({ incident, filings, systemLogs, userLogs, filingLogs });

    // 5) Persist events (batch). (Safe under 500; if you exceed later, we chunk.)
    const batch = db.batch();
    const tlCol = incRef.collection("timelineEvents");

    for (const ev of events) {
      batch.set(tlCol.doc(ev.id), ev, { merge: true });
    }

    // 6) Persist timeline meta + hash on incident
    batch.set(incRef, {
      timelineMeta: {
        algo: "SHA256",
        timelineHash,
        generatedAt,
        eventCount: events.length,
        source: "system",
      },
      updatedAt: now,
    }, { merge: true });

    // 7) System log entry
    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "timeline.generated",
      message: "Generated and persisted timelineEvents + timelineHash (Step 3C/3D)",
      context: { eventCount: events.length, timelineHash },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();

    return res.json({ ok: true, incidentId, eventCount: events.length, timelineHash, generatedAt, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


// USER ACTION LOG
export const logUserAction = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const orgId = requireStr(body.orgId, "orgId");
    const incidentId = body.incidentId ? requireStr(body.incidentId, "incidentId") : null;
    const userId = requireStr(body.userId, "userId");
    const action = requireStr(body.action, "action"); // e.g. "incident.viewed"
    const message = typeof body.message === "string" ? body.message : "";
    const context = (body.context && typeof body.context === "object") ? body.context : {};

    const db = getFirestore();
    const createdAt = nowIso();

    const ref = db.collection("user_action_logs").doc();
    await ref.set({
      orgId,
      incidentId,
      userId,
      action,
      message,
      context,
      createdAt,
    });

    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// FILING ACTION LOG
export const logFilingAction = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const orgId = requireStr(body.orgId, "orgId");
    const incidentId = requireStr(body.incidentId, "incidentId");
    const filingType = requireStr(body.filingType, "filingType"); // "DIRS" etc
    const userId = body.userId ? requireStr(body.userId, "userId") : "system";
    const action = requireStr(body.action, "action"); // "submitted" | "amended" | "accepted" | "rejected" | "status_changed"
    const message = typeof body.message === "string" ? body.message : "";
    const context = (body.context && typeof body.context === "object") ? body.context : {};

    const db = getFirestore();
    const createdAt = nowIso();

    const ref = db.collection("filing_action_logs").doc();
    await ref.set({
      orgId,
      incidentId,
      filingType,
      userId,
      action,
      message,
      context,
      createdAt,
    });

    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// ADMIN VIEWER: fetch recent logs for an incident
export const getIncidentLogs = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET" });

    const incidentId = req.query.incidentId;
    const orgId = req.query.orgId;
    if (typeof incidentId !== "string" || typeof orgId !== "string") {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId query params" });
    }

    const db = getFirestore();

    const [sysSnap, userSnap, filingSnap] = await Promise.all([
      db.collection("system_logs").where("incidentId", "==", incidentId).orderBy("createdAt", "desc").limit(50).get(),
      db.collection("user_action_logs").where("incidentId", "==", incidentId).orderBy("createdAt", "desc").limit(50).get(),
      db.collection("filing_action_logs").where("incidentId", "==", incidentId).orderBy("createdAt", "desc").limit(50).get(),
    ]);

    const toList = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      ok: true,
      incidentId,
      orgId,
      system: toList(sysSnap),
      user: toList(userSnap),
      filing: toList(filingSnap),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// TEMP ADMIN HELPER (REMOVE BEFORE PROD)
export const setUserRole = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const uid = body.uid;
    const orgId = body.orgId;
    const role = body.role;

    if (!uid || !orgId || !role) return res.status(400).json({ ok:false, error:"Need uid, orgId, role" });

    const db = getFirestore();
    await db.collection("users").doc(uid).set({
      orgRoles: { [orgId]: role },
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }, { merge: true });

    return res.json({ ok:true, uid, orgId, role });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});


// CREATE INCIDENT (canonical entrypoint)
export const createIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const orgId = requireStr(body.orgId, "orgId");
    const title = requireStr(body.title, "title");
    const startTime = optionalStr(body.startTime) || nowIso();

    const incidentId = optionalStr(body.incidentId) || `inc_${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = nowIso();

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId);

    await ref.set({
      id: incidentId,
      orgId,
      title,
      description: optionalStr(body.description) || "",
      status: body.status || "ACTIVE",
      startTime,
      detectedTime: optionalStr(body.detectedTime),
      resolvedTime: optionalStr(body.resolvedTime),
      location: (body.location && typeof body.location === "object") ? body.location : null,
      affectedCustomers: (typeof body.affectedCustomers === "number") ? body.affectedCustomers : null,
      filingTypesRequired: Array.isArray(body.filingTypesRequired) ? body.filingTypesRequired : ["DIRS","OE_417"],
      createdAt,
      updatedAt: createdAt,
      createdBy: body.createdBy || "system",
    }, { merge: true });

    // system log
    await getFirestore().collection("system_logs").doc().set({
      orgId,
      incidentId,
      level: "INFO",
      event: "incident.created",
      message: "Incident created via API",
      context: { title },
      actor: { type: "SYSTEM" },
      createdAt
    });

    return res.json({ ok: true, incidentId });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// UPDATE INCIDENT (safe patch)
export const updateIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = requireStr(body.incidentId, "incidentId");
    const orgId = requireStr(body.orgId, "orgId");

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const patch = pick(body, [
      "title","description","status","detectedTime","resolvedTime","location","affectedCustomers","filingTypesRequired"
    ]);
    patch.updatedAt = nowIso();

    await ref.set(patch, { merge: true });

    await db.collection("system_logs").doc().set({
      orgId,
      incidentId,
      level: "INFO",
      event: "incident.updated",
      message: "Incident updated via API",
      context: { changedKeys: Object.keys(patch) },
      actor: { type: "SYSTEM" },
      createdAt: patch.updatedAt
    });

    return res.json({ ok:true, incidentId });
  } catch (e) {
    return res.status(400).json({ ok:false, error: String(e) });
  }
});

// GET INCIDENT (for UI)
export const getIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const incidentId = req.query.incidentId;
    if (typeof incidentId !== "string") return res.status(400).json({ ok:false, error:"Missing incidentId" });

    const db = getFirestore();
    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    return res.json({ ok:true, incident: { id: snap.id, ...snap.data() } });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// ATTACH EVIDENCE (stub)
export const attachEvidenceStub = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = requireStr(body.incidentId, "incidentId");
    const orgId = requireStr(body.orgId, "orgId");

    const evidenceId = optionalStr(body.evidenceId) || `ev_${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = nowIso();

    const db = getFirestore();
    await db.collection("incidents").doc(incidentId).collection("evidence").doc(evidenceId).set({
      id: evidenceId,
      orgId,
      incidentId,
      type: body.type || "OTHER",
      status: body.status || "PENDING",
      title: optionalStr(body.title),
      description: optionalStr(body.description),
      createdAt,
      updatedAt: createdAt
    }, { merge: true });

    await db.collection("system_logs").doc().set({
      orgId,
      incidentId,
      level: "INFO",
      event: "evidence.attached",
      message: "Evidence attached (stub)",
      context: { evidenceId },
      actor: { type: "SYSTEM" },
      createdAt
    });

    return res.json({ ok:true, evidenceId });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// LIST INCIDENTS (admin/supervisor UI)
export const listIncidents = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = req.query.orgId;
    if (typeof orgId !== "string") return res.status(400).json({ ok:false, error:"Missing orgId" });

    const db = getFirestore();
    const snap = await db.collection("incidents")
      .where("orgId","==",orgId)
      .orderBy("updatedAt","desc")
      .limit(50)
      .get();

    const incidents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, incidents });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// INCIDENT BUNDLE (one call for admin detail page)
export const getIncidentBundle = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const incidentId = req.query.incidentId;
    const orgId = req.query.orgId;

    if (typeof incidentId !== "string" || typeof orgId !== "string") {
      return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });
    }

    const db = getFirestore();

    const incSnap = await db.collection("incidents").doc(incidentId).get();
    if (!incSnap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const filingsSnap = await db.collection("incidents").doc(incidentId).collection("filings").get();
    const filings = filingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const timelineMeta = (incSnap.data() || {}).timelineMeta || null;

    const [sysSnap, userSnap, filingSnap] = await Promise.all([
      db.collection("system_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(50).get(),
      db.collection("user_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(50).get(),
      db.collection("filing_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(50).get(),
    ]);

    const system = sysSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const user = userSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const filing = filingSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      ok: true,
      orgId,
      incident: { id: incSnap.id, ...incSnap.data() },
      filings,
      timelineMeta,
      logs: { system, user, filing }
    });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// Generate filings using existing incident doc (no client stub payload)
export const generateFilingPackageFromIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = body.incidentId;
    const orgId = body.orgId;
    if (!incidentId || !orgId) return res.status(400).json({ ok:false, error:"Missing incidentId/orgId" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const snap = await incRef.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const inc = snap.data() || {};
    const now = new Date().toISOString();

    const filingTypes = Array.isArray(inc.filingTypesRequired) && inc.filingTypesRequired.length
      ? inc.filingTypesRequired
      : ["DIRS","OE_417","NORS","SAR","BABA"];

    // Build drafts from incident fields (basic v1)
    const draftsByType = {};
    for (const t of filingTypes) {
      draftsByType[t] = {
        generatedAt: now,
        payload: {
          filingType: t,
          incidentId,
          orgId,
          title: inc.title || "",
          description: inc.description || "",
          startTime: inc.startTime || inc.createdAt || now,
          detectedTime: inc.detectedTime || null,
          resolvedTime: inc.resolvedTime || null,
          location: inc.location || null,
          affectedCustomers: inc.affectedCustomers ?? null,
          meta: { source: "peakops", schemaVersion: `${String(t).toLowerCase()}.v1` }
        }
      };
    }

    // Call the existing persist endpoint logic by reusing the same code path:
    // (We just invoke generateFilingPackageAndPersist via fetch to local function URL)
    const fnBase = "http://127.0.0.1:5001/peakops-pilot/us-central1";
    const r = await fetch(`${fnBase}/generateFilingPackageAndPersist`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        incidentId,
        orgId,
        title: inc.title || "",
        startTime: inc.startTime || now,
        draftsByType,
        compliance: null,
        generatorVersion: "v1"
      })
    });

    const out = await r.json();
    return res.json({ ok:true, incidentId, result: out });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

import { writeUsageEvent, nowIso as nowIsoUsage } from "./usage.mjs";

// =========================
// 8A/8C V2: Guardrails + Usage
// =========================

// Generate filings from incident doc with skip logic based on payloadHash comparison
export const generateFilingsV2 = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const requestedBy = body.requestedBy || "system";

    if (!incidentId || !orgId) return res.status(400).json({ ok: false, error: "Missing incidentId/orgId" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return res.status(404).json({ ok: false, error: "Incident not found" });

    const inc = incSnap.data() || {};
    const now = new Date().toISOString();

    const filingTypes = Array.isArray(inc.filingTypesRequired) && inc.filingTypesRequired.length
      ? inc.filingTypesRequired
      : ["DIRS","OE_417","NORS","SAR","BABA"];

    // Pull existing filings once
    const existingSnap = await incRef.collection("filings").get();
    const existingByType = {};
    for (const d of existingSnap.docs) existingByType[d.id] = d.data() || {};

    const changed = [];
    const skipped = [];

    const batch = db.batch();

    for (const t of filingTypes) {
      const payload = {
        filingType: t,
        incidentId,
        orgId,
        title: inc.title || "",
        description: inc.description || "",
        startTime: inc.startTime || inc.createdAt || now,
        detectedTime: inc.detectedTime || null,
        resolvedTime: inc.resolvedTime || null,
        location: inc.location || null,
        affectedCustomers: (inc.affectedCustomers ?? null),
        meta: { source: "peakops", schemaVersion: `${String(t).toLowerCase()}.v1` }
      };

      const newHash = sha256OfObject(payload).hash;

      const old = existingByType[t];
      const oldHash = old?.payloadHash?.value || old?.payloadHash?.mapValue?.fields?.value?.stringValue || null;

      if (oldHash && oldHash === newHash) {
        skipped.push(t);
        continue;
      }

      changed.push(t);

      const ref = incRef.collection("filings").doc(t);
      batch.set(ref, {
        id: t,
        orgId,
        incidentId,
        type: t,
        status: old?.status || "DRAFT",
        payload,
        payloadHash: { algo: "SHA256", value: newHash },
        complianceSnapshot: old?.complianceSnapshot ?? null,
        complianceHash: old?.complianceHash ?? null,
        generatorVersion: "v1",
        generatedAt: now,
        updatedAt: now,
        createdAt: old?.createdAt || now,
        createdBy: old?.createdBy || requestedBy
      }, { merge: true });
    }

    // Update incident meta
    batch.set(incRef, {
      filingsMeta: {
        generatedAt: now,
        changedCount: changed.length,
        skippedCount: skipped.length,
        requestedBy,
      },
      updatedAt: now,
    }, { merge: true });

    // System log
    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "filings.generated",
      message: "Generated filings with guardrails (V2)",
      context: { changed, skipped, count: changed.length, skippedCount: skipped.length },
      actor: { type: "SYSTEM" },
      createdAt: now
    });

    await batch.commit();

    // Usage event
    const usageId = await writeUsageEvent(db, {
      orgId,
      incidentId,
      action: "filings",
      requestedBy,
      changedCount: changed.length,
      skippedCount: skipped.length,
      status: "ok"
    });

    return res.json({ ok: true, incidentId, changed, skipped, usageId, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Generate timeline with guardrail: if hash unchanged, skip writes
export const generateTimelineV2 = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const requestedBy = body.requestedBy || "system";

    if (!incidentId || !orgId) return res.status(400).json({ ok: false, error: "Missing incidentId/orgId" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return res.status(404).json({ ok: false, error: "Incident not found" });

    const inc = incSnap.data() || {};
    const now = new Date().toISOString();

    const incident = {
      id: incidentId,
      orgId,
      title: inc.title || "(untitled)",
      startTime: inc.startTime || inc.createdAt || now,
      detectedTime: inc.detectedTime || null,
      resolvedTime: inc.resolvedTime || null,
    };

    // filings
    const filingsSnap = await incRef.collection("filings").get();
    const filings = filingsSnap.docs.map(d => {
      const x = d.data() || {};
      return { id: d.id, type: x.type || d.id, status: x.status || "DRAFT", generatedAt: x.generatedAt || null, createdAt: x.createdAt || null, updatedAt: x.updatedAt || null };
    });

    // logs
    const [sysSnap, userSnap, filingSnap] = await Promise.all([
      db.collection("system_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
      db.collection("user_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
      db.collection("filing_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
    ]);

    const systemLogs = sysSnap.docs.map(d => ({ id: d.id, ...(d.data()||{}) })).reverse();
    const userLogs = userSnap.docs.map(d => ({ id: d.id, ...(d.data()||{}) })).reverse();
    const filingLogs = filingSnap.docs.map(d => ({ id: d.id, ...(d.data()||{}) })).reverse();

    const { events, timelineHash, generatedAt } = generateTimelineLevel1({ incident, filings, systemLogs, userLogs, filingLogs });

    const existingHash = inc?.timelineMeta?.timelineHash || null;
    if (existingHash && existingHash === timelineHash) {
      const usageId = await writeUsageEvent(db, { orgId, incidentId, action: "timeline", requestedBy, changedCount: 0, skippedCount: events.length, status: "skipped_same_hash" });
      return res.json({ ok: true, incidentId, skipped: true, reason: "hash_unchanged", eventCount: events.length, timelineHash, usageId });
    }

    const batch = db.batch();
    const tlCol = incRef.collection("timelineEvents");

    for (const ev of events) batch.set(tlCol.doc(ev.id), ev, { merge: true });

    batch.set(incRef, {
      timelineMeta: { algo: "SHA256", timelineHash, generatedAt, eventCount: events.length, source: "system" },
      updatedAt: now
    }, { merge: true });

    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId, incidentId, level: "INFO", event: "timeline.generated",
      message: "Generated and persisted timeline (V2)",
      context: { eventCount: events.length, timelineHash },
      actor: { type: "SYSTEM" }, createdAt: now
    });

    await batch.commit();

    const usageId = await writeUsageEvent(db, { orgId, incidentId, action: "timeline", requestedBy, changedCount: events.length, skippedCount: 0, status: "ok" });

    return res.json({ ok: true, incidentId, eventCount: events.length, timelineHash, usageId, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Combined (single usage event for “both”)
export const generateBothV2 = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const requestedBy = body.requestedBy || "system";
    if (!incidentId || !orgId) return res.status(400).json({ ok:false, error:"Missing incidentId/orgId" });

    // call internal V2 endpoints by direct function invoke via fetch through the same local host
    const fnBase = "http://127.0.0.1:5001/peakops-pilot/us-central1";
    const [aRes, bRes] = await Promise.all([
      fetch(`${fnBase}/generateFilingsV2`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ incidentId, orgId, requestedBy }) }),
      fetch(`${fnBase}/generateTimelineV2`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ incidentId, orgId, requestedBy }) }),
    ]);

    const a = await aRes.json();
    const b = await bRes.json();

    const db = getFirestore();
    const usageId = await writeUsageEvent(db, {
      orgId,
      incidentId,
      action: "both",
      requestedBy,
      changedCount: (a?.changed?.length || 0) + (b?.eventCount || 0),
      skippedCount: (a?.skipped?.length || 0) + (b?.skipped ? (b?.eventCount || 0) : 0),
      status: "ok"
    });

    return res.json({ ok:true, incidentId, filings: a, timeline: b, usageId });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

// Timeline events (for UI)
export const getTimelineEvents = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const incidentId = req.query.incidentId;
    const orgId = req.query.orgId;
    if (typeof incidentId !== "string" || typeof orgId !== "string") {
      return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });
    }

    const db = getFirestore();
    const snap = await db.collection("incidents").doc(incidentId)
      .collection("timelineEvents")
      .orderBy("occurredAt","asc")
      .limit(200)
      .get();

    const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, incidentId, events });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// Usage events list (admin)
export const listUsageEvents = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = req.query.orgId;
    if (typeof orgId !== "string") return res.status(400).json({ ok:false, error:"Missing orgId" });

    const db = getFirestore();
    const snap = await db.collection("usage_events")
      .where("orgId","==",orgId)
      .orderBy("createdAt","desc")
      .limit(200)
      .get();

    const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // quick rollups
    const totals = { filings: 0, timeline: 0, both: 0, changed: 0, skipped: 0 };
    for (const e of events) {
      const a = e.action;
      if (a === "filings") totals.filings++;
      if (a === "timeline") totals.timeline++;
      if (a === "both") totals.both++;
      totals.changed += Number(e.changedCount || 0);
      totals.skipped += Number(e.skippedCount || 0);
    }

    return res.json({ ok:true, orgId, totals, events });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// Filing status controls (Admin workflow)
export const setFilingStatusV1 = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const orgId = body.orgId;
    const incidentId = body.incidentId;
    const filingType = body.filingType; // DIRS/OE_417/NORS/SAR/BABA
    const toStatus = body.toStatus;     // READY/SUBMITTED/AMENDED/CANCELLED/DRAFT
    const userId = body.userId || "admin_ui";
    const message = body.message || "";
    const cancelReason = body.cancelReason || "";
    const cancelOverride = !!body.cancelOverride;
    const submissionMethod = body.submissionMethod || "MANUAL";
    const confirmationId = body.confirmationId || "";
    const override = !!body.override;

    if (!orgId || !incidentId || !filingType || !toStatus) {
      return res.status(400).json({ ok:false, error:"Missing orgId/incidentId/filingType/toStatus" });
    }

    const now = nowIso();

    const db = getFirestore();
    const filingRef = db.collection("incidents").doc(incidentId).collection("filings").doc(filingType);
    const snap = await filingRef.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Filing not found" });

    const prev = snap.data() || {};
    const fromStatus = prev.status || "DRAFT";

    // build patch
    const patch = {
      status: toStatus,
      updatedAt: now,
    };

    if (toStatus === "SUBMITTED") {
      // Guardrail: require READY unless override
      if (!override && fromStatus !== "READY") {
        return res.status(400).json({ ok:false, error:`Must be READY before SUBMITTED (current: ${fromStatus})` });
      }

    if (toStatus === "AMENDED") {
      patch.amendedAt = now;
      patch.amendedBy = userId;
    }

    if (toStatus === "CANCELLED") {
      if (!cancelOverride && !String(cancelReason || "").trim()) {
        return res.status(400).json({ ok:false, error:"cancelReason required for CANCELLED" });
      }
      patch.cancelledAt = now;
      patch.cancelledBy = userId;
    }

      if (!confirmationId) return res.status(400).json({ ok:false, error:"confirmationId required for SUBMITTED" });
      patch.submittedAt = now;
      patch.submittedBy = userId;
      patch.external = {
        ...(prev.external || {}),
        confirmationId,
        submissionMethod,
      };
    }

    // write filing_action_logs
    const actionRef = db.collection("filing_action_logs").doc();
    const actionDoc = {
      orgId,
      incidentId,
      filingType,
      userId,
      action: "status_changed",
      from: fromStatus,
      to: toStatus,
      message,
      context: {
        confirmationId: confirmationId || null,
        submissionMethod: submissionMethod || null,
        cancelReason: cancelReason ? String(cancelReason) : null,
      },
      createdAt: now,
    };

    // add timeline event
    const tlRef = db.collection("incidents").doc(incidentId).collection("timelineEvents").doc();
    const tlDoc = {
      id: tlRef.id,
      orgId,
      incidentId,
      type: (toStatus === "SUBMITTED") ? "FILING_SUBMITTED" : "SYSTEM_NOTE",
      occurredAt: now,
      title: (toStatus === "SUBMITTED")
        ? `Filing submitted: ${filingType}`
        : `Filing status changed: ${filingType}`,
      message: (toStatus === "SUBMITTED")
        ? `Submitted (${submissionMethod}) · Confirmation: ${confirmationId}`
        : `${fromStatus} → ${toStatus}`,
      links: { filingId: filingType, userId },
      source: "SYSTEM",
      createdAt: now,
    };

    const batch = db.batch();
    batch.set(filingRef, patch, { merge: true });
    batch.set(actionRef, actionDoc);
    batch.set(tlRef, tlDoc);

    await batch.commit();

    return res.json({
      ok: true,
      orgId,
      incidentId,
      filingType,
      fromStatus,
      toStatus,
      filingActionLogId: actionRef.id,
      timelineEventId: tlRef.id,
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
