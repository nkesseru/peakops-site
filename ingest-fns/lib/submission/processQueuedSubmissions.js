"use strict";
// src/submission/processQueuedSubmissions.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.processQueuedSubmissions = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../firebase");
const config_1 = require("../config");
const logging_1 = require("../logging");
// Stub external submission
async function sendSubmission(item) {
    console.log("Pretending to submit filing:", item.orgId, item.incidentId, item.filingType);
    // TODO: integrate real FCC/DOE call
    return { ok: true };
}
exports.processQueuedSubmissions = (0, https_1.onRequest)(async (req, res) => {
    try {
        if (req.method !== "POST") {
            res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
            return;
        }
        const { limit = 10 } = req.body || {};
        const max = typeof limit === "number" && limit > 0 && limit <= 100 ? limit : 10;
        let query = firebase_1.db
            .collection("submission_queue")
            .where("status", "==", "PENDING")
            .orderBy("createdAt", "asc")
            .limit(max);
        const snap = await query.get();
        if (snap.empty) {
            res.json({ success: true, processed: 0, updated: 0 });
            return;
        }
        let processed = 0;
        let updated = 0;
        for (const doc of snap.docs) {
            const data = doc.data();
            const ref = doc.ref;
            processed += 1;
            // Guard malformed queue items
            if (!data.orgId || !data.incidentId || !data.filingType) {
                console.warn("Skipping malformed queue item", doc.id);
                await ref.set({
                    status: "FAILED",
                    lastError: "MALFORMED_QUEUE_ITEM",
                    updatedAt: firebase_1.Timestamp.now(),
                }, { merge: true });
                updated += 1;
                continue;
            }
            await ref.set({
                status: "IN_PROGRESS",
                updatedAt: firebase_1.Timestamp.now(),
            }, { merge: true });
            let newStatus = "SUCCESS";
            let errorMessage = null;
            try {
                const result = await sendSubmission(data);
                if (!result.ok) {
                    newStatus = "FAILED";
                    errorMessage = result.error || "Unknown error from sendSubmission";
                }
            }
            catch (err) {
                console.error("Error in sendSubmission:", err);
                newStatus = "FAILED";
                errorMessage = err?.message || "Unhandled error in sendSubmission";
            }
            const attempts = (data.attempts || 0) + 1;
            let finalStatus = newStatus;
            if (attempts >= config_1.MAX_SUBMISSION_ATTEMPTS && newStatus === "FAILED") {
                // Optional: dead-letter
                const dlRef = firebase_1.db
                    .collection("submission_dead_letters")
                    .doc(ref.id);
                await dlRef.set({
                    ...data,
                    lastError: errorMessage,
                    deadAt: firebase_1.Timestamp.now(),
                }, { merge: true });
                finalStatus = "FAILED";
            }
            await ref.set({
                status: finalStatus,
                attempts,
                lastError: errorMessage || null,
                updatedAt: firebase_1.Timestamp.now(),
            }, { merge: true });
            updated += 1;
        }
        res.json({
            success: true,
            processed,
            updated,
        });
    }
    catch (error) {
        console.error("processQueuedSubmissions ERROR:", error);
        await (0, logging_1.logSystemEvent)({
            level: "ERROR",
            subsystem: "QUEUE_WORKER",
            message: "Unhandled error in processQueuedSubmissions",
            data: { error: error?.message },
        });
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});
