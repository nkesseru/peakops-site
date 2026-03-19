"use strict";
// src/types/reliability.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMetricId = makeMetricId;
function makeMetricId(orgId, regionId, year, source) {
    return `${orgId}_${regionId}_${year}_${source}`.toUpperCase();
}
