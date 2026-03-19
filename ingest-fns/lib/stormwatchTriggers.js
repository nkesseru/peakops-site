"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stormwatchRealtimeAlerts = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const stormwatch_1 = require("./stormwatch");
exports.stormwatchRealtimeAlerts = (0, firestore_1.onDocumentCreated)("stormwatch_events/{eventId}", async (event) => {
    const snap = event.data;
    if (!snap)
        return;
    const data = snap.data();
    // Only care about WARN/ERROR
    if (!data.severity || data.severity === "INFO")
        return;
    const title = data.severity === "ERROR"
        ? `StormWatch ERROR in ${data.function}`
        : `StormWatch WARN in ${data.function}`;
    const lines = [];
    lines.push(`Function: ${data.function}`);
    if (data.orgId)
        lines.push(`Org: ${data.orgId}`);
    if (data.source)
        lines.push(`Source: ${data.source}`);
    if (data.rowsSent != null) {
        lines.push(`Rows: sent=${data.rowsSent} accepted=${data.accepted ?? 0} rejected=${data.rejected ?? 0}`);
    }
    if (data.processed != null || data.failed != null) {
        lines.push(`Queue: processed=${data.processed ?? 0} failed=${data.failed ?? 0}`);
    }
    if (data.errorCodes && data.errorCodes.length > 0) {
        lines.push(`Error codes: ${data.errorCodes.join(", ")}`);
    }
    if (data.errorSample) {
        lines.push(`Sample: ${data.errorSample}`);
    }
    const body = lines.join("\n");
    // 1) Internal notification in Firestore
    await (0, stormwatch_1.createSystemNotification)({
        type: "STORMWATCH",
        severity: data.severity ?? "WARN",
        title,
        body,
        orgId: data.orgId ?? null,
        relatedEventId: event.params.eventId,
    });
    // 2) Email only on ERROR
    if (data.severity === "ERROR") {
        await (0, stormwatch_1.sendStormwatchEmail)({
            subject: `[StormWatch] ${title}`,
            text: body,
        });
    }
});
