"use strict";
// src/views/rebuildJobDetailViews.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.rebuildJobDetailViews = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../firebase");
/**
 * One-time rebuild of ALL job_detail_views docs.
 * Useful after adding fields or making schema changes.
 */
exports.rebuildJobDetailViews = (0, https_1.onRequest)(async (_req, res) => {
    try {
        const jobsSnap = await firebase_1.db.collection("jobs").get();
        let rebuilt = 0;
        for (const doc of jobsSnap.docs) {
            const jobId = doc.id;
            const jobData = doc.data() || {};
            const orgId = jobData.orgId || "default-org";
            const locationId = jobData.locationId || null;
            // ---- LOAD LOCATION SNAPSHOT ----
            let locationName = null;
            let locationAddress = null;
            let locationCity = null;
            let locationState = null;
            let locationLat = null;
            let locationLng = null;
            if (locationId) {
                const locSnap = await firebase_1.db.collection("locations").doc(locationId).get();
                if (locSnap.exists) {
                    const loc = locSnap.data() || {};
                    locationName = loc.name || null;
                    locationAddress = loc.address || null;
                    locationCity = loc.city || null;
                    locationState = loc.state || null;
                    locationLat = typeof loc.lat === "number" ? loc.lat : null;
                    locationLng = typeof loc.lng === "number" ? loc.lng : null;
                }
            }
            // ---- BUILD VIEW DOC ----
            const view = {
                jobId,
                orgId,
                status: jobData.status || null,
                workOrderId: jobData.workOrderId || null,
                ptpId: jobData.ptpId || null,
                scheduledStart: jobData.scheduledStart || null,
                scheduledEnd: jobData.scheduledEnd || null,
                crewAssigned: jobData.crewAssigned || null,
                locationId,
                locationName,
                locationAddress,
                locationCity,
                locationState,
                locationLat,
                locationLng,
                lastInspectionAt: jobData.lastInspectionAt || null,
                openIssuesCount: typeof jobData.openIssuesCount === "number"
                    ? jobData.openIssuesCount
                    : null,
                notesPreview: jobData.notesPreview || null,
                updatedAt: firebase_1.Timestamp.now(),
            };
            await firebase_1.db
                .collection("job_detail_views")
                .doc(jobId)
                .set(view, { merge: true });
            rebuilt++;
        }
        res.json({
            success: true,
            rebuilt,
        });
    }
    catch (err) {
        console.error("rebuildJobDetailViews ERROR:", err);
        res.status(500).json({
            error: "SERVER_ERROR",
            message: err?.message,
        });
    }
});
