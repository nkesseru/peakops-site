"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stormwatchMonthlyDigest = exports.stormwatchWeeklyDigest = exports.stormwatchDailyDigest = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-admin/firestore");
const stormwatch_1 = require("./stormwatch");
const db = (0, firestore_1.getFirestore)();
function windowToMs(window) {
    switch (window) {
        case "daily":
            return 24 * 60 * 60 * 1000;
        case "weekly":
            return 7 * 24 * 60 * 60 * 1000;
        case "monthly":
            return 30 * 24 * 60 * 60 * 1000;
    }
}
async function buildDigest(window) {
    const now = Date.now();
    const since = firestore_1.Timestamp.fromDate(new Date(now - windowToMs(window)));
    const snap = await db
        .collection("stormwatch_events")
        .where("timestamp", ">=", since)
        .get();
    if (snap.empty) {
        return `No StormWatch events in the last ${window}. All quiet.`;
    }
    let totalRuns = 0;
    let totalAccepted = 0;
    let totalRejected = 0;
    let totalProcessed = 0;
    let totalFailed = 0;
    const errorCodeCounts = {};
    const byFunction = {};
    snap.forEach((doc) => {
        const d = doc.data();
        totalRuns += 1;
        if (d.accepted != null)
            totalAccepted += d.accepted;
        if (d.rejected != null)
            totalRejected += d.rejected;
        if (d.processed != null)
            totalProcessed += d.processed;
        if (d.failed != null)
            totalFailed += d.failed;
        const fn = d.function || "unknown";
        if (!byFunction[fn]) {
            byFunction[fn] = { runs: 0, accepted: 0, rejected: 0, failed: 0 };
        }
        byFunction[fn].runs += 1;
        if (d.accepted != null)
            byFunction[fn].accepted += d.accepted;
        if (d.rejected != null)
            byFunction[fn].rejected += d.rejected;
        if (d.failed != null)
            byFunction[fn].failed += d.failed;
        if (Array.isArray(d.errorCodes)) {
            for (const code of d.errorCodes) {
                if (!code)
                    continue;
                errorCodeCounts[code] = (errorCodeCounts[code] || 0) + 1;
            }
        }
    });
    const rejectionRate = totalAccepted + totalRejected > 0
        ? (totalRejected / (totalAccepted + totalRejected)) * 100
        : 0;
    const lines = [];
    lines.push(`StormWatch ${window.toUpperCase()} Digest`);
    lines.push(`Total ingest/queue runs: ${totalRuns}`);
    lines.push(`Rows: accepted=${totalAccepted}, rejected=${totalRejected} (rejection rate=${rejectionRate.toFixed(1)}%)`);
    lines.push(`Queue: processed=${totalProcessed}, failed=${totalFailed}`);
    lines.push("");
    lines.push("By function:");
    Object.entries(byFunction).forEach(([fn, stats]) => {
        lines.push(`  - ${fn}: runs=${stats.runs}, accepted=${stats.accepted}, rejected=${stats.rejected}, failed=${stats.failed}`);
    });
    lines.push("");
    if (Object.keys(errorCodeCounts).length > 0) {
        lines.push("Top error codes:");
        Object.entries(errorCodeCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([code, count]) => {
            lines.push(`  - ${code}: ${count}`);
        });
    }
    else {
        lines.push("No error codes recorded in this window.");
    }
    return lines.join("\n");
}
exports.stormwatchDailyDigest = (0, scheduler_1.onSchedule)("0 6 * * *", async () => {
    const text = await buildDigest("daily");
    await (0, stormwatch_1.sendStormwatchEmail)({
        subject: "[StormWatch] Daily Digest",
        text,
    });
});
exports.stormwatchWeeklyDigest = (0, scheduler_1.onSchedule)("0 7 * * MON", async () => {
    const text = await buildDigest("weekly");
    await (0, stormwatch_1.sendStormwatchEmail)({
        subject: "[StormWatch] Weekly Digest",
        text,
    });
});
exports.stormwatchMonthlyDigest = (0, scheduler_1.onSchedule)("0 8 1 * *", async () => {
    const text = await buildDigest("monthly");
    await (0, stormwatch_1.sendStormwatchEmail)({
        subject: "[StormWatch] Monthly Digest",
        text,
    });
});
