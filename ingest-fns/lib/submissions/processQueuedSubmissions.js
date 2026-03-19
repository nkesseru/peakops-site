"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processQueuedSubmissions = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const stormwatch_1 = require("../stormwatch");
const db = (0, firestore_1.getFirestore)();
/**
 * submission_queue docs:
 * {
 *   orgId: "butler-pud",
 *   source: "DIRS",
 *   payload: {...},              // payload to send to FCC/DOE/etc.
 *   status: "QUEUED" | "PROCESSING" | "SUBMITTED" | "FAILED",
 *   createdAt: Timestamp,
 *   updatedAt: Timestamp
 * }
 */
exports.processQueuedSubmissions = (0, https_1.onRequest)(async (req, res) => {
    try {
        // --- Auth / method checks (same pattern as ingest) ---
        const headerKey = req.get("x-peakops-key");
        const INGEST_API_KEY = process.env.INGEST_API_KEY;
        if (!INGEST_API_KEY || headerKey !== INGEST_API_KEY) {
            res.status(401).json({ error: "UNAUTHORIZED" });
            return;
        }
        if (req.method !== "POST") {
            res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
            return;
        }
        // --- Fetch queued submissions ---
        const snap = await db
            .collection("submission_queue")
            .where("status", "==", "QUEUED")
            .limit(20)
            .get();
        if (snap.empty) {
            await (0, stormwatch_1.logStormwatchEvent)({
                function: "processQueuedSubmissions",
                kind: "QUEUE_RUN",
                processed: 0,
                failed: 0,
                severity: "INFO",
            });
            res.json({
                success: true,
                processed: 0,
                updated: 0,
            });
            return;
        }
        let processedCount = 0;
        let failedCount = 0;
        for (const doc of snap.docs) {
            const data = doc.data();
            const ref = doc.ref;
            // mark as processing
            await ref.set({
                status: "PROCESSING",
                updatedAt: firestore_1.Timestamp.now(),
            }, { merge: true });
            try {
                // TODO: replace this with real DIRS/OE-417/NORS submit call
                // For now, we just simulate success:
                const fakeResponseStatus = 500;
                if (fakeResponseStatus === 200) {
                    processedCount++;
                    await ref.set({
                        status: "SUBMITTED",
                        updatedAt: firestore_1.Timestamp.now(),
                    }, { merge: true });
                }
                else {
                    throw new Error("Simulated submission failure");
                }
            }
            catch (err) {
                failedCount++;
                await ref.set({
                    status: "FAILED",
                    errorMessage: err?.message ?? "Unknown submission error",
                    updatedAt: firestore_1.Timestamp.now(),
                }, { merge: true });
            }
        }
        // --- StormWatch logging ---
        await (0, stormwatch_1.logStormwatchEvent)({
            function: "processQueuedSubmissions",
            kind: "QUEUE_RUN",
            processed: processedCount,
            failed: failedCount,
            errorCodes: failedCount > 0 ? ["SUBMISSION_FAILED"] : [],
            errorSample: failedCount > 0
                ? "One or more queue items failed submission"
                : null,
            severity: failedCount > 0 ? "ERROR" : "INFO",
        });
        res.json({
            success: true,
            processed: processedCount,
            updated: processedCount - failedCount,
        });
    }
    catch (err) {
        console.error("[processQueuedSubmissions] Fatal error:", err);
        try {
            await (0, stormwatch_1.logStormwatchEvent)({
                function: "processQueuedSubmissions",
                kind: "QUEUE_RUN",
                processed: null,
                failed: null,
                errorCodes: ["UNEXPECTED_ERROR"],
                errorSample: err?.message ?? String(err),
                severity: "ERROR",
            });
        }
        catch (logErr) {
            console.error("[processQueuedSubmissions] Failed to log StormWatch event", logErr);
        }
        res.status(500).json({ error: "INTERNAL_ERROR" });
    }
});
