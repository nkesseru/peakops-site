"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telecomIngest = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const stormwatch_1 = require("../stormwatch");
const db = (0, firestore_1.getFirestore)();
// Use the same env + header as reliabilityIngest
const INGEST_API_KEY = process.env.INGEST_API_KEY;
const MAX_INGEST_ROWS = Number(process.env.MAX_INGEST_ROWS ?? "2000");
// Change this if your collection name is different
const TELECOM_COLLECTION = "telecomIncidents";
function normalizeState(input) {
    if (typeof input !== "string")
        return null;
    const trimmed = input.trim().toUpperCase();
    if (trimmed.length === 2)
        return trimmed;
    // You can get fancier here if you want (map "Washington" -> "WA")
    return null;
}
function parseIsoTimestamp(value) {
    if (typeof value !== "string")
        return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        return null;
    return firestore_1.Timestamp.fromDate(d);
}
function normalizeStatus(input) {
    if (typeof input !== "string" || !input.trim())
        return "UNKNOWN";
    const s = input.trim().toUpperCase();
    if (s === "OPEN" || s === "RESOLVED" || s === "PLANNED")
        return s;
    return "UNKNOWN";
}
/**
 * Validate and normalize a single telecom row.
 */
function validateTelecomRow(raw, index) {
    // ticketId is required
    if (typeof raw.ticketId !== "string" || raw.ticketId.trim().length === 0) {
        return {
            error: "MISSING_TICKET_ID",
            message: `Row ${index}: 'ticketId' is required and must be a non-empty string`,
        };
    }
    const ticketId = raw.ticketId.trim();
    const status = normalizeStatus(raw.status);
    const outageStartTs = parseIsoTimestamp(raw.outageStart);
    if (!outageStartTs) {
        return {
            error: "INVALID_OUTAGE_START",
            message: `Row ${index}: 'outageStart' is missing or invalid ISO timestamp`,
        };
    }
    let outageEndTs = null;
    if (raw.outageEnd != null) {
        const parsedEnd = parseIsoTimestamp(raw.outageEnd);
        if (!parsedEnd) {
            return {
                error: "INVALID_OUTAGE_END",
                message: `Row ${index}: 'outageEnd' is present but not a valid ISO timestamp`,
            };
        }
        // Optional: enforce end >= start
        if (parsedEnd.toMillis() < outageStartTs.toMillis()) {
            return {
                error: "OUTAGE_END_BEFORE_START",
                message: `Row ${index}: 'outageEnd' occurs before 'outageStart'`,
            };
        }
        outageEndTs = parsedEnd;
    }
    // If status is RESOLVED but outageEnd is null, we let it slide for now.
    // You can tighten this later if you want to require outageEnd for RESOLVED.
    const state = normalizeState(raw.state);
    const county = typeof raw.county === "string" && raw.county.trim().length > 0
        ? raw.county.trim()
        : null;
    let customersAffected = null;
    if (raw.customersAffected !== undefined && raw.customersAffected !== null) {
        const n = Number(raw.customersAffected);
        if (Number.isNaN(n)) {
            return {
                error: "INVALID_CUSTOMERS",
                message: `Row ${index}: 'customersAffected' is not a number`,
            };
        }
        if (n < 0) {
            return {
                error: "NEGATIVE_CUSTOMERS",
                message: `Row ${index}: 'customersAffected' cannot be negative`,
            };
        }
        customersAffected = n;
    }
    const description = typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : null;
    return {
        ticketId,
        status,
        outageStart: outageStartTs,
        outageEnd: outageEndTs,
        state,
        county,
        customersAffected,
        description,
    };
}
// ---------- Main function ----------
exports.telecomIngest = (0, https_1.onRequest)(async (req, res) => {
    try {
        // --- Auth / method checks (same as reliabilityIngest) ---
        const headerKey = req.get("x-peakops-key");
        if (!INGEST_API_KEY || headerKey !== INGEST_API_KEY) {
            res.status(401).json({ error: "UNAUTHORIZED" });
            return;
        }
        if (req.method !== "POST") {
            res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
            return;
        }
        const { orgId, source, rows, importedBy = "SYSTEM" } = req.body || {};
        if (!orgId || typeof orgId !== "string") {
            res.status(400).json({ error: "MISSING_ORG_ID" });
            return;
        }
        if (!source || typeof source !== "string") {
            res.status(400).json({ error: "MISSING_SOURCE" });
            return;
        }
        if (!Array.isArray(rows) || rows.length === 0) {
            res.status(400).json({ error: "NO_ROWS" });
            return;
        }
        if (rows.length > MAX_INGEST_ROWS) {
            res.status(413).json({ error: "TOO_MANY_ROWS", max: MAX_INGEST_ROWS });
            return;
        }
        // --- Validate rows ---
        const accepted = [];
        const rejected = [];
        rows.forEach((raw, index) => {
            const result = validateTelecomRow(raw, index);
            if ("error" in result) {
                rejected.push(result);
            }
            else {
                accepted.push(result);
            }
        });
        // --- Write accepted incidents to Firestore ---
        const batch = db.batch();
        const now = firestore_1.Timestamp.now();
        for (const row of accepted) {
            // You can change ID strategy if needed
            const docId = `${orgId}_${row.ticketId}`;
            const ref = db.collection(TELECOM_COLLECTION).doc(docId);
            const docData = {
                orgId,
                source,
                importedBy,
                ticketId: row.ticketId,
                status: row.status,
                outageStart: row.outageStart,
                outageEnd: row.outageEnd,
                state: row.state,
                county: row.county,
                customersAffected: row.customersAffected,
                description: row.description,
                createdAt: now,
                updatedAt: now,
            };
            batch.set(ref, docData, { merge: true });
        }
        if (accepted.length > 0) {
            await batch.commit();
        }
        const rowsSent = rows.length;
        const acceptedCount = accepted.length;
        const rejectedCount = rejected.length;
        // --- StormWatch logging ---
        const errorCodes = Array.from(new Set(rejected.map((r) => r.error)));
        await (0, stormwatch_1.logStormwatchEvent)({
            orgId,
            source,
            function: "telecomIngest",
            kind: "INGEST_RUN",
            rowsSent,
            accepted: acceptedCount,
            rejected: rejectedCount,
            errorCodes,
            errorSample: rejectedCount > 0 ? rejected[0].message : null,
            severity: rejectedCount === 0
                ? "INFO"
                : rejectedCount <= 5
                    ? "WARN"
                    : "ERROR",
        });
        // --- Response ---
        res.json({
            success: true,
            accepted: acceptedCount,
            rejected: rejectedCount,
        });
    }
    catch (err) {
        console.error("[telecomIngest] Unexpected error", err);
        // Best-effort StormWatch log on hard failure
        try {
            await (0, stormwatch_1.logStormwatchEvent)({
                orgId: null,
                source: "telecomIngest",
                function: "telecomIngest",
                kind: "INGEST_RUN",
                rowsSent: null,
                accepted: null,
                rejected: null,
                errorCodes: ["UNEXPECTED_ERROR"],
                errorSample: err?.message ?? String(err),
                severity: "ERROR",
            });
        }
        catch (logErr) {
            console.error("[telecomIngest] Failed to log StormWatch event", logErr);
        }
        res.status(500).json({ error: "INTERNAL_ERROR" });
    }
});
