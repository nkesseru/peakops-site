"use strict";
// src/reliability/thresholdEngine.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReliabilityThresholds = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../firebase");
function evalStatus(value, warning, critical) {
    if (value === null || isNaN(value))
        return "OK";
    if (value >= critical)
        return "CRITICAL";
    if (value >= warning)
        return "WARN";
    return "OK";
}
function combineOverall(saidiStatus, saifiStatus, caidiStatus) {
    const statuses = [saidiStatus, saifiStatus, caidiStatus];
    if (statuses.includes("CRITICAL"))
        return "CRITICAL";
    if (statuses.includes("WARN"))
        return "WARN";
    return "OK";
}
exports.runReliabilityThresholds = (0, https_1.onRequest)(async (req, res) => {
    try {
        if (req.method !== "POST") {
            res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
            return;
        }
        const { orgId, year } = req.body || {};
        if (!orgId) {
            res.status(400).json({ error: "MISSING_ORG_ID" });
            return;
        }
        const configSnap = await firebase_1.db
            .collection("reliability_configs")
            .doc(orgId)
            .get();
        if (!configSnap.exists) {
            res.status(400).json({ error: "CONFIG_NOT_FOUND", orgId });
            return;
        }
        const config = configSnap.data();
        let query = firebase_1.db
            .collection("reliability_metrics")
            .where("orgId", "==", orgId);
        if (year) {
            query = query.where("year", "==", year);
        }
        const metricsSnap = await query.get();
        if (metricsSnap.empty) {
            res.json({ success: true, processed: 0, alertsCreated: 0 });
            return;
        }
        const batch = firebase_1.db.batch();
        let processed = 0;
        let alertsCreated = 0;
        const now = firebase_1.Timestamp.now();
        metricsSnap.forEach((doc) => {
            const metric = doc.data();
            const saidiStatus = evalStatus(metric.saidiHours, config.saidiWarningHours, config.saidiCriticalHours);
            const saifiStatus = evalStatus(metric.saifiInterruptions, config.saifiWarning, config.saifiCritical);
            const caidiStatus = evalStatus(metric.caidiHours, config.caidiWarningHours, config.caidiCriticalHours);
            const overallStatus = combineOverall(saidiStatus, saifiStatus, caidiStatus);
            const metricRef = doc.ref;
            const update = {
                saidiStatus,
                saifiStatus,
                caidiStatus,
                overallStatus,
            };
            batch.set(metricRef, update, { merge: true });
            processed += 1;
            // Only log alerts if not MUTE and something is off
            if (config.alertingMode !== "MUTE" && overallStatus !== "OK") {
                const alertRef = firebase_1.db.collection("reliability_alerts").doc();
                const alert = {
                    orgId: metric.orgId,
                    metricId: metric.metricId,
                    regionId: metric.regionId,
                    year: metric.year,
                    saidiStatus,
                    saifiStatus,
                    caidiStatus,
                    overallStatus,
                    createdAt: now,
                    createdBy: "SYSTEM",
                    source: "THRESHOLD_ENGINE",
                };
                batch.set(alertRef, alert);
                alertsCreated += 1;
            }
        });
        await batch.commit();
        res.json({
            success: true,
            processed,
            alertsCreated,
        });
    }
    catch (error) {
        console.error("runReliabilityThresholds ERROR:", error);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});
