"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stormwatchMonthlyDigest = exports.stormwatchWeeklyDigest = exports.stormwatchDailyDigest = exports.stormwatchRealtimeAlerts = exports.processQueuedSubmissions = exports.telecomIngest = exports.reliabilityIngest = exports.ping = void 0;
const https_1 = require("firebase-functions/v2/https");
exports.ping = (0, https_1.onRequest)({ region: "us-west1" }, (_req, res) => {
    res.status(200).json({ ok: true, t: Date.now() });
});
var reliabilityIngest_1 = require("./reliability/reliabilityIngest");
Object.defineProperty(exports, "reliabilityIngest", { enumerable: true, get: function () { return reliabilityIngest_1.reliabilityIngest; } });
var telecomIngest_1 = require("./telecom/telecomIngest");
Object.defineProperty(exports, "telecomIngest", { enumerable: true, get: function () { return telecomIngest_1.telecomIngest; } });
var processQueuedSubmissions_1 = require("./submission/processQueuedSubmissions");
Object.defineProperty(exports, "processQueuedSubmissions", { enumerable: true, get: function () { return processQueuedSubmissions_1.processQueuedSubmissions; } });
var stormwatchTriggers_1 = require("./stormwatchTriggers");
Object.defineProperty(exports, "stormwatchRealtimeAlerts", { enumerable: true, get: function () { return stormwatchTriggers_1.stormwatchRealtimeAlerts; } });
var stormwatchDigests_1 = require("./stormwatchDigests");
Object.defineProperty(exports, "stormwatchDailyDigest", { enumerable: true, get: function () { return stormwatchDigests_1.stormwatchDailyDigest; } });
Object.defineProperty(exports, "stormwatchWeeklyDigest", { enumerable: true, get: function () { return stormwatchDigests_1.stormwatchWeeklyDigest; } });
Object.defineProperty(exports, "stormwatchMonthlyDigest", { enumerable: true, get: function () { return stormwatchDigests_1.stormwatchMonthlyDigest; } });
