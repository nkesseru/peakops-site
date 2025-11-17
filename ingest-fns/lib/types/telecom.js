"use strict";
// src/types/telecom.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeTelecomIncidentId = makeTelecomIncidentId;
// Simple deterministic ID: org + ticket
function makeTelecomIncidentId(orgId, ticketId) {
    return `${orgId}_${ticketId}`.toUpperCase();
}
