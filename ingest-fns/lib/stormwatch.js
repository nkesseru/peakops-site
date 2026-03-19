"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.logStormwatchEvent = logStormwatchEvent;
exports.createSystemNotification = createSystemNotification;
exports.sendStormwatchEmail = sendStormwatchEmail;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const sendgrid = __importStar(require("@sendgrid/mail"));
// Ensure Firebase app is initialized exactly once
if (!(0, app_1.getApps)().length) {
    (0, app_1.initializeApp)();
}
const db = (0, firestore_1.getFirestore)();
async function logStormwatchEvent(event) {
    const doc = {
        timestamp: firestore_1.Timestamp.now(),
        orgId: event.orgId ?? null,
        source: event.source ?? null,
        function: event.function,
        kind: event.kind,
        rowsSent: event.rowsSent ?? null,
        accepted: event.accepted ?? null,
        rejected: event.rejected ?? null,
        processed: event.processed ?? null,
        failed: event.failed ?? null,
        errorCodes: event.errorCodes ?? [],
        errorSample: event.errorSample ?? null,
        severity: event.severity ?? "INFO",
    };
    await db.collection("stormwatch_events").add(doc);
}
async function createSystemNotification(params) {
    await db.collection("system_notifications").add({
        createdAt: firestore_1.Timestamp.now(),
        type: params.type,
        severity: params.severity,
        title: params.title,
        body: params.body,
        orgId: params.orgId ?? null,
        acknowledgedBy: [],
        acknowledgedAt: null,
        relatedEventId: params.relatedEventId ?? null,
    });
}
function initSendgrid() {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
        console.warn("[StormWatch] SENDGRID_API_KEY is not set; email disabled.");
        return null;
    }
    sendgrid.setApiKey(apiKey);
    return sendgrid;
}
async function sendStormwatchEmail(options) {
    const sg = initSendgrid();
    if (!sg)
        return;
    const toEnv = process.env.STORMWATCH_TO_EMAILS || "";
    const fromEnv = process.env.STORMWATCH_FROM_EMAIL || "stormwatch@example.com";
    const to = toEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => !!s);
    if (to.length === 0) {
        console.warn("[StormWatch] No STORMWATCH_TO_EMAILS configured; skipping.");
        return;
    }
    await sg.send({
        to,
        from: fromEnv,
        subject: options.subject,
        text: options.text,
    });
}
