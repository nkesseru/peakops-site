"use strict";
// src/logging.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.logSystemEvent = logSystemEvent;
const firebase_1 = require("./firebase");
async function logSystemEvent(entry) {
    try {
        await firebase_1.db.collection("system_logs").add({
            ...entry,
            createdAt: firebase_1.Timestamp.now(),
        });
    }
    catch (err) {
        // Last-resort logging; don't throw from logger
        console.error("logSystemEvent failed:", err);
    }
}
